use crate::core::paths;
use crate::core::progress::{emit, PipelineEvent};
use crate::error::{AppError, AppResult};
use crate::pipeline::spawn::run_sidecar;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

/// String used in `AppError::Other` when a download is interrupted by the
/// user pressing pause. The frontend matches on this so it knows to show
/// "继续" instead of a hard error message.
pub const DOWNLOAD_CANCELLED: &str = "cancelled";

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

/// Download (or resume) the model file for `size`.
///
/// Resume: if `<dest>.partial` already exists, sends `Range: bytes=<offset>-`
/// and appends to it. Falls back to a fresh download if the server doesn't
/// honor the range request (200 instead of 206).
///
/// Cancel: the loop checks `cancel` once per chunk. On cancel we sync the
/// .partial file (so the bytes stay on disk for next resume) and return
/// `AppError::Other("cancelled")`. The frontend matches on that string.
pub async fn download_model(app: &AppHandle, size: &str, cancel: &AtomicBool) -> AppResult<()> {
    let (url, total_mb) = model_info(size)
        .ok_or_else(|| AppError::InvalidInput(format!("unknown model: {size}")))?;
    let dest = model_path(size)?;
    std::fs::create_dir_all(dest.parent().unwrap())?;

    // Download to a sibling `.partial` path so an interrupted download never
    // leaves a "complete-looking" file at `dest`. Rename to the final name
    // only after the stream finishes successfully.
    let partial = dest.with_extension("bin.partial");
    let existing: u64 = std::fs::metadata(&partial)
        .ok()
        .map(|m| m.len())
        .unwrap_or(0);

    let client = reqwest::Client::new();
    let mut req = client.get(url);
    if existing > 0 {
        req = req.header("Range", format!("bytes={}-", existing));
    }
    let resp = req.send().await?;
    let status = resp.status();
    let resume = status == reqwest::StatusCode::PARTIAL_CONTENT;

    // Total expected bytes:
    //   206 → parse "Content-Range: bytes start-end/total"; fall back to
    //         existing + content_length if not parseable.
    //   200 → server ignored Range (or first request); use Content-Length.
    let total_bytes: u64 = if resume {
        resp.headers()
            .get("content-range")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.split('/').nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| existing + resp.content_length().unwrap_or(0))
    } else {
        resp.content_length().unwrap_or(total_mb * 1024 * 1024)
    };

    let starting_offset = if resume { existing } else { 0 };
    let mut downloaded = starting_offset;
    let mut last_percent: u8 = ((starting_offset as f64 / total_bytes as f64) * 100.0) as u8;

    use futures_util::StreamExt;
    use std::io::Write;
    {
        let mut file = if resume {
            std::fs::OpenOptions::new()
                .write(true)
                .append(true)
                .open(&partial)?
        } else {
            // Fresh download — overwrite any stale .partial.
            std::fs::File::create(&partial)?
        };
        let mut stream = resp.bytes_stream();

        // Emit an initial progress event so resumed downloads show their
        // starting % immediately rather than jumping from 0.
        if resume && starting_offset > 0 {
            emit(
                app,
                PipelineEvent::ModelDownload {
                    progress: last_percent,
                    total_mb: total_bytes / 1024 / 1024,
                    downloaded_mb: downloaded / 1024 / 1024,
                },
            );
        }

        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::Relaxed) {
                // Best-effort flush so what's on disk is durable for resume.
                let _ = file.sync_all();
                return Err(AppError::Other(DOWNLOAD_CANCELLED.into()));
            }
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
        // Don't delete .partial — user can resume.
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

/// Size of the partial download for `size`, or 0 if no .partial file exists.
/// Used by the frontend to render "继续 (45%)" on a fresh launch.
pub fn partial_size(size: &str) -> AppResult<u64> {
    let dest = model_path(size)?;
    let partial = dest.with_extension("bin.partial");
    Ok(std::fs::metadata(&partial).ok().map(|m| m.len()).unwrap_or(0))
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
    // Backend detection — whisper-cli prints e.g.
    //   ggml_vulkan: Found 2 Vulkan devices:
    //   ggml_vulkan: 0 = NVIDIA GeForce RTX 4090 (NVIDIA) | uma: 0 | fp16: 1 ...
    // on startup. We capture the first device line (id "0 =") and emit
    // BackendDetected once per run so the UI can render the active accelerator.
    let app_for_backend = app.clone();
    let backend_emitted = std::sync::atomic::AtomicBool::new(false);
    let backend_emitted = std::sync::Arc::new(backend_emitted);
    let backend_emitted_clone = backend_emitted.clone();
    let detect_backend = move |chunk: &str| {
        if backend_emitted_clone.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        for line in chunk.lines() {
            if let Some(name) = detect_backend_line(line) {
                emit(
                    &app_for_backend,
                    PipelineEvent::BackendDetected { name },
                );
                backend_emitted_clone.store(true, std::sync::atomic::Ordering::Relaxed);
                break;
            }
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
            detect_backend(line);
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
    // If whisper-cli ran without ever printing a Vulkan device line, it fell
    // back to CPU. Surface that explicitly so the UI doesn't say "未检测".
    if !backend_emitted.load(std::sync::atomic::Ordering::Relaxed) {
        emit(app, PipelineEvent::BackendDetected { name: "CPU".into() });
    }

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

/// Parse the first whisper.cpp device line, e.g.
///   `ggml_vulkan: 0 = NVIDIA GeForce RTX 4090 (NVIDIA) | uma: 0 | ...`
/// into `"Vulkan / NVIDIA GeForce RTX 4090"`.
/// CUDA / CoreML / Metal builds emit similar `ggml_<backend>: ...` patterns;
/// we generalize by recognizing any `ggml_<word>: 0 = <name>` form.
fn detect_backend_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    // Expect "ggml_<backend>:" prefix
    let rest = trimmed.strip_prefix("ggml_")?;
    let (backend, after) = rest.split_once(':')?;
    let after = after.trim();
    // Only the device-id 0 line is useful (later lines are extra devices).
    let payload = after.strip_prefix("0 =")?.trim();
    // Cut off anything from the first " (" or " | " — keeps just the model name.
    let name_end = payload
        .find(" (")
        .or_else(|| payload.find(" | "))
        .unwrap_or(payload.len());
    let model = payload[..name_end].trim();
    if model.is_empty() {
        return None;
    }
    let backend_label = match backend {
        "vulkan" => "Vulkan",
        "cuda" => "CUDA",
        "metal" => "Metal",
        "sycl" => "SYCL",
        other => return Some(format!("{other} / {model}")),
    };
    Some(format!("{backend_label} / {model}"))
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

    #[test]
    fn parses_vulkan_device_line() {
        let line = "ggml_vulkan: 0 = NVIDIA GeForce RTX 4090 (NVIDIA) | uma: 0 | fp16: 1";
        assert_eq!(
            detect_backend_line(line),
            Some("Vulkan / NVIDIA GeForce RTX 4090".to_string())
        );
    }

    #[test]
    fn parses_cuda_device_line() {
        let line = "ggml_cuda: 0 = NVIDIA GeForce RTX 4090 | shared mem: 49152";
        assert_eq!(
            detect_backend_line(line),
            Some("CUDA / NVIDIA GeForce RTX 4090".to_string())
        );
    }

    #[test]
    fn skips_non_device_lines() {
        assert_eq!(detect_backend_line("ggml_vulkan: Found 2 Vulkan devices:"), None);
        assert_eq!(detect_backend_line("whisper_init_state: ..."), None);
        assert_eq!(detect_backend_line("ggml_vulkan: 1 = AMD Radeon"), None);
    }
}
