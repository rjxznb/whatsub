use crate::core::progress::{emit, PipelineEvent};
use crate::error::AppResult;
use crate::pipeline::spawn::run_sidecar;
use std::path::Path;
use tauri::AppHandle;

fn make_log_emitter(app: &AppHandle, video_id: &str) -> impl Fn(&str) {
    let app = app.clone();
    let id = video_id.to_string();
    move |chunk: &str| {
        for line in chunk.lines() {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            emit(
                &app,
                PipelineEvent::Log {
                    video_id: id.clone(),
                    source: "ffmpeg".into(),
                    line: t.into(),
                },
            );
        }
    }
}

/// Convert any video to 16kHz mono PCM WAV at `out_path`. Whisper.cpp expects this format.
pub async fn extract_audio_wav(
    app: &AppHandle,
    video_path: &Path,
    out_path: &Path,
    video_id: &str,
) -> AppResult<()> {
    let video_str = video_path.to_string_lossy().to_string();
    let out_str = out_path.to_string_lossy().to_string();
    let log = make_log_emitter(app, video_id);
    run_sidecar(
        app,
        "ffmpeg",
        &[
            "-y",
            "-i", &video_str,
            "-vn",
            "-ac", "1",
            "-ar", "16000",
            "-c:a", "pcm_s16le",
            &out_str,
        ],
        log,
    )
    .await?;
    Ok(())
}

/// Extract first frame as JPEG thumbnail at `out_path`.
pub async fn extract_thumbnail(
    app: &AppHandle,
    video_path: &Path,
    out_path: &Path,
    video_id: &str,
) -> AppResult<()> {
    let video_str = video_path.to_string_lossy().to_string();
    let out_str = out_path.to_string_lossy().to_string();
    let log = make_log_emitter(app, video_id);
    run_sidecar(
        app,
        "ffmpeg",
        &[
            "-y",
            "-ss", "0.5",
            "-i", &video_str,
            "-vframes", "1",
            "-q:v", "2",
            &out_str,
        ],
        log,
    )
    .await?;
    Ok(())
}
