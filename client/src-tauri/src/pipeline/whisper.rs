use crate::core::paths;
use crate::core::progress::{emit, PipelineEvent};
use crate::error::{AppError, AppResult};
use crate::pipeline::spawn::run_sidecar;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

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

/// User-writable model path (`<models_dir>/ggml-{size}.bin`). This is where
/// downloads land; the bundled fallback below is read-only.
pub fn model_path(size: &str) -> AppResult<std::path::PathBuf> {
    Ok(paths::models_dir()?.join(format!("ggml-{size}.bin")))
}

/// Path to a model shipped inside the app bundle (Tauri `bundle.resources` →
/// `<resource_dir>/models/ggml-{size}.bin`). We bundle one small model
/// (`ggml-base.bin`) so first-run needs no download; returns `Some` only when
/// that resource actually exists for `size`. Read-only — never written to.
pub fn bundled_model_path(app: &AppHandle, size: &str) -> Option<std::path::PathBuf> {
    let p = app
        .path()
        .resource_dir()
        .ok()?
        .join("models")
        .join(format!("ggml-{size}.bin"));
    p.exists().then_some(p)
}

/// Resolve the model file to actually use for `size`: a user-downloaded copy
/// takes precedence (they may have fetched a better-quality tier), else the
/// bundled copy. `None` = not available anywhere → caller must prompt download.
pub fn resolve_model_path(app: &AppHandle, size: &str) -> Option<std::path::PathBuf> {
    if let Ok(user) = model_path(size) {
        if user.exists() {
            return Some(user);
        }
    }
    bundled_model_path(app, size)
}

pub fn model_exists(app: &AppHandle, size: &str) -> bool {
    resolve_model_path(app, size).is_some()
}

/// Download (or resume) the model file for `size`.
///
/// Resume: if `<dest>.partial` already exists, sends `Range: bytes=<offset>-`
/// and appends to it. Falls back to a fresh download if the server doesn't
/// honor the range request (200 instead of 206).
///
/// Robustness: wraps the stream loop in an outer retry (up to MAX_RETRIES)
/// so a single network hiccup doesn't burn a whole 3 GB download. Each
/// chunk read is wrapped in a CHUNK_TIMEOUT — a stalled stream auto-aborts
/// and re-issues a Range request from the current on-disk position.
///
/// Corruption guard: validates the server's `Content-Range` start matches
/// our requested offset. Some CDN edges (notably hf-mirror) occasionally
/// serve 206 starting from byte 0 instead of the byte we asked for —
/// blindly appending those bytes to an existing partial would silently
/// produce a "right size, wrong content" file (the bug that bricked the
/// large-v3 model). On mismatch we wipe the .partial and start fresh.
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

    const MAX_RETRIES: u8 = 3;
    const CHUNK_TIMEOUT_SECS: u64 = 30;
    const RETRY_BACKOFF_SECS: u64 = 2;

    let client = reqwest::Client::new();
    let mut retry: u8 = 0;
    let mut total_bytes: Option<u64> = None;

    use futures_util::StreamExt;
    use std::io::Write;

    loop {
        // Re-read .partial size each iteration: if a previous attempt's
        // chunks landed on disk before failing, we resume from where they
        // got to — not where we started this iteration.
        let existing: u64 = std::fs::metadata(&partial).ok().map(|m| m.len()).unwrap_or(0);

        let resp = {
            let mut req = client.get(url);
            if existing > 0 {
                req = req.header("Range", format!("bytes={}-", existing));
            }
            match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    if retry >= MAX_RETRIES {
                        return Err(e.into());
                    }
                    retry += 1;
                    tokio::time::sleep(std::time::Duration::from_secs(RETRY_BACKOFF_SECS)).await;
                    continue;
                }
            }
        };
        let resume = resp.status() == reqwest::StatusCode::PARTIAL_CONTENT;

        // ── Content-Range integrity check ────────────────────────────────
        // If we asked for "bytes=N-" and the server returns 206, the
        // Content-Range header MUST start at N. If it starts elsewhere,
        // the new bytes don't continue our existing partial — appending
        // them would silently corrupt the file. Drop the partial and
        // retry from scratch.
        if resume && existing > 0 {
            let returned_start = resp
                .headers()
                .get("content-range")
                .and_then(|h| h.to_str().ok())
                .and_then(parse_content_range_start);
            if returned_start != Some(existing) {
                drop(resp);
                let _ = std::fs::remove_file(&partial);
                if retry >= MAX_RETRIES {
                    return Err(AppError::Other(format!(
                        "Content-Range mismatch: asked for byte {}, server returned {:?}; partial discarded",
                        existing, returned_start
                    )));
                }
                retry += 1;
                tokio::time::sleep(std::time::Duration::from_secs(RETRY_BACKOFF_SECS)).await;
                continue;
            }
        }

        // Compute total bytes once on the first successful response.
        // Subsequent retries reuse this so the truncation check at the
        // bottom doesn't go off a stale Content-Length from a 206 request
        // whose Content-Range parsing failed.
        if total_bytes.is_none() {
            total_bytes = Some(if resume {
                resp.headers()
                    .get("content-range")
                    .and_then(|h| h.to_str().ok())
                    .and_then(|s| s.split('/').nth(1))
                    .and_then(|s| s.parse().ok())
                    .unwrap_or_else(|| existing + resp.content_length().unwrap_or(0))
            } else {
                resp.content_length().unwrap_or(total_mb * 1024 * 1024)
            });
        }
        let tb = total_bytes.unwrap();

        let starting_offset = if resume { existing } else { 0 };
        let mut downloaded = starting_offset;
        let mut last_percent: u8 = ((starting_offset as f64 / tb as f64) * 100.0) as u8;

        // ── Stream + write loop ──────────────────────────────────────────
        // Returns Some(error) on any chunk-level failure (timeout, network,
        // IO) so the outer loop can retry from the current on-disk offset.
        // Returns None on clean EOF.
        let stream_err: Option<AppError> = {
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

            if resume && starting_offset > 0 {
                emit(
                    app,
                    PipelineEvent::ModelDownload {
                        progress: last_percent,
                        total_mb: tb / 1024 / 1024,
                        downloaded_mb: downloaded / 1024 / 1024,
                    },
                );
            }

            loop {
                if cancel.load(Ordering::Relaxed) {
                    let _ = file.sync_all();
                    return Err(AppError::Other(DOWNLOAD_CANCELLED.into()));
                }
                let next = tokio::time::timeout(
                    std::time::Duration::from_secs(CHUNK_TIMEOUT_SECS),
                    stream.next(),
                )
                .await;
                let chunk_opt = match next {
                    Err(_) => {
                        let _ = file.sync_all();
                        break Some(AppError::Other(format!(
                            "no data for {}s — connection stalled",
                            CHUNK_TIMEOUT_SECS
                        )));
                    }
                    Ok(c) => c,
                };
                let bytes = match chunk_opt {
                    None => {
                        let _ = file.sync_all();
                        break None;
                    }
                    Some(Err(e)) => {
                        let _ = file.sync_all();
                        break Some(e.into());
                    }
                    Some(Ok(b)) => b,
                };
                if let Err(e) = file.write_all(&bytes) {
                    let _ = file.sync_all();
                    break Some(e.into());
                }
                downloaded += bytes.len() as u64;
                let pct = ((downloaded as f64 / tb as f64) * 100.0) as u8;
                if pct != last_percent {
                    last_percent = pct;
                    emit(
                        app,
                        PipelineEvent::ModelDownload {
                            progress: pct,
                            total_mb: tb / 1024 / 1024,
                            downloaded_mb: downloaded / 1024 / 1024,
                        },
                    );
                }
            }
            // file dropped here, releasing the OS handle so the next
            // iteration can open it cleanly in append mode.
        };

        if let Some(e) = stream_err {
            if retry >= MAX_RETRIES {
                return Err(e);
            }
            retry += 1;
            tokio::time::sleep(std::time::Duration::from_secs(RETRY_BACKOFF_SECS)).await;
            continue;
        }

        break; // clean EOF → exit retry loop
    }

    // Sanity check: if Content-Length was known, refuse to rename a truncated file.
    let tb = total_bytes.unwrap_or(0);
    let final_size = std::fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
    if resp_had_content_length(tb, total_mb) && final_size < tb {
        // Don't delete .partial — user can resume.
        return Err(AppError::Other(format!(
            "download truncated: got {} bytes, expected {}",
            final_size, tb
        )));
    }

    std::fs::rename(&partial, &dest)?;
    Ok(())
}

/// Parse the start byte of an HTTP `Content-Range` value.
///
/// Format: `bytes <start>-<end>/<total>`  →  `Some(start)`
/// Returns `None` for malformed input.
fn parse_content_range_start(value: &str) -> Option<u64> {
    value
        .trim()
        .strip_prefix("bytes ")?
        .split('-')
        .next()?
        .trim()
        .parse()
        .ok()
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
    cancel: Option<&CancellationToken>,
) -> AppResult<std::path::PathBuf> {
    let model = resolve_model_path(app, model_size).ok_or_else(|| {
        AppError::NotFound(format!("model not downloaded: {model_size}"))
    })?;

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
    // whisper-cli's `whisper_print_progress_callback` can fire non-monotonic
    // values during temperature fallbacks and segment retries (observed
    // 40 → 5 → 45 in the wild). Clamp to monotonic-non-decreasing so the
    // user never sees a backwards-jumping bar; the underlying retry is fine,
    // we just don't surface it.
    let last_progress = std::sync::Arc::new(std::sync::atomic::AtomicU8::new(0));
    let last_progress_clone = last_progress.clone();
    run_sidecar(
        app,
        "whisper-cli",
        &[
            "-m", &model_str,
            "-f", &audio_str,
            "-l", "en",
            // Disable text-context carryover between 30s windows (whisper.cpp
            // default is -1 = carry as much prior transcript as fits). With it
            // on, a repetition/hallucination on a non-speech stretch (intro
            // music, crowd noise) becomes the prompt for the next window and
            // snowballs into a runaway loop of one repeated line across the
            // whole file (observed on sports-highlight intros). A controlled
            // A/B on clean speech showed no quality loss from -mc 0 — only
            // minor cross-window punctuation/casing variance, which the
            // downstream LLM translation normalizes anyway.
            "-mc", "0",
            "-osrt",
            "-of", &out_base,
            "--print-progress",
        ],
        move |chunk| {
            // run_sidecar hands us raw stderr CHUNKS that may contain
            // multiple lines. emit_log / detect_backend already split
            // internally; parse_progress's `.find("progress =")` only
            // returns the FIRST match in a chunk, so any subsequent
            // progress updates batched into the same chunk get
            // silently dropped. Iterate per-line for complete coverage.
            emit_log(chunk);
            detect_backend(chunk);
            for line in chunk.lines() {
                let Some(p) = parse_progress(line) else {
                    continue;
                };
                let prev = last_progress_clone.load(std::sync::atomic::Ordering::Relaxed);
                if p > prev {
                    last_progress_clone.store(p, std::sync::atomic::Ordering::Relaxed);
                    emit(
                        &app_clone,
                        PipelineEvent::Transcribing {
                            video_id: id.clone(),
                            percent: p,
                        },
                    );
                }
            }
        },
        cancel,
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
