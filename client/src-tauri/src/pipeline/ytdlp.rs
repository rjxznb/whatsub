use crate::commands::yt_dlp::resolve_appdata_yt_dlp;
use crate::core::progress::{emit, PipelineEvent};
use crate::error::AppResult;
use crate::pipeline::spawn::{run_external_with_callback, run_sidecar_env};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

/// Compile-time target triple — Tauri renames sidecars at build time to
/// `<name>-<target_triple><exe_suffix>` and drops them next to the main
/// executable, so we need the same triple at runtime to find them.
const TARGET_TRIPLE: &str = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    "aarch64-apple-darwin"
} else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
    "x86_64-apple-darwin"
} else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
    "x86_64-pc-windows-msvc"
} else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
    "x86_64-unknown-linux-gnu"
} else {
    ""
};

/// Find the bundled sidecar binary on disk so we can hand its path to yt-dlp
/// (yt-dlp invokes ffmpeg as a separate child process and won't find ours
/// unless we tell it explicitly via --ffmpeg-location).
fn sidecar_path(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let suffix = std::env::consts::EXE_SUFFIX;
    let candidates: [PathBuf; 2] = if TARGET_TRIPLE.is_empty() {
        [dir.join(format!("{name}{suffix}")), dir.join(name)]
    } else {
        [
            dir.join(format!("{name}-{TARGET_TRIPLE}{suffix}")),
            dir.join(format!("{name}{suffix}")),
        ]
    };
    candidates.into_iter().find(|p| p.exists())
}

/// Resolve the JS runtime path that yt-dlp will use for YouTube's n-challenge
/// signature decoding. Without one, downloads fail with `Requested format is
/// not available` (only image-only formats remain).
///
/// Resolution order:
///  1. **Bundled node sidecar** — present in production installs; this is the
///     main path. Tauri renames the sidecar at build time to
///     `node-<target_triple>{.exe}` and drops it next to the main binary.
///  2. Common system paths (Homebrew on macOS, MSI install on Windows) —
///     pure dev convenience so `pnpm tauri dev` works without manually
///     copying the sidecar to `target/debug/`.
fn js_runtime_arg() -> Option<String> {
    if let Some(node) = sidecar_path("node") {
        return Some(format!("node:{}", node.to_string_lossy()));
    }
    let candidates: &[&str] = &[
        // macOS / Linux
        "/opt/homebrew/bin/node",  // Apple Silicon Homebrew
        "/usr/local/bin/node",      // Intel Homebrew / system
        "/usr/bin/node",
        "/opt/homebrew/bin/deno",
        "/usr/local/bin/deno",
        // Windows MSI install (typical npm install)
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Program Files (x86)\\nodejs\\node.exe",
    ];
    for path in candidates {
        if std::path::Path::new(path).exists() {
            // yt-dlp accepts "node:<path>" or "deno:<path>". Pick the right
            // runtime name based on the executable basename.
            let runtime = if path.contains("deno") { "deno" } else { "node" };
            return Some(format!("{runtime}:{path}"));
        }
    }
    None
}

/// Resolve the cookies file yt-dlp should use, honoring the user's
/// `cookieSource` choice in settings.json:
///
///   - "in-app"  ⇒ `<app_data>/yt-cookies.txt`     (written by youtube_auth)
///   - "file"    ⇒ user-picked `cookiesFile`        (legacy manual path)
///   - "none"    ⇒ no cookies                       (multi-line: most videos)
///   - missing   ⇒ legacy fallback: if `cookiesFile` is set + exists,
///                 use it (preserves pre-cookieSource user behaviour);
///                 otherwise treat as "none".
///
/// Returns None when the resolved file doesn't exist on disk — the
/// caller treats that as "no cookies" and skips the `--cookies` flag
/// entirely (yt-dlp would error if we passed a missing path).
fn read_cookies_file() -> Option<String> {
    let path = crate::core::paths::settings_path().ok()?;
    if !path.exists() {
        return resolve_legacy_cookies_file(None);
    }
    let raw = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;

    let source = v.get("cookieSource").and_then(|x| x.as_str());
    match source {
        Some("none") => None,
        Some("in-app") => {
            // Multi-site jar derives a Netscape cookies.txt at this
            // path on every save. If the user never logged into any
            // site (or wiped all logins), the file won't exist —
            // we fall through to no-cookies rather than silently
            // using a stale manual file.
            let p = crate::core::paths::cookies_txt_path().ok()?;
            if p.exists() {
                Some(p.to_string_lossy().into_owned())
            } else {
                None
            }
        }
        Some("file") | None => resolve_legacy_cookies_file(Some(&v)),
        _ => None,
    }
}

fn resolve_legacy_cookies_file(value: Option<&serde_json::Value>) -> Option<String> {
    let v = value?;
    let f = v.get("cookiesFile")?.as_str()?.trim();
    if f.is_empty() || !std::path::Path::new(f).exists() {
        return None;
    }
    Some(f.to_string())
}

#[derive(Debug)]
pub struct DownloadResult {
    pub video_path: String,
    pub thumb_path: String,
    pub title: String,
    pub duration_sec: f64,
}

/// Resolve the user-facing quality preset to a yt-dlp format selector.
///
/// Mac compatibility note: Tauri WebView on Mac uses WKWebView →
/// AVFoundation, which **hard-rejects Opus-in-MP4 and VP9-in-MP4**
/// (no "play anyway" prompt — the `<video>` tag just goes black).
/// QuickTime is more forgiving but still warns. To make in-app
/// playback Just Work on Mac, every tier preferentially picks
/// `avc1` (H.264) video + `m4a` (AAC) audio, both of which AVFoundation
/// hardware-decodes natively. The fallback chain progressively loosens
/// constraints for the rare videos that don't ship avc1+m4a.
///
/// `best` is capped at 1080p on purpose: YouTube only ships VP9/AV1 above
/// 1080p (no avc1), and even with audio remuxed to AAC the video stream
/// would still fail to play in WKWebView. Capping at 1080p keeps "原画"
/// meaningful while guaranteeing playback. Users who specifically want
/// 4K can re-encode externally.
fn yt_dlp_format(quality: &str) -> &'static str {
    match quality {
        "low" => "bv*[ext=mp4][vcodec^=avc1][height<=480]+ba[ext=m4a]\
                  /bv*[ext=mp4][height<=480]+ba[ext=m4a]\
                  /bv*[height<=480]+ba\
                  /best[height<=480]/best",
        "high" => "bv*[ext=mp4][vcodec^=avc1][height<=1080]+ba[ext=m4a]\
                   /bv*[ext=mp4][height<=1080]+ba[ext=m4a]\
                   /bv*[height<=1080]+ba\
                   /best[height<=1080]/best",
        "best" => "bv*[ext=mp4][vcodec^=avc1][height<=1080]+ba[ext=m4a]\
                   /bv*[ext=mp4][height<=1080]+ba[ext=m4a]\
                   /bv*[height<=1080]+ba\
                   /best[height<=1080]/best",
        // "standard" (720p) is the default — chosen because subtitle learning
        // doesn't need 1080p+ and 720p downloads are 2-4× faster on most
        // connections. Anything unrecognized also lands here.
        _ => "bv*[ext=mp4][vcodec^=avc1][height<=720]+ba[ext=m4a]\
              /bv*[ext=mp4][height<=720]+ba[ext=m4a]\
              /bv*[height<=720]+ba\
              /best[height<=720]/best",
    }
}

/// Download a video to `out_dir/source.mp4` and `out_dir/thumb.jpg`, plus info.json.
///
/// `background`: changes the retry strategy.
///   - false (foreground, user is watching the modal): tight budget,
///     fail fast. ~25-50s on a hard-unreachable network (no VPN) so
///     the user sees the actionable error dialog without staring at a
///     frozen-looking modal. Knobs: 5s socket-timeout, 1 retry per
///     request, 1 process attempt. See the inline comments around the
///     args block for the per-knob rationale.
///   - true (background, queued): patient budget. ~3 min total so
///     transient blips actually recover. 20s socket-timeout, 10
///     retries per request, 3 process attempts.
pub async fn download(
    app: &AppHandle,
    url: &str,
    out_dir: &Path,
    video_id: &str,
    quality: &str,
    background: bool,
    cancel: Option<&CancellationToken>,
) -> AppResult<DownloadResult> {
    std::fs::create_dir_all(out_dir)?;
    let video_path = out_dir.join("source.mp4").to_string_lossy().to_string();
    let thumb_path = out_dir.join("thumb.jpg").to_string_lossy().to_string();
    // yt-dlp's --write-info-json sidecar uses the SAME base name as the video,
    // appending `.info.json`. So with -o ".../source.mp4" the JSON ends up at
    // ".../source.info.json". Read from there — don't try to override its path
    // via -o "infojson:..." because that template gets a literal `.info.json`
    // suffix appended too, leading to `info.info.json` which is confusing.
    let info_path_actual = out_dir.join("source.info.json");

    // Closures and the `id`/`app` clones they capture live inside the retry
    // loop below — they need to be recreated each attempt because the
    // run_sidecar stderr callback takes them by value (move). Build the
    // arg list first (it's invariant across attempts), then loop.
    // Thumbnail is NOT requested from yt-dlp anymore. The classic
    // "--write-thumbnail" path hits a separate HTTPS connection to
    // i.ytimg.com (or each site's CDN) which gets reset by GFW on a
    // lot of Chinese networks — `EOF occurred in violation of
    // protocol (_ssl.c:1007)` after 10 retries → yt-dlp exits 1 even
    // when the video itself downloaded fine. Cosmetic file that just
    // happens to fail the whole import. After yt-dlp returns we
    // extract a frame from the local video via ffmpeg below; no
    // network involved, can't fail for this reason.

    let cookies = read_cookies_file();
    let mut args: Vec<String> = Vec::new();
    if let Some(c) = &cookies {
        args.push("--cookies".into());
        args.push(c.clone());
    }

    // ffmpeg is needed by yt-dlp to merge bv+ba streams into a single mp4.
    // The bundled sidecar isn't in $PATH, so point yt-dlp at it explicitly.
    // Without this, downloads fail with `ERROR: Preprocessing: ffmpeg not found`.
    if let Some(ffmpeg) = sidecar_path("ffmpeg") {
        args.push("--ffmpeg-location".into());
        args.push(ffmpeg.to_string_lossy().to_string());
    }

    // NOTE: yt-dlp doesn't have a `--ffprobe-location` flag; it expects
    // ffprobe to live next to the ffmpeg pointed at by --ffmpeg-location
    // and to be named bare `ffprobe`/`ffprobe.exe`. Our bundled ffprobe is
    // renamed to `ffprobe-<triple>` by Tauri's externalBin pipeline, so
    // yt-dlp can't auto-find it. Result: most YouTube downloads still
    // work (single-file streams don't need ffprobe); fragmented DASH
    // downloads will fail with "ffprobe not found". TODO: copy
    // ffprobe-<triple> → bare ffprobe name into a user-writable dir at
    // first run so yt-dlp can find it.

    // JS runtime — REQUIRED for YouTube. Without one, yt-dlp's n-challenge
    // solver fails and all real video formats become unavailable (only
    // image-only "formats" remain). We bundle node as a sidecar so this is
    // present in production; dev environment falls back to system paths.
    if let Some(js) = js_runtime_arg() {
        args.push("--js-runtimes".into());
        args.push(js);
    }

    // Route through the user's proxy (Clash / V2Ray) when one is resolved. On a
    // GFW machine YouTube is reachable only via the proxy; the installed app
    // (launched from the Start menu) doesn't inherit the shell's HTTP_PROXY, so
    // we pass it explicitly. None → direct. See core::proxy.
    if let Some(proxy) = crate::core::proxy::resolve_yt_dlp_proxy() {
        args.push("--proxy".into());
        args.push(proxy);
    }

    args.extend([
        // YouTube URLs frequently include &list=...&index=N when copied from a
        // playlist context. Without this flag yt-dlp would walk the WHOLE
        // playlist, repeatedly writing every video into the same source.mp4 +
        // thumb.jpg (hence the "Replacing existing file" spam) and bailing if
        // any single video in the list is unavailable. We only ever want the
        // one video the URL points at.
        "--no-playlist".into(),
        // Retry budget split by mode. Background imports retry
        // patiently (~3 min worst case) — the user isn't watching and
        // probably wants the download to keep trying through a flaky
        // network. Foreground imports MUST fail fast (~30s worst case)
        // so the user sees the "无法访问视频网站 / 挂梯子 / 配 cookies"
        // dialog quickly and can fix the root cause instead of staring
        // at a frozen-looking modal.
        //
        // Critical: `--retries` is PER HTTP REQUEST inside one yt-dlp
        // run, not a global budget. yt-dlp typically does 3-4 distinct
        // requests per download (webpage → player JS → format manifest
        // → stream); each one retries independently. Combined with
        // yt-dlp's default ~20s TCP connect timeout, foreground used
        // to wait ~2 min on a hard-unreachable network (no VPN). We
        // shrink both knobs:
        //   --socket-timeout 5  → 5s TCP connect (default ~20s)
        //   --retries        1  → 1 retry per request (default 10,
        //                          we used to set 3)
        // Worst-case per request now ≈ 2 × 5s + 1 × 2s sleep ≈ 12s;
        // 4 requests ≈ ~50s but cookies/banned/private errors are
        // deterministic and bubble after the first request, so the
        // common "no VPN" failure path returns in ~25s.
        "--socket-timeout".into(),
        if background { "20".into() } else { "5".into() },
        "--retries".into(),
        if background { "10".into() } else { "1".into() },
        "--fragment-retries".into(),
        if background { "10".into() } else { "1".into() },
        "--retry-sleep".into(),
        if background { "5".into() } else { "2".into() },
        // Resume from the .part on a re-spawn — this is what makes the stall
        // watchdog's kill-and-retry recover instead of restarting from 0.
        // (It's yt-dlp's default, but set it explicitly so a future default
        // flip can't silently break resume.)
        "--continue".into(),
        "-f".into(),
        yt_dlp_format(quality).into(),
        "--merge-output-format".into(),
        "mp4".into(),
        // Pure remux on merge — no audio re-encode. We used to force
        // `-c:a aac -b:a 192k` as a "belt + suspenders" for Mac WKWebView
        // (in case the format chain fell through to Opus-in-WebM audio),
        // but that backfired on YouTube uploads that ship 5.1 / 7.1
        // multichannel m4a: the AAC encoder didn't pass an explicit
        // channel layout, so the re-encoded stream's header declared one
        // layout while packets carried another → "channel element 1.0
        // is not allocated" on every packet during downstream WAV
        // extraction, ffmpeg exits 69 ("Conversion failed!"). Since
        // tiers 1+2 of yt_dlp_format already constrain `ba[ext=m4a]`
        // (= AAC) for >99% of videos, the transcode was never needed
        // there and only created risk. The rare tier-3/4 fall-through
        // with Opus audio on Mac is now a known soft limitation —
        // users can re-import at a different quality if hit.
        "--postprocessor-args".into(),
        "Merger:-c:v copy -c:a copy".into(),
        "-o".into(),
        video_path.clone(),
        // No `-o "infojson:..."` — let yt-dlp default to writing the JSON
        // next to the video file (out_dir/source.info.json).
        "--write-info-json".into(),
        "--newline".into(),
        // Pipe-separated so we can parse percent + total + speed + ETA in one
        // pass. Fields may be "NA" before yt-dlp has resolved sizes/speed.
        "--progress-template".into(),
        "[progress] %(progress._percent_str)s|%(progress._total_bytes_str)s|%(progress._speed_str)s|%(progress._eta_str)s".into(),
        url.into(),
    ]);
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    // Process-level retry around yt-dlp. The in-process --retries above
    // handles HTTP retries inside ONE yt-dlp run; this outer loop spawns
    // a fresh process when the FIRST one gives up, which is a different
    // recovery axis: new DNS resolution can land on a different IP /
    // POP, new TLS session can dodge a stuck handshake state, and the
    // n-challenge player JS gets re-fetched from scratch. Only retry
    // when stderr matches a known transient pattern (network / SSL /
    // CDN) — deterministic errors like cookies/banned/private are
    // bubbled immediately so the user isn't waiting for the
    // friendly-error dialog they already needed to see.
    //
    // Foreground: 1 attempt (no process retry). The in-process retries
    // already used ~10s. Punching through with 2 more process attempts
    // would just push total time to ~30s with no real recovery axis
    // beyond what yt-dlp itself tried. Better to fail fast and let the
    // user fix cookies / VPN.
    //
    // Background: 3 attempts × ~50s + 5s/10s backoff = ~3 min total.
    // Base process-level retries for hard errors (no-VPN etc.). Stalls get a
    // SEPARATE, larger budget (STALL_MAX_RETRIES): a stalled download resumes
    // from the .part each time (--continue) so progress accumulates — cheap to
    // retry, and the long-video hang is exactly this case. Applies even in
    // foreground (which otherwise fails fast) because resuming is the right call.
    let base_attempts: u32 = if background { 3 } else { 1 };
    const STALL_MAX_RETRIES: u32 = 5;
    let mut attempt: u32 = 0;
    let mut stall_retries: u32 = 0;
    loop {
        attempt += 1;

        let id_cb = video_id.to_string();
        let app_cb = app.clone();
        let id_log = video_id.to_string();
        let app_log = app.clone();
        let emit_log = move |line: &str| {
            for actual in line.lines() {
                let t = actual.trim();
                if t.is_empty() {
                    continue;
                }
                emit(
                    &app_log,
                    PipelineEvent::Log {
                        video_id: id_log.clone(),
                        source: "yt-dlp".into(),
                        line: t.into(),
                    },
                );
            }
        };

        // "准备中" sub-step tracker — emits Preparing events on detected
        // yt-dlp stderr patterns so the UI can show *which* part of the
        // ~30s preparation window is slow (webpage vs player JS vs
        // n-sig solver vs manifest). Stateful: each step is emitted at
        // most once per yt-dlp run so the UI doesn't churn.
        //
        // ALSO emits a redundant Log entry per substep so users with the
        // log panel expanded see the same info, AND so the trace remains
        // visible even if (somehow) the Preparing event handler isn't
        // wired — defensive given how many times "no logs at all" has
        // been reported.
        let id_step = video_id.to_string();
        let app_step = app.clone();
        let mut emitted_steps = std::collections::HashSet::<&'static str>::new();
        let mut emit_step = move |step: &'static str| {
            if !emitted_steps.insert(step) {
                return;
            }
            let label_zh = match step {
                "fetching-webpage" => "获取视频信息",
                "fetching-player" => "获取播放器",
                "solving-signature" => "解算签名 (常是最慢的一步)",
                "fetching-manifest" => "获取清晰度列表",
                "format-selected" => "格式已选,即将开始下载",
                _ => step,
            };
            emit(
                &app_step,
                PipelineEvent::Log {
                    video_id: id_step.clone(),
                    source: "whatsub".into(),
                    line: format!("准备中 → {label_zh}"),
                },
            );
            emit(
                &app_step,
                PipelineEvent::Preparing {
                    video_id: id_step.clone(),
                    step: step.into(),
                },
            );
        };

        // Stall watchdog progress counter — bumped on each parsed progress
        // line. The spawn loop arms a watchdog on it (once it first moves) and
        // kills + we resume if it stops advancing mid-download.
        let progress_count = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let progress_count_cb = progress_count.clone();
        // Common stderr callback for both the bundled-sidecar path and
        // the AppData-direct path. Defined here so it's identical in
        // semantics (logs / progress / sub-step detection).
        let callback = move |chunk: &str| {
            // run_sidecar hands us raw stderr CHUNKS (possibly
            // multi-line). emit_log already iterates `.lines()`
            // internally; parse_progress needs the same — its
            // strip_prefix("[progress] ") + split('|') logic only
            // works on a single line. Without this split, any
            // chunk that contains multiple progress updates fails
            // parsing and the entire batch of Downloading events
            // is lost, so the UI never leaves "准备中" until
            // ExtractingAudio fires.
            emit_log(chunk);
            for actual_line in chunk.lines() {
                if let Some(step) = detect_prepare_step(actual_line) {
                    emit_step(step);
                }
                if let Some(p) = parse_progress(actual_line) {
                    progress_count_cb.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    emit(
                        &app_cb,
                        PipelineEvent::Downloading {
                            video_id: id_cb.clone(),
                            percent: p.percent,
                            total: p.total,
                            speed: p.speed,
                            eta: p.eta,
                        },
                    );
                }
            }
        };

        // Prefer the user-updated AppData yt-dlp over the bundled
        // sidecar. This lets users react to YouTube extractor changes
        // (Settings → 更新 yt-dlp) without waiting for a whatsub
        // release. Fallback to shell-plugin sidecar when AppData copy
        // is absent (fresh install or never updated).
        //
        // Emit a "[whatsub] starting yt-dlp" marker BEFORE spawn so
        // users see immediate evidence the pipeline is running even
        // when yt-dlp itself is slow to produce stderr (some yt-dlp
        // versions are silent for 5-10s on first request — would look
        // like "stuck with no logs" otherwise).
        let appdata = resolve_appdata_yt_dlp();
        let source_label = match &appdata {
            Some(p) => format!("AppData ({})", p.display()),
            None => "内置版本".into(),
        };
        emit(
            app,
            PipelineEvent::Log {
                video_id: video_id.to_string(),
                source: "whatsub".into(),
                line: format!(
                    "启动 yt-dlp ({source_label}) — 后台={}, attempt={}",
                    background, attempt
                ),
            },
        );

        let result = if let Some(appdata_path) = appdata {
            run_external_with_callback(
                &appdata_path,
                &arg_refs,
                Some(progress_count.clone()),
                true,
                callback,
                cancel,
            )
            .await
        } else {
            run_sidecar_env(
                app,
                "yt-dlp",
                &arg_refs,
                &[],
                Some(progress_count.clone()),
                true,
                callback,
                cancel,
            )
            .await
        };

        match result {
            Ok(_) => break,
            Err(crate::error::AppError::Cancelled) => {
                // Cancellation propagates immediately — no retry, no
                // friendly-error mapping. The caller (import_video)
                // handles cleanup of partial files.
                return Err(crate::error::AppError::Cancelled);
            }
            Err(e) => {
                let msg = e.to_string();
                // A stall = the watchdog killed a hung yt-dlp. Recoverable by
                // resuming from the .part — give it its own larger budget,
                // regardless of foreground/background.
                if msg.contains("stalled") && stall_retries < STALL_MAX_RETRIES {
                    stall_retries += 1;
                    emit(
                        app,
                        PipelineEvent::Log {
                            video_id: video_id.to_string(),
                            source: "whatsub".into(),
                            line: format!(
                                "[whatsub] 下载卡住 — 从断点继续 (重试 {}/{})",
                                stall_retries, STALL_MAX_RETRIES
                            ),
                        },
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    continue;
                }
                if attempt < base_attempts && is_transient_yt_dlp_error(&msg) {
                    // Backoff between fresh-process attempts: 5s → 10s.
                    // Shorter than yt-dlp's own retry cycle so we don't
                    // double-wait, but long enough to give DNS / GFW
                    // state a chance to flip before re-running.
                    emit(
                        app,
                        PipelineEvent::Log {
                            video_id: video_id.to_string(),
                            source: "yt-dlp".into(),
                            line: format!(
                                "[whatsub] network hiccup — retry {}/{}",
                                attempt + 1,
                                base_attempts
                            ),
                        },
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(5 * attempt as u64))
                        .await;
                    continue;
                }
                return Err(e);
            }
        }
    }

    // Extract thumbnail from the just-downloaded local video via
    // ffmpeg. Bypasses yt-dlp's network-based thumbnail fetch (which
    // is what triggered the original SSL EOF spam on flaky networks).
    // Best-effort: if it fails we just don't have a thumbnail file,
    // which the UI handles gracefully — the import shouldn't fail
    // over a missing cosmetic asset.
    let video_pathbuf = std::path::PathBuf::from(&video_path);
    let thumb_pathbuf = std::path::PathBuf::from(&thumb_path);
    // `id` was moved into the run_sidecar closure above, so use the
    // original `video_id` arg (which is &str — copyable) for the
    // ffmpeg log emitter's video_id field.
    if let Err(e) = crate::pipeline::ffmpeg::extract_thumbnail(
        app,
        &video_pathbuf,
        &thumb_pathbuf,
        video_id,
        cancel,
    )
    .await
    {
        eprintln!("warn: ffmpeg thumbnail extraction failed: {e}");
    }

    // info.json may not exist if yt-dlp failed but we caught a soft failure;
    // gracefully fall back to a stub if missing.
    let (title, duration) = match std::fs::read_to_string(&info_path_actual) {
        Ok(raw) => {
            let info: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
            let t = info
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled")
                .to_string();
            let d = info.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
            (t, d)
        }
        Err(_) => ("Untitled".to_string(), 0.0),
    };

    Ok(DownloadResult {
        video_path,
        thumb_path,
        title,
        duration_sec: duration,
    })
}

/// Stderr-substring match for yt-dlp errors that are likely to succeed
/// on a fresh-process retry. Patterns target network / TLS / CDN
/// flakiness (the "works on 2nd try" cases). Deterministic failures
/// (cookies expired, video private/removed/age-gated, members-only,
/// bot-check) deliberately do NOT match — retrying those just wastes
/// the user's time before they see the actionable error dialog.
fn is_transient_yt_dlp_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    const TRANSIENT_FRAGMENTS: &[&str] = &[
        // Common GFW signature on TLS handshake to youtube.com / googlevideo:
        "eof occurred in violation of protocol",
        // Generic TLS / SSL errors:
        "ssl: ",
        "ssl error",
        "ssl_error",
        "certificate verify failed",
        // TCP-level resets / timeouts:
        "connection reset",
        "connection aborted",
        "connection timed out",
        "remote end closed connection",
        "read operation timed out",
        // yt-dlp's "couldn't grab the webpage" — matches both the
        // page-fetch failure ("Unable to download webpage") and the
        // final exit message ("Giving up after N retries").
        "unable to download webpage",
        "giving up after",
        // DNS hiccups:
        "getaddrinfo failed",
        "name or service not known",
        "temporary failure in name resolution",
        // yt-dlp's player-JS / n-challenge cache going stale —
        // a fresh process refetches the player, often resolves itself.
        "requested format is not available",
        "unable to extract",
        "nsig extraction failed",
        "player response not found",
    ];
    TRANSIENT_FRAGMENTS.iter().any(|p| lower.contains(p))
}

pub(crate) struct DownloadProgress {
    pub percent: u8,
    pub total: Option<String>,
    pub speed: Option<String>,
    pub eta: Option<String>,
}

/// Map a yt-dlp stderr line to a fine-grained "准备中" sub-step
/// identifier. None for lines that don't indicate a known phase
/// transition. Order matters: "n-sig" appears in lines also containing
/// "Downloading" so the signature check goes first.
fn detect_prepare_step(line: &str) -> Option<&'static str> {
    if line.contains("Downloading n-sig")
        || line.contains("signature deciphering")
        || line.contains("nsig solving")
    {
        Some("solving-signature")
    } else if line.contains("Downloading webpage") {
        Some("fetching-webpage")
    } else if line.contains("Downloading") && line.contains("player API") {
        Some("fetching-player")
    } else if line.contains("Downloading m3u8")
        || line.contains("Downloading MPD")
        || line.contains("Downloading format")
    {
        Some("fetching-manifest")
    } else if line.starts_with("[info]") && line.contains("Downloading 1 format") {
        Some("format-selected")
    } else {
        None
    }
}

fn parse_progress(line: &str) -> Option<DownloadProgress> {
    // Expected format from --progress-template:
    //   [progress] 42.3%|458.3MiB|1.2MiB/s|00:42
    // yt-dlp emits "NA" (or " NA " padded) for fields it can't compute yet.
    let trimmed = line.trim();
    let after = trimmed.strip_prefix("[progress] ")?;
    let mut parts = after.split('|');
    let pct_field = parts.next()?.trim();
    let total = parts.next().map(str::trim).map(str::to_string);
    let speed = parts.next().map(str::trim).map(str::to_string);
    let eta = parts.next().map(str::trim).map(str::to_string);

    let pct_str = pct_field.trim_end_matches('%').trim();
    let pct: f32 = pct_str.parse().ok()?;
    let percent = pct.clamp(0.0, 100.0) as u8;

    fn nullable(s: Option<String>) -> Option<String> {
        match s {
            Some(v) if !v.is_empty() && v != "NA" => Some(v),
            _ => None,
        }
    }

    Some(DownloadProgress {
        percent,
        total: nullable(total),
        speed: nullable(speed),
        eta: nullable(eta),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_progress_line() {
        let p = parse_progress("[progress] 42.3%|458.3MiB|1.2MiB/s|00:42").unwrap();
        assert_eq!(p.percent, 42);
        assert_eq!(p.total.as_deref(), Some("458.3MiB"));
        assert_eq!(p.speed.as_deref(), Some("1.2MiB/s"));
        assert_eq!(p.eta.as_deref(), Some("00:42"));
    }

    #[test]
    fn na_fields_become_none() {
        let p = parse_progress("[progress] 0.5%|NA|NA|NA").unwrap();
        assert_eq!(p.percent, 0);
        assert!(p.total.is_none());
        assert!(p.speed.is_none());
        assert!(p.eta.is_none());
    }

    #[test]
    fn rejects_non_progress_lines() {
        assert!(parse_progress("not a progress line").is_none());
        assert!(parse_progress("[download] 42.3% of 10.5MiB").is_none());
    }

    #[test]
    fn clamps_percent() {
        let p = parse_progress("[progress] 100.0%|x|x|x").unwrap();
        assert_eq!(p.percent, 100);
    }
}
