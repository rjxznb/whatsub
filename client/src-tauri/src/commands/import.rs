use crate::commands::library::{
    library_delete, library_get, library_upsert, LibraryEntry, LibrarySource, LibraryStatus,
};
use crate::core::ids;
use crate::core::paths;
use crate::core::progress::{emit, PipelineEvent};
use crate::error::{AppError, AppResult};
use crate::pipeline::{ffmpeg, whisper, ytdlp};
use chrono::Utc;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tokio_util::sync::CancellationToken;

/// Per-import cancellation registry. Each in-flight import_video registers
/// its CancellationToken keyed by video_id; the `cancel_import` invoke
/// looks it up and triggers `.cancel()`, which propagates into the
/// run_sidecar event loops and kills the underlying yt-dlp / ffmpeg /
/// whisper child process.
///
/// Stored in Tauri's `.manage()`. Mutex-only (not async) because all
/// access points hold the lock for a single map operation.
#[derive(Default)]
pub struct ImportState {
    pub active: Mutex<HashMap<String, CancellationToken>>,
}

impl ImportState {
    fn register(&self, video_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        if let Ok(mut g) = self.active.lock() {
            g.insert(video_id.to_string(), token.clone());
        }
        token
    }

    fn unregister(&self, video_id: &str) {
        if let Ok(mut g) = self.active.lock() {
            g.remove(video_id);
        }
    }

    fn cancel(&self, video_id: &str) -> bool {
        if let Ok(g) = self.active.lock() {
            if let Some(token) = g.get(video_id) {
                token.cancel();
                return true;
            }
        }
        false
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

#[tauri::command]
pub async fn import_video(
    app: AppHandle,
    state: State<'_, ImportState>,
    req: ImportRequest,
) -> AppResult<ImportResult> {
    let video_id = match req.source_kind.as_str() {
        "url" => ids::id_from_youtube_url(&req.source_value)
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
    let cancel = state.register(&video_id);

    let result = run_import(&app, &video_id, &out_dir, &req, &cancel).await;

    // Always unregister regardless of outcome — keeping a cancelled
    // token in the map would make later imports of the same video_id
    // start "already cancelled".
    state.unregister(&video_id);

    // On cancel: best-effort cleanup so the user's next import of the
    // same URL starts from scratch (per the design decision — clean
    // half-downloads rather than support resume).
    if matches!(result, Err(AppError::Cancelled)) {
        cleanup_partial(&video_id, &out_dir);
    }

    result
}

/// Inner pipeline. Split out so the outer `import_video` can do
/// cleanup + unregister regardless of which step errored.
async fn run_import(
    app: &AppHandle,
    video_id: &str,
    out_dir: &std::path::Path,
    req: &ImportRequest,
    cancel: &CancellationToken,
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

    let (video_path, thumb_path, title, duration_sec) = match req.source_kind.as_str() {
        "url" => {
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
            (
                PathBuf::from(r.video_path),
                PathBuf::from(r.thumb_path),
                r.title,
                r.duration_sec,
            )
        }
        "local" => {
            let dest = out_dir.join("source.mp4");
            std::fs::copy(&req.source_value, &dest)?;
            let thumb = out_dir.join("thumb.jpg");
            ffmpeg::extract_thumbnail(app, &dest, &thumb, video_id, Some(cancel)).await?;
            let title = std::path::Path::new(&req.source_value)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Untitled")
                .to_string();
            (dest, thumb, title, 0.0)
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
fn cleanup_partial(video_id: &str, out_dir: &std::path::Path) {
    let _ = std::fs::remove_dir_all(out_dir);
    let _ = library_delete(video_id.to_string());
}

/// Cancel an in-flight import. Looks up the registered CancellationToken
/// by video_id and triggers `.cancel()` — this propagates into the
/// run_sidecar event loop, which kills the child process. The
/// `import_video` task then sees `AppError::Cancelled`, runs cleanup,
/// unregisters itself, and returns.
///
/// Returns Ok even when video_id isn't in the registry (the import
/// already completed / failed / wasn't started), so the UI can treat
/// "cancel" as idempotent.
#[tauri::command]
pub async fn cancel_import(state: State<'_, ImportState>, video_id: String) -> AppResult<()> {
    state.cancel(&video_id);
    Ok(())
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
/// Not cancellable through ImportState (doesn't register a token) —
/// retranscribe is typically fast and the user can just wait. If we ever
/// add cancellation here, it'd plug in the same way `import_video` does.
#[tauri::command]
pub async fn retranscribe_video(
    app: AppHandle,
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

    emit(
        &app,
        PipelineEvent::Started {
            video_id: video_id.clone(),
            source_kind: None,
            source_value: None,
            background: false,
        },
    );

    // Flip the library entry back to Analyzing + clear last_error so the
    // Library page card stops showing "Failed" while the retry runs. If the
    // entry got deleted somehow, just continue — transcript output still
    // lands in the right directory and the user can re-import to re-list it.
    if let Some(mut entry) = library_get(video_id.clone())? {
        entry.status = LibraryStatus::Analyzing;
        entry.last_error = None;
        library_upsert(entry)?;
    }

    emit(
        &app,
        PipelineEvent::ExtractingAudio {
            video_id: video_id.clone(),
        },
    );
    let audio_path = out_dir.join("audio.wav");
    ffmpeg::extract_audio_wav(&app, &video_path, &audio_path, &video_id, None).await?;

    let srt_path =
        whisper::transcribe(&app, &audio_path, &out_dir, &whisper_model, &video_id, None).await?;
    let dur_sec = std::fs::metadata(&audio_path)
        .map(|m| m.len() as f64 / (16000.0 * 2.0))
        .unwrap_or(0.0);

    emit(
        &app,
        PipelineEvent::Transcribed {
            video_id: video_id.clone(),
            srt_path: srt_path.to_string_lossy().to_string(),
            duration_sec: dur_sec,
        },
    );

    Ok(ImportResult {
        video_id,
        srt_path: srt_path.to_string_lossy().to_string(),
        duration_sec: dur_sec,
    })
}

