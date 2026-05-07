use crate::commands::library::{library_get, library_upsert, LibraryEntry, LibrarySource, LibraryStatus};
use crate::core::ids;
use crate::core::paths;
use crate::core::progress::{emit, PipelineEvent};
use crate::error::{AppError, AppResult};
use crate::pipeline::{ffmpeg, whisper, ytdlp};
use chrono::Utc;
use std::path::PathBuf;
use tauri::AppHandle;

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
    /// Translation style: "colloquial" / "playful" / "cinematic" / "formal" /
    /// "literary". Stored on the library entry; used by the Player at analysis
    /// time. Optional — missing falls back to settings default.
    #[serde(default)]
    pub analysis_style: Option<String>,
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
pub async fn import_video(app: AppHandle, req: ImportRequest) -> AppResult<ImportResult> {
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

    emit(
        &app,
        PipelineEvent::Started {
            video_id: video_id.clone(),
        },
    );

    let (video_path, thumb_path, title, duration_sec) = match req.source_kind.as_str() {
        "url" => {
            let r = ytdlp::download(&app, &req.source_value, &out_dir, &video_id, &req.quality).await?;
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
            ffmpeg::extract_thumbnail(&app, &dest, &thumb, &video_id).await?;
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
        id: video_id.clone(),
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
    };
    library_upsert(entry)?;

    emit(
        &app,
        PipelineEvent::ExtractingAudio {
            video_id: video_id.clone(),
        },
    );
    let audio_path = out_dir.join("audio.wav");
    ffmpeg::extract_audio_wav(&app, &video_path, &audio_path, &video_id).await?;

    let srt_path =
        whisper::transcribe(&app, &audio_path, &out_dir, &req.whisper_model, &video_id).await?;
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

/// Re-run audio extraction + whisper transcription for an already-downloaded
/// video, without re-downloading. Used by the player page when whisper failed
/// during the original import (the source.mp4 is on disk but transcript.srt
/// isn't), so the user can retry without throwing away the download.
///
/// Emits the same Started → ExtractingAudio → Transcribing → Transcribed
/// pipeline events as `import_video` so the existing progress listeners on
/// the frontend (ProgressBanner / store) just work.
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
    ffmpeg::extract_audio_wav(&app, &video_path, &audio_path, &video_id).await?;

    let srt_path =
        whisper::transcribe(&app, &audio_path, &out_dir, &whisper_model, &video_id).await?;
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
