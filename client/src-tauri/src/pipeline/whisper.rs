use crate::core::paths;
use crate::core::progress::{emit, GpuDevice, PipelineEvent};
use crate::error::{AppError, AppResult};
use crate::pipeline::spawn::run_sidecar_env;
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

/// Minimum audio duration (seconds) above which VAD is auto-enabled.
/// Short videos transcribe accurately without VAD; only long media suffers
/// whisper's drift/hallucination, so we gate on length. Hardcoded — no setting.
const VAD_MIN_DURATION_SECS: f64 = 1200.0; // 20 minutes

/// Bundled Silero VAD model file name (shipped under resource_dir/models/).
const VAD_MODEL_FILE: &str = "ggml-silero-v5.1.2.bin";

/// Pure gate: enable VAD only for long media when the VAD model is available.
fn should_use_vad(duration_secs: f64, vad_model_present: bool) -> bool {
    vad_model_present && duration_secs > VAD_MIN_DURATION_SECS
}

/// Build the whisper-cli argument vector. When `vad_model` is `Some`, append
/// `--vad --vad-model <path>`; otherwise the args are exactly today's set.
fn build_whisper_args<'a>(
    model: &'a str,
    audio: &'a str,
    out_base: &'a str,
    vad_model: Option<&'a str>,
) -> Vec<&'a str> {
    let mut args: Vec<&str> = vec![
        "-m", model,
        "-f", audio,
        "-l", "en",
        "-mc", "0",
        "-osrt",
        "-of", out_base,
        "--print-progress",
    ];
    if let Some(vm) = vad_model {
        args.push("--vad");
        args.push("--vad-model");
        args.push(vm);
    }
    args
}

/// Resolve the bundled VAD model (resource_dir/models/<VAD_MODEL_FILE>).
/// `None` when not present — callers then skip VAD (graceful fallback).
fn vad_model_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let p = app
        .path()
        .resource_dir()
        .ok()?
        .join("models")
        .join(VAD_MODEL_FILE);
    p.exists().then_some(p)
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

    // VAD decision — computed once, invariant across stall retries (like GPU pinning).
    let duration_secs = crate::pipeline::ffmpeg::probe_duration_secs(app, audio_path).await;
    let vad_model = vad_model_path(app);
    let use_vad = should_use_vad(duration_secs, vad_model.is_some());
    let vad_arg: Option<String> = if use_vad {
        vad_model.as_ref().map(|p| p.to_string_lossy().to_string())
    } else {
        None
    };
    if use_vad {
        emit(
            app,
            PipelineEvent::Log {
                video_id: video_id.to_string(),
                source: "whatsub".into(),
                line: "长视频已启用 VAD 智能分段（跳过非语音段，提升字幕准确度）".into(),
            },
        );
    }

    // GPU device selection — invariant across stall retries.
    let (prefer_discrete, pinned) = gpu_preference();
    let pin_str = pinned.map(|i| i.to_string());
    let env: Vec<(&str, &str)> = match pin_str.as_deref() {
        Some(s) => vec![("GGML_VK_VISIBLE_DEVICES", s)],
        None => vec![],
    };

    // Stall auto-recovery: a sleep-wedged whisper-cli (hung process / lost GPU
    // context on wake) gets killed by the spawn watchdog ("stalled"). whisper.cpp
    // has no mid-file resume, so re-run from scratch on the SAME audio.wav (no
    // re-download / re-extract — the GPU is healthy again after wake). Bounded so
    // a persistently-broken GPU surfaces a real error instead of looping forever.
    const WHISPER_STALL_RETRIES: u32 = 2;
    let mut stall_retries: u32 = 0;
    loop {
        match run_whisper_once(
            app, &audio_str, &model_str, &out_base, &env, prefer_discrete, pinned,
            vad_arg.as_deref(), video_id, cancel,
        )
        .await
        {
            Ok(()) => return Ok(out_dir.join("transcript.srt")),
            Err(AppError::Cancelled) => return Err(AppError::Cancelled),
            Err(e)
                if e.to_string().contains("stalled") && stall_retries < WHISPER_STALL_RETRIES =>
            {
                stall_retries += 1;
                emit(
                    app,
                    PipelineEvent::Log {
                        video_id: video_id.to_string(),
                        source: "whatsub".into(),
                        line: format!(
                            "[whatsub] 转录卡住（可能是休眠中断）— 自动重新转录 ({}/{})",
                            stall_retries, WHISPER_STALL_RETRIES
                        ),
                    },
                );
                // Restart the bar from 0 instead of leaving it frozen at the old %.
                emit(
                    app,
                    PipelineEvent::Transcribing {
                        video_id: video_id.to_string(),
                        percent: 0,
                    },
                );
                continue;
            }
            Err(e) => return Err(e),
        }
    }
}

/// One whisper-cli transcription attempt: builds the progress / backend / device
/// callbacks, runs whisper, and on success emits the CPU-fallback notice + the
/// Vulkan device inventory. Returns `Err(... "stalled" ...)` when the spawn
/// watchdog killed a wedged process — `transcribe` retries those from scratch.
#[allow(clippy::too_many_arguments)]
async fn run_whisper_once(
    app: &AppHandle,
    audio_str: &str,
    model_str: &str,
    out_base: &str,
    env: &[(&str, &str)],
    prefer_discrete: bool,
    pinned: Option<u32>,
    vad_model: Option<&str>,
    video_id: &str,
    cancel: Option<&CancellationToken>,
) -> AppResult<()> {
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
    // Collect every Vulkan device line so we can persist the inventory after an
    // unfiltered run (a pinned run only sees the 1 selected device).
    let devices = std::sync::Arc::new(std::sync::Mutex::new(Vec::<GpuDevice>::new()));
    let devices_cb = devices.clone();
    // Stall watchdog: bump on each progress line so the spawn loop can kill a
    // HUNG whisper-cli (e.g. the laptop slept mid-transcription and the GPU /
    // process is wedged on wake) instead of the import hanging forever at
    // "转录中". Armed only after progress first moves, so model-load silence is
    // never killed. whisper.cpp can't resume mid-file, so a kill surfaces as a
    // clean failure → the user re-runs via the Player's 重新转录 (which reuses
    // the already-downloaded source.mp4 — no re-download).
    let progress_count = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let progress_count_cb = progress_count.clone();
    let whisper_args = build_whisper_args(model_str, audio_str, out_base, vad_model);
    run_sidecar_env(
        app,
        "whisper-cli",
        &whisper_args,
        env,
        Some(progress_count.clone()),
        false,
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
                if let Some(d) = parse_vulkan_device(line) {
                    if let Ok(mut v) = devices_cb.lock() {
                        if !v.iter().any(|x| x.index == d.index) {
                            v.push(d);
                        }
                    }
                }
            }
            for line in chunk.lines() {
                let Some(p) = parse_progress(line) else {
                    continue;
                };
                // Liveness signal for the stall watchdog (count every progress
                // line, even non-increasing ones — they still prove whisper is
                // alive).
                progress_count_cb.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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
    // If whisper-cli ran without ever printing a recognized accelerator line,
    // it fell back to CPU. Surface that explicitly so the UI doesn't say
    // "未检测". Keep detect_backend_line in sync with upstream log formats:
    // Metal's v1.8.x output no longer uses the Vulkan-style `0 = ...` line.
    if !backend_emitted.load(std::sync::atomic::Ordering::Relaxed) {
        emit(app, PipelineEvent::BackendDetected { name: "CPU".into() });
    }

    // Persist the device inventory after an unfiltered run so Settings can show
    // the cards and the next run can pin the discrete GPU. A pinned run only
    // sees its 1 selected device, so skip it (it would clobber the full list).
    if pinned.is_none() {
        let found = devices.lock().map(|v| v.clone()).unwrap_or_default();
        if !found.is_empty() {
            emit(app, PipelineEvent::GpuDevices { devices: found.clone() });
            // A discrete card exists but this run used device 0 (the iGPU) —
            // tell the user it'll switch automatically next time.
            if prefer_discrete {
                if let Some(d) = found.iter().find(|d| d.discrete && d.index != 0) {
                    emit(
                        app,
                        PipelineEvent::Log {
                            video_id: video_id.to_string(),
                            source: "whisper-cli".into(),
                            line: format!(
                                "已检测到独立显卡 {} —— 下次转录将自动用它加速",
                                d.name
                            ),
                        },
                    );
                }
            }
        }
    }

    Ok(())
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

/// Parse a whisper.cpp accelerator line, e.g.
///   `ggml_vulkan: 0 = NVIDIA GeForce RTX 4090 (NVIDIA) | uma: 0 | ...`
/// into `"Vulkan / NVIDIA GeForce RTX 4090"`.
///
/// Metal changed its startup messages in whisper.cpp v1.8.x to lines such as
/// `ggml_metal_device_init: GPU name: MTL0` and
/// `whisper_backend_init_gpu: using Metal backend`. Recognize those explicitly
/// instead of incorrectly reporting CPU after a successful Metal run.
fn detect_backend_line(line: &str) -> Option<String> {
    let trimmed = line.trim();

    for prefix in [
        "ggml_metal_device_init: GPU name:",
        "ggml_metal_init: GPU name:",
        "ggml_metal_init: found device:",
        "ggml_metal_init: picking default device:",
    ] {
        if let Some(raw_model) = trimmed.strip_prefix(prefix) {
            let model = raw_model.trim();
            if model.is_empty() {
                return None;
            }
            // Recent ggml versions use the internal device id "MTL0" here;
            // don't expose that implementation detail as if it were a model.
            return Some(if is_metal_device_id(model) {
                "Metal".to_string()
            } else {
                format!("Metal / {model}")
            });
        }
    }

    if matches!(
        trimmed,
        "whisper_backend_init_gpu: using Metal backend"
            | "whisper_backend_init: using Metal backend"
    ) || (trimmed.starts_with("whisper_model_load:")
        && trimmed.contains("Metal total size"))
    {
        return Some("Metal".to_string());
    }

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

fn is_metal_device_id(value: &str) -> bool {
    value
        .strip_prefix("MTL")
        .is_some_and(|suffix| {
            !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit())
        })
}

/// Parse a whisper-cli Vulkan device-list line, e.g.
///   `ggml_vulkan: 1 = NVIDIA GeForce RTX 4060 (NVIDIA) | uma: 0 | fp16: 1 ...`
/// into a `GpuDevice`. `discrete` is true when `uma: 0` (integrated GPUs share
/// system memory and report `uma: 1`); when the `uma:` flag is absent we fall
/// back to a name heuristic. Returns `None` for the header line
/// ("Found N Vulkan devices:") and any other non-device line.
fn parse_vulkan_device(line: &str) -> Option<GpuDevice> {
    let rest = line.trim().strip_prefix("ggml_vulkan:")?.trim();
    let (idx_str, after) = rest.split_once('=')?;
    let index: u32 = idx_str.trim().parse().ok()?;
    let after = after.trim();
    // Name = up to the first " (" (vendor) or " |" (flags).
    let name_end = after
        .find(" (")
        .or_else(|| after.find(" |"))
        .unwrap_or(after.len());
    let name = after[..name_end].trim().to_string();
    if name.is_empty() {
        return None;
    }
    let discrete = match after.find("uma:") {
        Some(p) => !after[p + 4..].trim_start().starts_with('1'),
        None => {
            let lower = name.to_lowercase();
            !(lower.contains("graphics")
                || lower.contains("uhd")
                || lower.contains("iris"))
        }
    };
    Some(GpuDevice {
        index,
        name,
        discrete,
    })
}

/// Read the transcription GPU preference from settings.json. Returns
/// `(prefer_discrete, pinned_index)`:
/// - `prefer_discrete` — whether to auto-use the discrete GPU (default true).
/// - `pinned_index` — the cached discrete device's index to pass to
///   `GGML_VK_VISIBLE_DEVICES`, present only when preference is on, a discrete
///   card was previously detected, and it isn't already device 0.
fn gpu_preference() -> (bool, Option<u32>) {
    let settings = crate::commands::settings::get_settings().unwrap_or(serde_json::Value::Null);
    let prefer = settings
        .get("preferDiscreteGpu")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !prefer {
        return (false, None);
    }
    let pinned = settings
        .get("whisperGpus")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find_map(|d| {
                let idx = d.get("index")?.as_u64()? as u32;
                let discrete = d.get("discrete")?.as_bool()?;
                (discrete && idx != 0).then_some(idx)
            })
        });
    (true, pinned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vad_gate_only_for_long_videos_with_model() {
        assert!(should_use_vad(1201.0, true));       // > 20 min + model present
        assert!(!should_use_vad(1200.0, true));      // exactly 20 min → not greater
        assert!(!should_use_vad(600.0, true));       // short
        assert!(!should_use_vad(3600.0, false));     // long but model missing
        assert!(!should_use_vad(0.0, true));         // probe failed (0.0)
    }

    #[test]
    fn whisper_args_without_vad_have_no_vad_flags() {
        let args = build_whisper_args("m.bin", "a.wav", "out", None);
        assert!(!args.contains(&"--vad"));
        assert!(args.contains(&"-mc") && args.contains(&"0"));
        assert!(args.contains(&"-osrt"));
        // sanity: model + audio threaded through
        assert!(args.contains(&"m.bin") && args.contains(&"a.wav"));
    }

    #[test]
    fn whisper_args_with_vad_append_vad_flags() {
        let args = build_whisper_args("m.bin", "a.wav", "out", Some("vad.bin"));
        assert!(args.contains(&"--vad"));
        let i = args.iter().position(|a| *a == "--vad-model").unwrap();
        assert_eq!(args[i + 1], "vad.bin");
        // existing flags preserved
        assert!(args.contains(&"-mc") && args.contains(&"-osrt"));
    }

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
    fn parses_modern_metal_device_line() {
        assert_eq!(
            detect_backend_line("ggml_metal_device_init: GPU name: MTL0"),
            Some("Metal".to_string())
        );
        assert_eq!(
            detect_backend_line("ggml_metal_device_init: GPU name: Apple M4 Pro"),
            Some("Metal / Apple M4 Pro".to_string())
        );
    }

    #[test]
    fn parses_metal_backend_activation_lines() {
        assert_eq!(
            detect_backend_line("whisper_backend_init_gpu: using Metal backend"),
            Some("Metal".to_string())
        );
        assert_eq!(
            detect_backend_line("whisper_model_load:    Metal total size =   148.55 MB"),
            Some("Metal".to_string())
        );
    }

    #[test]
    fn parses_legacy_metal_device_line() {
        assert_eq!(
            detect_backend_line("ggml_metal_init: found device: Apple M2 Pro"),
            Some("Metal / Apple M2 Pro".to_string())
        );
    }

    #[test]
    fn skips_non_device_lines() {
        assert_eq!(detect_backend_line("ggml_vulkan: Found 2 Vulkan devices:"), None);
        assert_eq!(detect_backend_line("whisper_init_state: ..."), None);
        assert_eq!(detect_backend_line("ggml_vulkan: 1 = AMD Radeon"), None);
        assert_eq!(
            detect_backend_line("whisper_backend_init: using BLAS backend"),
            None
        );
    }

    #[test]
    fn parses_vulkan_device_inventory() {
        let dgpu = parse_vulkan_device(
            "ggml_vulkan: 1 = NVIDIA GeForce RTX 4060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1",
        )
        .unwrap();
        assert_eq!(dgpu.index, 1);
        assert_eq!(dgpu.name, "NVIDIA GeForce RTX 4060 Laptop GPU");
        assert!(dgpu.discrete);

        let igpu = parse_vulkan_device(
            "ggml_vulkan: 0 = Intel(R) Iris(R) Xe Graphics (Intel) | uma: 1 | fp16: 1",
        )
        .unwrap();
        assert_eq!(igpu.index, 0);
        assert!(!igpu.discrete);
    }

    #[test]
    fn vulkan_device_parser_skips_noise() {
        assert!(parse_vulkan_device("ggml_vulkan: Found 2 Vulkan devices:").is_none());
        assert!(parse_vulkan_device("whisper_init: loading model").is_none());
        assert!(parse_vulkan_device("ggml_vulkan: device memory = 8192 MB").is_none());
    }

    #[test]
    fn vulkan_discrete_falls_back_to_name_when_uma_absent() {
        // No "uma:" flag → name heuristic. NVIDIA card → discrete.
        let d = parse_vulkan_device("ggml_vulkan: 1 = NVIDIA GeForce RTX 4060 (NVIDIA)").unwrap();
        assert!(d.discrete);
        // Integrated "... Graphics" → not discrete.
        let i = parse_vulkan_device("ggml_vulkan: 0 = Intel(R) UHD Graphics (Intel)").unwrap();
        assert!(!i.discrete);
    }
}
