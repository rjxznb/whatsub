use crate::core::paths;
use crate::core::progress::{emit, PipelineEvent};
use crate::error::{AppError, AppResult};
use crate::pipeline::spawn::run_sidecar;
use std::path::Path;
use tauri::AppHandle;

const MODEL_URLS: &[(&str, &str, u64)] = &[
    ("tiny",     "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",     75),
    ("base",     "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",     145),
    ("small",    "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",    466),
    ("medium",   "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",   1500),
    ("large-v3", "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin", 3094),
];

pub fn model_info(size: &str) -> Option<(&'static str, u64)> {
    MODEL_URLS
        .iter()
        .find(|(s, _, _)| *s == size)
        .map(|(_, url, mb)| (*url, *mb))
}

pub fn model_path(size: &str) -> AppResult<std::path::PathBuf> {
    Ok(paths::models_dir()?.join(format!("ggml-{size}.bin")))
}

pub fn model_exists(size: &str) -> AppResult<bool> {
    Ok(model_path(size)?.exists())
}

pub async fn download_model(app: &AppHandle, size: &str) -> AppResult<()> {
    let (url, total_mb) = model_info(size)
        .ok_or_else(|| AppError::InvalidInput(format!("unknown model: {size}")))?;
    let dest = model_path(size)?;
    std::fs::create_dir_all(dest.parent().unwrap())?;

    // Download to a sibling `.partial` path so an interrupted download never
    // leaves a "complete-looking" file at `dest`. Rename to the final name
    // only after the stream finishes successfully.
    let partial = dest.with_extension("bin.partial");
    if partial.exists() {
        std::fs::remove_file(&partial)?;
    }

    let resp = reqwest::get(url).await?;
    let total_bytes = resp.content_length().unwrap_or(total_mb * 1024 * 1024);
    let mut downloaded: u64 = 0;
    let mut last_percent: u8 = 0;

    use futures_util::StreamExt;
    use std::io::Write;
    {
        let mut file = std::fs::File::create(&partial)?;
        let mut stream = resp.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let bytes = chunk?;
            file.write_all(&bytes)?;
            downloaded += bytes.len() as u64;
            let pct = ((downloaded as f64 / total_bytes as f64) * 100.0) as u8;
            if pct != last_percent {
                last_percent = pct;
                emit(
                    app,
                    PipelineEvent::ModelDownload {
                        progress: pct,
                        total_mb: total_bytes / 1024 / 1024,
                        downloaded_mb: downloaded / 1024 / 1024,
                    },
                );
            }
        }
        file.sync_all()?;
    }

    // Sanity check: if Content-Length was known, refuse to rename a truncated file.
    if resp_had_content_length(total_bytes, total_mb) && downloaded < total_bytes {
        std::fs::remove_file(&partial).ok();
        return Err(AppError::Other(format!(
            "download truncated: got {} bytes, expected {}",
            downloaded, total_bytes
        )));
    }

    std::fs::rename(&partial, &dest)?;
    Ok(())
}

fn resp_had_content_length(total_bytes: u64, fallback_mb: u64) -> bool {
    // If total_bytes equals the fallback_mb*1024*1024 exactly, it's the unwrap_or default
    // (no Content-Length). Otherwise the server provided a real value.
    total_bytes != fallback_mb * 1024 * 1024
}

pub async fn transcribe(
    app: &AppHandle,
    audio_path: &Path,
    out_dir: &Path,
    model_size: &str,
    video_id: &str,
) -> AppResult<std::path::PathBuf> {
    let model = model_path(model_size)?;
    if !model.exists() {
        return Err(AppError::NotFound(format!(
            "model not downloaded: {model_size}"
        )));
    }

    let audio_str = audio_path.to_string_lossy().to_string();
    let model_str = model.to_string_lossy().to_string();
    // whisper-cli writes <out_base>.srt
    let out_base = out_dir.join("transcript").to_string_lossy().to_string();

    let id = video_id.to_string();
    let app_clone = app.clone();
    let id_for_log = video_id.to_string();
    let app_for_log = app.clone();
    let emit_log = move |chunk: &str| {
        for line in chunk.lines() {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            emit(
                &app_for_log,
                PipelineEvent::Log {
                    video_id: id_for_log.clone(),
                    source: "whisper-cli".into(),
                    line: t.into(),
                },
            );
        }
    };
    run_sidecar(
        app,
        "whisper-cli",
        &[
            "-m", &model_str,
            "-f", &audio_str,
            "-l", "en",
            "-osrt",
            "-of", &out_base,
            "--print-progress",
        ],
        move |line| {
            emit_log(line);
            if let Some(p) = parse_progress(line) {
                emit(
                    &app_clone,
                    PipelineEvent::Transcribing {
                        video_id: id.clone(),
                        percent: p,
                    },
                );
            }
        },
    )
    .await?;

    Ok(out_dir.join("transcript.srt"))
}

fn parse_progress(line: &str) -> Option<u8> {
    let trimmed = line.trim();
    if let Some(idx) = trimmed.find("progress =") {
        let rest = &trimmed[idx + "progress =".len()..];
        let pct_str = rest.trim().trim_end_matches('%').trim();
        return pct_str.parse::<u8>().ok();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_whisper_progress_line() {
        assert_eq!(
            parse_progress("whisper_print_progress_callback: progress = 42%"),
            Some(42)
        );
        assert_eq!(parse_progress("noise"), None);
    }

    #[test]
    fn model_info_known_size() {
        assert!(model_info("small").is_some());
        assert!(model_info("nonexistent").is_none());
    }
}
