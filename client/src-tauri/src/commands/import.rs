use crate::commands::analysis_store;
use crate::commands::library::{
    library_delete, library_get, library_upsert, LibraryEntry, LibrarySource, LibraryStatus,
};
use crate::core::ids;
use crate::core::paths;
use crate::core::progress::{emit, PipelineEvent, WaitingResource};
use crate::error::{AppError, AppResult};
use crate::pipeline::scheduler::{
    JobPriority, PipelineScheduler, ScheduledResource,
};
use crate::pipeline::{ffmpeg, spawn, whisper, ytdlp};
use chrono::Utc;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// Per-import cancellation registry. Each in-flight import_video registers
/// its CancellationToken keyed by video_id; the `cancel_import` invoke
/// looks it up and triggers `.cancel()`, which propagates into the
/// run_sidecar event loops and kills the underlying yt-dlp / ffmpeg /
/// whisper child process.
///
/// Stored in Tauri's `.manage()`. Mutex-only (not async) because all
/// access points hold the lock for a single map operation.
pub struct ImportState {
    active: Mutex<HashMap<String, ActiveImport>>,
    next_job_id: AtomicU64,
}

struct ActiveImport {
    job_id: u64,
    token: CancellationToken,
    cleanup_kind: ImportCleanupKind,
    done: watch::Receiver<Option<Result<(), ImportCompletionFailure>>>,
}

struct ImportRegistration {
    job_id: u64,
    token: CancellationToken,
    done_tx: watch::Sender<Option<Result<(), ImportCompletionFailure>>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ImportCleanupKind {
    PartialImport,
    Retranscription,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ImportCompletionFailure {
    shutdown_error: Option<String>,
    cleanup_error: Option<String>,
}

impl ImportCompletionFailure {
    fn message(&self) -> String {
        [
            self.shutdown_error
                .as_ref()
                .map(|error| format!("process shutdown not confirmed: {error}")),
            self.cleanup_error
                .as_ref()
                .map(|error| format!("cleanup failed: {error}")),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("; ")
    }
}

struct CancellationWaiter {
    job_id: u64,
    cleanup_kind: ImportCleanupKind,
    done: watch::Receiver<Option<Result<(), ImportCompletionFailure>>>,
}

impl Default for ImportState {
    fn default() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
            next_job_id: AtomicU64::new(0),
        }
    }
}

impl ImportState {
    fn register(
        &self,
        video_id: &str,
        cleanup_kind: ImportCleanupKind,
    ) -> AppResult<ImportRegistration> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::Other("import registry poisoned".to_string()))?;
        if active.contains_key(video_id) {
            return Err(AppError::Other(format!(
                "import already running: {video_id}"
            )));
        }

        let job_id = self.next_job_id.fetch_add(1, Ordering::Relaxed) + 1;
        let token = CancellationToken::new();
        let (done_tx, done) = watch::channel(None);
        active.insert(
            video_id.to_string(),
            ActiveImport {
                job_id,
                token: token.clone(),
                cleanup_kind,
                done,
            },
        );
        Ok(ImportRegistration {
            job_id,
            token,
            done_tx,
        })
    }

    fn cancel_and_waiter(&self, video_id: &str) -> Option<CancellationWaiter> {
        let active = self.active.lock().ok()?;
        let job = active.get(video_id)?;
        job.token.cancel();
        Some(CancellationWaiter {
            job_id: job.job_id,
            cleanup_kind: job.cleanup_kind,
            done: job.done.clone(),
        })
    }

    fn unregister_if_same(&self, video_id: &str, job_id: u64) -> bool {
        let Ok(mut active) = self.active.lock() else {
            return false;
        };
        if active.get(video_id).is_some_and(|job| job.job_id == job_id) {
            active.remove(video_id);
            true
        } else {
            false
        }
    }

    fn finish(
        &self,
        video_id: &str,
        registration: ImportRegistration,
        completion: Result<(), ImportCompletionFailure>,
    ) {
        let cleanup_succeeded = completion.is_ok();
        if cleanup_succeeded {
            self.unregister_if_same(video_id, registration.job_id);
        }
        let _ = registration.done_tx.send(Some(completion));
    }
}

async fn wait_for_completion_result(
    done: &mut watch::Receiver<Option<Result<(), ImportCompletionFailure>>>,
) -> Result<(), ImportCompletionFailure> {
    loop {
        if let Some(result) = done.borrow().clone() {
            return result;
        }
        if done.changed().await.is_err() {
            return Err(ImportCompletionFailure {
                shutdown_error: Some("import ended without cleanup confirmation".to_string()),
                cleanup_error: None,
            });
        }
    }
}

fn cancellation_completion<T>(
    result: &AppResult<T>,
    cancellation_requested: bool,
    cleanup_result: &AppResult<()>,
) -> Result<(), ImportCompletionFailure> {
    if !cancellation_requested {
        return Ok(());
    }
    let shutdown_error = result
        .as_ref()
        .err()
        .filter(|error| spawn::is_sidecar_shutdown_unconfirmed(error))
        .map(ToString::to_string);
    let cleanup_error = cleanup_result.as_ref().err().map(ToString::to_string);
    if shutdown_error.is_none() && cleanup_error.is_none() {
        Ok(())
    } else {
        Err(ImportCompletionFailure {
            shutdown_error,
            cleanup_error,
        })
    }
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub source_kind: String, // "local" | "url"
    pub source_value: String,
    pub whisper_model: String,
    /// One of "low" / "standard" / "high" / "best" — see
    /// `pipeline::ytdlp::yt_dlp_format`. Ignored for local imports.
    /// Defaults to "standard" (720p) when missing for backward compat.
    #[serde(default = "default_quality")]
    pub quality: String,
    /// Translation style. Stored on the library entry; used by the Player
    /// at analysis time. Optional — missing falls back to settings default.
    #[serde(default)]
    pub analysis_style: Option<String>,
    /// Background mode: relaxes yt-dlp retry budget from ~10s to ~3min,
    /// and is the signal used by the queue widget to keep the import
    /// running after the modal closes. Defaults to false (foreground)
    /// for back-compat with callers that don't set the field.
    #[serde(default)]
    pub background: bool,
}

fn default_quality() -> String {
    "standard".into()
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub video_id: String,
    pub srt_path: String,
    pub duration_sec: f64,
}

fn import_priority(background: bool) -> JobPriority {
    JobPriority::from_background(background)
}

fn waiting_resource(resource: ScheduledResource) -> WaitingResource {
    match resource {
        ScheduledResource::Download => WaitingResource::Download,
        ScheduledResource::Compute => WaitingResource::Compute,
    }
}

#[tauri::command]
pub async fn import_video(
    app: AppHandle,
    state: State<'_, ImportState>,
    scheduler: State<'_, PipelineScheduler>,
    req: ImportRequest,
) -> AppResult<ImportResult> {
    let video_id = match req.source_kind.as_str() {
        "url" => ids::id_from_youtube_url(&req.source_value)
            .or_else(|| ids::id_from_bilibili_url(&req.source_value))
            .unwrap_or_else(|| ids::id_from_url_fallback(&req.source_value)),
        "local" => ids::id_from_file_hash(std::path::Path::new(&req.source_value))?,
        _ => {
            return Err(AppError::InvalidInput(format!(
                "source_kind: {}",
                req.source_kind
            )))
        }
    };

    let out_dir = paths::video_dir(&video_id)?;
    std::fs::create_dir_all(&out_dir)?;

    // Register cancellation token BEFORE emitting Started so a fast ✕
    // click can land immediately.
    let registration = state.register(&video_id, ImportCleanupKind::PartialImport)?;

    let result = run_import(
        &app,
        &video_id,
        &out_dir,
        &req,
        &registration.token,
        scheduler.inner(),
    )
    .await;

    let cancellation_requested =
        registration.token.is_cancelled() || matches!(result, Err(AppError::Cancelled));
    let cleanup_result = if cancellation_requested {
        cleanup_partial(&video_id)
    } else {
        Ok(())
    };

    // Signal completion only after the exact child has exited and every
    // cleanup operation has either succeeded or produced an honest error.
    let completion = cancellation_completion(&result, cancellation_requested, &cleanup_result);
    state.finish(&video_id, registration, completion.clone());
    if let Err(failure) = completion {
        return Err(AppError::Other(failure.message()));
    }
    if cancellation_requested {
        Err(AppError::Cancelled)
    } else {
        result
    }
}

/// Inner pipeline. Split out so the outer `import_video` can do
/// cleanup + unregister regardless of which step errored.
async fn run_import(
    app: &AppHandle,
    video_id: &str,
    out_dir: &std::path::Path,
    req: &ImportRequest,
    cancel: &CancellationToken,
    scheduler: &PipelineScheduler,
) -> AppResult<ImportResult> {
    emit(
        app,
        PipelineEvent::Started {
            video_id: video_id.to_string(),
            source_kind: Some(req.source_kind.clone()),
            source_value: Some(req.source_value.clone()),
            background: req.background,
        },
    );

    let priority = import_priority(req.background);
    let compute_permit;
    let (video_path, thumb_path, title, duration_sec) = match req.source_kind.as_str() {
        "url" => {
            let resource = ScheduledResource::Download;
            let download_permit = scheduler
                .acquire(resource, priority, cancel, || {
                    emit(
                        app,
                        PipelineEvent::Waiting {
                            video_id: video_id.to_string(),
                            resource: waiting_resource(resource),
                        },
                    );
                })
                .await?;
            let r = ytdlp::download(
                app,
                &req.source_value,
                out_dir,
                video_id,
                &req.quality,
                req.background,
                Some(cancel),
            )
            .await?;
            drop(download_permit);

            let resource = ScheduledResource::Compute;
            compute_permit = scheduler
                .acquire(resource, priority, cancel, || {
                    emit(
                        app,
                        PipelineEvent::Waiting {
                            video_id: video_id.to_string(),
                            resource: waiting_resource(resource),
                        },
                    );
                })
                .await?;
            (
                PathBuf::from(r.video_path),
                PathBuf::from(r.thumb_path),
                r.title,
                r.duration_sec,
            )
        }
        "local" => {
            let resource = ScheduledResource::Compute;
            compute_permit = scheduler
                .acquire(resource, priority, cancel, || {
                    emit(
                        app,
                        PipelineEvent::Waiting {
                            video_id: video_id.to_string(),
                            resource: waiting_resource(resource),
                        },
                    );
                })
                .await?;
            let dest = out_dir.join("source.mp4");
            // Copy as-is when already web-playable (H.264 + AAC/MP3); otherwise
            // transcode — WebView2 can't decode AC-3/DTS audio (common in MKV →
            // video plays but no sound) or HEVC/VP9/AV1 video.
            ffmpeg::ensure_web_playable_mp4(
                app,
                std::path::Path::new(&req.source_value),
                &dest,
                video_id,
                Some(cancel),
            )
            .await?;
            let thumb = out_dir.join("thumb.jpg");
            ffmpeg::extract_thumbnail(app, &dest, &thumb, video_id, Some(cancel)).await?;
            // Probe the duration (yt-dlp gives URL imports this for free; local
            // files have none, so the card would render shorter without a
            // duration line). Best-effort — 0.0 just hides the line.
            let dur = ffmpeg::probe_duration_secs(app, &dest).await;
            let title = std::path::Path::new(&req.source_value)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Untitled")
                .to_string();
            (dest, thumb, title, dur)
        }
        _ => unreachable!(),
    };

    let entry = LibraryEntry {
        id: video_id.to_string(),
        title,
        source: match req.source_kind.as_str() {
            "url" => LibrarySource::Url {
                url: req.source_value.clone(),
            },
            _ => LibrarySource::Local {
                original_path: req.source_value.clone(),
            },
        },
        duration_sec,
        thumbnail_path: thumb_path.to_string_lossy().to_string(),
        created_at: Utc::now().to_rfc3339(),
        status: LibraryStatus::Analyzing,
        last_error: None,
        video_dir: Some(out_dir.to_string_lossy().to_string()),
        analysis_style: req.analysis_style.clone(),
        synced_at: None,
        sync_error: None,
    };
    library_upsert(entry)?;

    emit(
        app,
        PipelineEvent::ExtractingAudio {
            video_id: video_id.to_string(),
        },
    );
    let audio_path = out_dir.join("audio.wav");
    ffmpeg::extract_audio_wav(app, &video_path, &audio_path, video_id, Some(cancel)).await?;

    let srt_path =
        whisper::transcribe(app, &audio_path, out_dir, &req.whisper_model, video_id, Some(cancel))
            .await?;
    let dur_sec = std::fs::metadata(&audio_path)
        .map(|m| m.len() as f64 / (16000.0 * 2.0))
        .unwrap_or(0.0);

    drop(compute_permit);

    emit(
        app,
        PipelineEvent::Transcribed {
            video_id: video_id.to_string(),
            srt_path: srt_path.to_string_lossy().to_string(),
            duration_sec: dur_sec,
        },
    );

    Ok(ImportResult {
        video_id: video_id.to_string(),
        srt_path: srt_path.to_string_lossy().to_string(),
        duration_sec: dur_sec,
    })
}

/// Wipe the video's working dir + remove its library entry. Called on
/// cancel so the user's next attempt doesn't reuse a truncated source.mp4
/// or see a stale "Analyzing..." card on the Library page.
fn cleanup_partial(video_id: &str) -> AppResult<()> {
    // library_delete holds the analysis-store destructive boundary across the
    // index update and directory removal.  A retry cannot begin in a gap
    // between lease revocation and cleanup.
    library_delete(video_id.to_string())
        .map_err(|error| AppError::Other(format!("cancel cleanup failed: {error}")))
}

fn retry_cancel_cleanup(kind: ImportCleanupKind, video_id: &str) -> AppResult<()> {
    match kind {
        ImportCleanupKind::PartialImport => cleanup_partial(video_id),
        ImportCleanupKind::Retranscription => analysis_store::revoke_analysis_sessions(video_id),
    }
}

fn recover_failed_cleanup(
    state: &ImportState,
    video_id: &str,
    waiter: &CancellationWaiter,
    failure: ImportCompletionFailure,
) -> AppResult<()> {
    recover_failed_cleanup_with(state, video_id, waiter, failure, || {
        retry_cancel_cleanup(waiter.cleanup_kind, video_id)
    })
}

fn recover_failed_cleanup_with<F>(
    state: &ImportState,
    video_id: &str,
    waiter: &CancellationWaiter,
    failure: ImportCompletionFailure,
    cleanup: F,
) -> AppResult<()>
where
    F: FnOnce() -> AppResult<()>,
{
    if failure.shutdown_error.is_some() {
        // Without an exact exit confirmation it is unsafe to release the
        // same-video fence.  A process restart is the only trustworthy reset.
        return Err(AppError::Other(failure.message()));
    }

    // Hold the registry lock from the exact-job check through cleanup and
    // removal. Concurrent cancel callers therefore cannot both clean, and a
    // replacement cannot register between the check and destructive cleanup.
    let mut active = state
        .active
        .lock()
        .map_err(|_| AppError::Other("import registry poisoned".to_string()))?;
    if !active
        .get(video_id)
        .is_some_and(|job| job.job_id == waiter.job_id)
    {
        // Another waiter already recovered this exact job. Never let this
        // stale waiter touch a replacement registered under the same video id.
        return Ok(());
    }

    if let Err(retry_error) = cleanup() {
        return Err(AppError::Other(format!(
            "{}; cleanup retry failed: {retry_error}",
            failure.message()
        )));
    }
    active.remove(video_id);
    Ok(())
}

/// Cancel an in-flight import and wait until its child process has exited
/// and cancellation cleanup has finished. A same-video retry therefore
/// cannot race stale cleanup from the cancelled task.
///
/// Returns Ok even when video_id isn't in the registry (the import
/// already completed / failed / wasn't started), so the UI can treat
/// "cancel" as idempotent.
#[tauri::command]
pub async fn cancel_import(state: State<'_, ImportState>, video_id: String) -> AppResult<()> {
    let Some(mut waiter) = state.cancel_and_waiter(&video_id) else {
        return Ok(());
    };

    let completion = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        wait_for_completion_result(&mut waiter.done),
    )
    .await
    .map_err(|_| {
        AppError::Other("cancel timed out while waiting for import cleanup".to_string())
    })?;
    match completion {
        Ok(()) => Ok(()),
        Err(failure) => recover_failed_cleanup(&state, &video_id, &waiter, failure),
    }
}

/// Re-run audio extraction + whisper transcription for an already-downloaded
/// video, without re-downloading. Used by the player page when whisper failed
/// during the original import (the source.mp4 is on disk but transcript.srt
/// isn't), so the user can retry without throwing away the download.
///
/// Emits the same Started → ExtractingAudio → Transcribing → Transcribed
/// pipeline events as `import_video` so the existing progress listeners on
/// the frontend (ProgressBanner / store) just work.
///
/// Uses the same completion-aware cancellation registry as `import_video`.
#[tauri::command]
pub async fn retranscribe_video(
    app: AppHandle,
    state: State<'_, ImportState>,
    video_id: String,
    whisper_model: String,
) -> AppResult<ImportResult> {
    let out_dir = paths::video_dir(&video_id)?;
    let video_path = out_dir.join("source.mp4");
    if !video_path.exists() {
        return Err(AppError::NotFound(format!(
            "source.mp4 not found in {}",
            out_dir.display()
        )));
    }

    // Register a cancel token (same registry + `cancel_import` command as
    // import_video) so the foreground 「前台解析」 can kill the ffmpeg /
    // whisper child process if the user leaves the Player page mid-run.
    let registration = state.register(&video_id, ImportCleanupKind::Retranscription)?;
    let result = run_retranscribe(
        &app,
        &video_id,
        &out_dir,
        &video_path,
        &whisper_model,
        &registration.token,
    )
    .await;
    let cancellation_requested =
        registration.token.is_cancelled() || matches!(result, Err(AppError::Cancelled));
    let cleanup_result = if cancellation_requested {
        analysis_store::revoke_analysis_sessions(&video_id)
    } else {
        Ok(())
    };
    let completion = cancellation_completion(&result, cancellation_requested, &cleanup_result);
    state.finish(&video_id, registration, completion.clone());
    if let Err(failure) = completion {
        return Err(AppError::Other(failure.message()));
    }
    if cancellation_requested {
        Err(AppError::Cancelled)
    } else {
        result
    }
}

/// Inner re-transcribe pipeline (extract audio → whisper). Split out so the
/// outer command always unregisters its cancel token regardless of outcome.
/// Unlike `run_import`, a cancel here does NOT delete source.mp4 — the user
/// is just aborting a re-analyze, not the original import.
async fn run_retranscribe(
    app: &AppHandle,
    video_id: &str,
    out_dir: &std::path::Path,
    video_path: &std::path::Path,
    whisper_model: &str,
    cancel: &CancellationToken,
) -> AppResult<ImportResult> {
    emit(
        app,
        PipelineEvent::Started {
            video_id: video_id.to_string(),
            source_kind: None,
            source_value: None,
            background: false,
        },
    );

    // Flip the library entry back to Analyzing + clear last_error so the
    // Library page card stops showing "Failed" while the retry runs. If the
    // entry got deleted somehow, just continue — transcript output still
    // lands in the right directory and the user can re-import to re-list it.
    if let Some(mut entry) = library_get(video_id.to_string())? {
        entry.status = LibraryStatus::Analyzing;
        entry.last_error = None;
        library_upsert(entry)?;
    }

    emit(
        app,
        PipelineEvent::ExtractingAudio {
            video_id: video_id.to_string(),
        },
    );
    let audio_path = out_dir.join("audio.wav");
    ffmpeg::extract_audio_wav(app, video_path, &audio_path, video_id, Some(cancel)).await?;

    let srt_path =
        whisper::transcribe(app, &audio_path, out_dir, whisper_model, video_id, Some(cancel))
            .await?;
    let dur_sec = std::fs::metadata(&audio_path)
        .map(|m| m.len() as f64 / (16000.0 * 2.0))
        .unwrap_or(0.0);

    emit(
        app,
        PipelineEvent::Transcribed {
            video_id: video_id.to_string(),
            srt_path: srt_path.to_string_lossy().to_string(),
            duration_sec: dur_sec,
        },
    );

    Ok(ImportResult {
        video_id: video_id.to_string(),
        srt_path: srt_path.to_string_lossy().to_string(),
        duration_sec: dur_sec,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn foreground_and_background_imports_map_to_scheduler_priority() {
        assert_eq!(import_priority(false), JobPriority::Foreground);
        assert_eq!(import_priority(true), JobPriority::Background);
    }

    #[test]
    fn scheduler_resources_map_to_stable_waiting_events() {
        assert!(matches!(
            waiting_resource(ScheduledResource::Download),
            WaitingResource::Download
        ));
        assert!(matches!(
            waiting_resource(ScheduledResource::Compute),
            WaitingResource::Compute
        ));
    }

    #[tokio::test]
    async fn same_video_registration_is_rejected_until_the_old_job_finishes() {
        let state = ImportState::default();
        let first = state
            .register("v1", ImportCleanupKind::PartialImport)
            .unwrap();

        assert!(state
            .register("v1", ImportCleanupKind::PartialImport)
            .is_err());

        state.finish("v1", first, Ok(()));
        assert!(state
            .register("v1", ImportCleanupKind::PartialImport)
            .is_ok());
    }

    #[tokio::test]
    async fn cancellation_waiter_does_not_finish_before_job_cleanup() {
        let state = ImportState::default();
        let registration = state
            .register("v1", ImportCleanupKind::PartialImport)
            .unwrap();
        let mut waiter = state.cancel_and_waiter("v1").unwrap();

        assert!(registration.token.is_cancelled());
        assert!(tokio::time::timeout(
            Duration::from_millis(20),
            wait_for_completion_result(&mut waiter.done),
        )
        .await
        .is_err());

        state.finish("v1", registration, Ok(()));
        tokio::time::timeout(
            Duration::from_millis(100),
            wait_for_completion_result(&mut waiter.done),
        )
        .await
        .unwrap()
        .unwrap();
    }

    #[tokio::test]
    async fn failed_cleanup_is_reported_and_keeps_the_job_registered() {
        let state = ImportState::default();
        let registration = state
            .register("v1", ImportCleanupKind::PartialImport)
            .unwrap();
        let mut waiter = state.cancel_and_waiter("v1").unwrap();

        state.finish(
            "v1",
            registration,
            Err(ImportCompletionFailure {
                shutdown_error: None,
                cleanup_error: Some("remove failed".to_string()),
            }),
        );

        let error = wait_for_completion_result(&mut waiter.done)
            .await
            .unwrap_err();
        assert!(error.message().contains("remove failed"));
        assert!(state
            .register("v1", ImportCleanupKind::PartialImport)
            .is_err());
    }

    #[tokio::test]
    async fn failed_cleanup_can_be_retried_before_releasing_the_job_fence() {
        let state = ImportState::default();
        let registration = state
            .register("v1", ImportCleanupKind::Retranscription)
            .unwrap();
        let mut waiter = state.cancel_and_waiter("v1").unwrap();
        state.finish(
            "v1",
            registration,
            Err(ImportCompletionFailure {
                shutdown_error: None,
                cleanup_error: Some("first cleanup failed".to_string()),
            }),
        );

        let failure = wait_for_completion_result(&mut waiter.done)
            .await
            .unwrap_err();
        recover_failed_cleanup_with(&state, "v1", &waiter, failure, || Ok(())).unwrap();

        assert!(state
            .register("v1", ImportCleanupKind::PartialImport)
            .is_ok());
    }

    #[tokio::test]
    async fn stale_cleanup_waiter_never_touches_a_replacement_job() {
        let state = ImportState::default();
        let registration = state
            .register("v1", ImportCleanupKind::PartialImport)
            .unwrap();
        let mut first_waiter = state.cancel_and_waiter("v1").unwrap();
        let mut second_waiter = state.cancel_and_waiter("v1").unwrap();
        state.finish(
            "v1",
            registration,
            Err(ImportCompletionFailure {
                shutdown_error: None,
                cleanup_error: Some("first cleanup failed".to_string()),
            }),
        );

        let first_failure = wait_for_completion_result(&mut first_waiter.done)
            .await
            .unwrap_err();
        let cleanup_calls = std::cell::Cell::new(0usize);
        recover_failed_cleanup_with(&state, "v1", &first_waiter, first_failure, || {
            cleanup_calls.set(cleanup_calls.get() + 1);
            Ok(())
        })
        .unwrap();

        let replacement = state
            .register("v1", ImportCleanupKind::Retranscription)
            .unwrap();
        let second_failure = wait_for_completion_result(&mut second_waiter.done)
            .await
            .unwrap_err();
        recover_failed_cleanup_with(&state, "v1", &second_waiter, second_failure, || {
            cleanup_calls.set(cleanup_calls.get() + 1);
            Ok(())
        })
        .unwrap();

        assert_eq!(cleanup_calls.get(), 1);
        assert!(state
            .register("v1", ImportCleanupKind::PartialImport)
            .is_err());
        assert_eq!(state.cancel_and_waiter("v1").unwrap().job_id, replacement.job_id);
    }

    #[test]
    fn unconfirmed_child_exit_is_never_reported_as_cancelled_success() {
        let result: AppResult<()> = Err(AppError::SidecarShutdownUnconfirmed(
            "test timeout".to_string(),
        ));
        let cleanup: AppResult<()> = Ok(());

        let failure = cancellation_completion(&result, true, &cleanup).unwrap_err();

        assert!(failure
            .shutdown_error
            .as_deref()
            .is_some_and(|error| error.contains("test timeout")));
    }

    #[tokio::test]
    async fn stale_unregister_cannot_remove_a_replacement_job() {
        let state = ImportState::default();
        let old = state
            .register("v1", ImportCleanupKind::PartialImport)
            .unwrap();
        let old_job_id = old.job_id;
        state.finish("v1", old, Ok(()));

        let replacement = state
            .register("v1", ImportCleanupKind::PartialImport)
            .unwrap();
        assert!(!state.unregister_if_same("v1", old_job_id));
        assert!(state.cancel_and_waiter("v1").is_some());
        assert!(replacement.token.is_cancelled());
    }

    #[tokio::test]
    async fn cancelling_an_absent_job_is_idempotent() {
        let state = ImportState::default();
        assert!(state.cancel_and_waiter("missing").is_none());
    }
}
