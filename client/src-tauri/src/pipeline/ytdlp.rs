use crate::commands::yt_dlp::resolve_appdata_yt_dlp;
use crate::core::progress::{emit, PipelineEvent};
use crate::error::{AppError, AppResult};
use crate::pipeline::spawn::{
    run_external_with_callback, run_sidecar_env, OutputStream, StallPhase, StallWatch,
};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadMode {
    Foreground,
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadErrorKind {
    Stall,
    TransientNetwork,
    Deterministic,
    LocalDependency,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryLane {
    Base,
    NetworkResume,
    StallResume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryCleanup {
    PreserveAll,
    RemoveMergeOutputs,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct RetryCounters {
    base_retries: u32,
    network_resumes: u32,
    stall_resumes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RetryDecisionInput {
    mode: DownloadMode,
    ever_started: bool,
    stage: StallPhase,
    error: DownloadErrorKind,
    cancellation_requested: bool,
    can_cancel: bool,
    counters: RetryCounters,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryDecision {
    Stop,
    Retry {
        lane: RetryLane,
        retry_number: u32,
        delay: Duration,
        cleanup: RetryCleanup,
    },
}

fn classify_yt_dlp_error(error: &AppError) -> DownloadErrorKind {
    if matches!(error, AppError::Cancelled) {
        return DownloadErrorKind::Deterministic;
    }

    let message = error.to_string().to_lowercase();
    if message.contains("stalled") {
        return DownloadErrorKind::Stall;
    }

    if contains_non_retryable_http_4xx(&message) {
        return DownloadErrorKind::Deterministic;
    }

    const DETERMINISTIC: &[&str] = &[
        "unsupported url",
        "sign in to confirm you're not a bot",
        "sign in to confirm you’re not a bot",
        "cookies are no longer valid",
        "account cookies are no longer valid",
        "cookies have been invalidated",
        "cookie file has expired",
        "please refresh your cookies",
        "login required",
        "login is required",
        "this video is private",
        "private video",
        "this video has been removed",
        "removed by the user",
        "video unavailable",
        "members-only",
        "join this channel",
        "sign in to confirm your age",
        "age-restricted",
        "not available in your country",
        "geo restriction",
        "requested format is not available",
        "no video formats found",
        "only images are available",
        "unable to extract",
        "nsig extraction failed",
        "player response not found",
        "certificate verify failed",
        "http error 403",
    ];
    if DETERMINISTIC
        .iter()
        .any(|fragment| message.contains(fragment))
    {
        return DownloadErrorKind::Deterministic;
    }

    const LOCAL_DEPENDENCY: &[&str] = &[
        "ffmpeg not found",
        "ffprobe not found",
        "postprocessing:",
        "ffmpeg failed",
        "conversion failed",
        "error opening output",
        "no space left on device",
        "disk quota exceeded",
        "permission denied",
        "unable to rename file",
        "failed to spawn",
        "unable to spawn",
        "no such file or directory",
        "is not recognized as an internal or external command",
    ];
    if LOCAL_DEPENDENCY
        .iter()
        .any(|fragment| message.contains(fragment))
    {
        return DownloadErrorKind::LocalDependency;
    }

    const TRANSIENT: &[&str] = &[
        "eof occurred in violation of protocol",
        "ssl: ",
        "ssl error",
        "ssl_error",
        "connection reset",
        "connection aborted",
        "connection timed out",
        "remote end closed connection",
        "read operation timed out",
        "unable to download webpage",
        "giving up after",
        "getaddrinfo failed",
        "name or service not known",
        "temporary failure in name resolution",
        "connection refused",
        "network is unreachable",
        "no route to host",
        "tunnel connection failed",
        "proxy connection failed",
        "proxyconnect tcp",
        "winerror 10060",
        "winerror 10061",
        "winerror 10065",
        "http error 408",
        "http error 429",
        "http error 500",
        "http error 502",
        "http error 503",
        "http error 504",
        "fragment retries exhausted",
        "incomplete read",
        "broken pipe",
    ];
    if TRANSIENT.iter().any(|fragment| message.contains(fragment)) {
        DownloadErrorKind::TransientNetwork
    } else {
        DownloadErrorKind::Unknown
    }
}

fn contains_non_retryable_http_4xx(message: &str) -> bool {
    (400..500)
        .filter(|status| !matches!(status, 408 | 429))
        .any(|status| {
            message.contains(&format!("http error {status}"))
                || message.contains(&format!("http error: {status}"))
        })
}

fn resume_delay(retry_number: u32) -> Duration {
    let seconds = match retry_number {
        1 => 3,
        2 => 5,
        3 => 10,
        4 => 20,
        _ => 30,
    };
    Duration::from_secs(seconds)
}

fn decide_retry(input: RetryDecisionInput) -> RetryDecision {
    if input.cancellation_requested {
        return RetryDecision::Stop;
    }

    if matches!(
        input.error,
        DownloadErrorKind::Deterministic
            | DownloadErrorKind::LocalDependency
            | DownloadErrorKind::Unknown
    ) {
        return RetryDecision::Stop;
    }

    if !input.ever_started {
        if input.mode == DownloadMode::Background
            && input.error == DownloadErrorKind::TransientNetwork
            && input.counters.base_retries < 2
        {
            let retry_number = input.counters.base_retries + 1;
            return RetryDecision::Retry {
                lane: RetryLane::Base,
                retry_number,
                delay: Duration::from_secs(5 * retry_number as u64),
                cleanup: RetryCleanup::PreserveAll,
            };
        }
        return RetryDecision::Stop;
    }

    // Indefinite resume is only safe when the owning operation exposes a
    // cancellation token. Legacy cloud materialization currently has no
    // cancel UI, so bound that path instead of creating an immortal task.
    const UNCANCELLABLE_RESUME_LIMIT: u32 = 5;
    if !input.can_cancel {
        let completed = match input.error {
            DownloadErrorKind::TransientNetwork => input.counters.network_resumes,
            DownloadErrorKind::Stall => input.counters.stall_resumes,
            _ => 0,
        };
        if completed >= UNCANCELLABLE_RESUME_LIMIT {
            return RetryDecision::Stop;
        }
    }

    match input.error {
        DownloadErrorKind::TransientNetwork => {
            let retry_number = input.counters.network_resumes + 1;
            RetryDecision::Retry {
                lane: RetryLane::NetworkResume,
                retry_number,
                delay: resume_delay(retry_number),
                cleanup: RetryCleanup::PreserveAll,
            }
        }
        DownloadErrorKind::Stall => {
            let retry_number = input.counters.stall_resumes + 1;
            RetryDecision::Retry {
                lane: RetryLane::StallResume,
                retry_number,
                delay: resume_delay(retry_number),
                cleanup: if input.stage == StallPhase::Merging {
                    RetryCleanup::RemoveMergeOutputs
                } else {
                    RetryCleanup::PreserveAll
                },
            }
        }
        DownloadErrorKind::Deterministic
        | DownloadErrorKind::LocalDependency
        | DownloadErrorKind::Unknown => RetryDecision::Stop,
    }
}

#[derive(Debug)]
struct DownloadSession {
    ever_started: bool,
    last_stage: StallPhase,
    retries: RetryCounters,
    process_attempt: u32,
}

impl Default for DownloadSession {
    fn default() -> Self {
        Self {
            ever_started: false,
            last_stage: StallPhase::Preparing,
            retries: RetryCounters::default(),
            process_attempt: 0,
        }
    }
}

impl DownloadSession {
    fn observe_attempt(&mut self, stage: StallPhase) {
        self.last_stage = stage;
        if stage != StallPhase::Preparing {
            self.ever_started = true;
        }
    }

    fn record_retry(&mut self, lane: RetryLane) {
        match lane {
            RetryLane::Base => self.retries.base_retries += 1,
            RetryLane::NetworkResume => self.retries.network_resumes += 1,
            RetryLane::StallResume => self.retries.stall_resumes += 1,
        }
    }
}

fn apply_retry_cleanup(cleanup: RetryCleanup, output: &Path) -> AppResult<()> {
    if cleanup == RetryCleanup::RemoveMergeOutputs {
        for path in [merge_temp_path(output), output.to_path_buf()] {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(AppError::Other(format!(
                        "retry cleanup {}: {error}",
                        path.display()
                    )));
                }
            }
        }
    }
    Ok(())
}

fn ensure_not_cancelled(cancel: Option<&CancellationToken>) -> AppResult<()> {
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        Err(AppError::Cancelled)
    } else {
        Ok(())
    }
}

async fn wait_retry_delay(delay: Duration, cancel: Option<&CancellationToken>) -> AppResult<()> {
    match cancel {
        Some(token) => tokio::select! {
            biased;
            _ = token.cancelled() => Err(AppError::Cancelled),
            _ = tokio::time::sleep(delay) => Ok(()),
        },
        None => {
            tokio::time::sleep(delay).await;
            Ok(())
        }
    }
}

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
        "/opt/homebrew/bin/node", // Apple Silicon Homebrew
        "/usr/local/bin/node",    // Intel Homebrew / system
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
            let runtime = if path.contains("deno") {
                "deno"
            } else {
                "node"
            };
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
        "low" => {
            "bv*[ext=mp4][vcodec^=avc1][height<=480]+ba[ext=m4a]\
                  /bv*[ext=mp4][height<=480]+ba[ext=m4a]\
                  /bv*[height<=480]+ba[acodec^=mp4a]\
                  /best[height<=480]/best"
        }
        "high" => {
            "bv*[ext=mp4][vcodec^=avc1][height<=1080]+ba[ext=m4a]\
                   /bv*[ext=mp4][height<=1080]+ba[ext=m4a]\
                   /bv*[height<=1080]+ba[acodec^=mp4a]\
                   /best[height<=1080]/best"
        }
        "best" => {
            "bv*[ext=mp4][vcodec^=avc1][height<=1080]+ba[ext=m4a]\
                   /bv*[ext=mp4][height<=1080]+ba[ext=m4a]\
                   /bv*[height<=1080]+ba[acodec^=mp4a]\
                   /best[height<=1080]/best"
        }
        // "standard" (720p) is the default — chosen because subtitle learning
        // doesn't need 1080p+ and 720p downloads are 2-4× faster on most
        // connections. Anything unrecognized also lands here.
        _ => {
            "bv*[ext=mp4][vcodec^=avc1][height<=720]+ba[ext=m4a]\
              /bv*[ext=mp4][height<=720]+ba[ext=m4a]\
              /bv*[height<=720]+ba[acodec^=mp4a]\
              /best[height<=720]/best"
        }
    }
}

/// Download a video to `out_dir/source.mp4` and `out_dir/thumb.jpg`, plus info.json.
///
/// `background` changes only the pre-transfer retry budget. Foreground
/// imports fail fast while no bytes have moved; background imports get two
/// extra process attempts. Once any real progress or merge activity has
/// occurred, both modes preserve partial files and keep resuming transient
/// network/stall failures until success, cancellation, or a deterministic
/// failure (Cookie/login/private/unsupported/etc.).
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
        // there and only created risk.
        //
        // Tier 3 constrains the audio codec directly to MP4-compatible
        // AAC (`mp4a`). Merely excluding WebM is insufficient because a
        // different container can still carry a codec that the MP4 muxer
        // rejects with `-c:a copy`. If no compatible separate audio exists,
        // the selector falls through to a pre-merged `best` stream.
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

    // Process-level retry around yt-dlp. Before real transfer starts,
    // foreground gets no outer retry and background gets two. After progress
    // starts, `DownloadSession::ever_started` is sticky across respawns:
    // transient network failures and watchdog stalls use independent counters,
    // preserve yt-dlp resume artifacts, and back off 3/5/10/20/30... seconds
    // without a fixed retry maximum. Deterministic and local-dependency errors
    // always stop. Merge stalls remove only incomplete merge outputs so the
    // already-downloaded format streams can be merged again.
    let mode = if background {
        DownloadMode::Background
    } else {
        DownloadMode::Foreground
    };
    let mut session = DownloadSession::default();
    loop {
        ensure_not_cancelled(cancel)?;
        session.process_attempt += 1;

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

        // The watchdog observes parsed progress while downloading, then the
        // growing source.temp.mp4 once yt-dlp announces its ffmpeg merge phase.
        let progress_count = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let progress_count_cb = progress_count.clone();
        let stall_watch = StallWatch::with_download_and_merge_output(
            progress_count.clone(),
            out_dir.to_path_buf(),
            merge_temp_path(Path::new(&video_path)),
        );
        let stall_watch_cb = stall_watch.clone();
        let mut merge_start_detector = MergeStartDetector::default();
        let mut output_lines = OutputLineBuffer::default();
        // Common stderr callback for both the bundled-sidecar path and
        // the AppData-direct path. Defined here so it's identical in
        // semantics (logs / progress / sub-step detection).
        let callback = move |stream: OutputStream, chunk: &str| {
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
            if observe_merge_chunk(&mut merge_start_detector, stream, chunk) {
                stall_watch_cb.mark_merging();
            }
            for actual_line in output_lines.push(stream, chunk) {
                if let Some(step) = detect_prepare_step(&actual_line) {
                    emit_step(step);
                }
                if let Some(p) = parse_progress(&actual_line) {
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
                    background, session.process_attempt
                ),
            },
        );

        let runner_watch = stall_watch.clone();
        let result = if let Some(appdata_path) = appdata {
            run_external_with_callback(
                &appdata_path,
                &arg_refs,
                Some(runner_watch),
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
                Some(runner_watch),
                true,
                callback,
                cancel,
            )
            .await
        };

        session.observe_attempt(stall_watch.phase());
        match result {
            Ok(_) => break,
            Err(AppError::Cancelled) => {
                // Cancellation propagates immediately — no retry, no
                // friendly-error mapping. The caller (import_video)
                // handles cleanup of partial files.
                return Err(AppError::Cancelled);
            }
            Err(e) => {
                let decision = decide_retry(RetryDecisionInput {
                    mode,
                    ever_started: session.ever_started,
                    stage: session.last_stage,
                    error: classify_yt_dlp_error(&e),
                    cancellation_requested: cancel.is_some_and(CancellationToken::is_cancelled),
                    can_cancel: cancel.is_some(),
                    counters: session.retries,
                });
                let RetryDecision::Retry {
                    lane,
                    retry_number,
                    delay,
                    cleanup,
                } = decision
                else {
                    return Err(e);
                };

                session.record_retry(lane);
                apply_retry_cleanup(cleanup, Path::new(&video_path))?;
                let line = match lane {
                    RetryLane::Base => format!(
                        "[whatsub] 网络暂时不可用 — 后台重试 {retry_number}/2，{} 秒后重试",
                        delay.as_secs()
                    ),
                    RetryLane::NetworkResume => format!(
                        "[whatsub] 网络波动，正在断点续传（第 {retry_number} 次，{} 秒后重试）",
                        delay.as_secs()
                    ),
                    RetryLane::StallResume if session.last_stage == StallPhase::Merging => format!(
                        "[whatsub] 音视频合并卡住，正在重新合并（第 {retry_number} 次，{} 秒后重试）",
                        delay.as_secs()
                    ),
                    RetryLane::StallResume => format!(
                        "[whatsub] 下载卡住，正在断点续传（第 {retry_number} 次，{} 秒后重试）",
                        delay.as_secs()
                    ),
                };
                emit(
                    app,
                    PipelineEvent::Log {
                        video_id: video_id.to_string(),
                        source: "whatsub".into(),
                        line: line.clone(),
                    },
                );
                if lane != RetryLane::Base {
                    emit(
                        app,
                        PipelineEvent::Retrying {
                            video_id: video_id.to_string(),
                            attempt: retry_number,
                            delay_sec: delay.as_secs(),
                            message: line.strip_prefix("[whatsub] ").unwrap_or(&line).to_string(),
                        },
                    );
                }
                wait_retry_delay(delay, cancel).await?;
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
            let info: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
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

/// yt-dlp's stable machine prefix for the start of an ffmpeg merge. The
/// output path and quoting differ by platform, so neither is part of the
/// match contract.
fn is_merge_start_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with("[Merger]") && trimmed.contains("Merging formats into")
}

/// Match yt-dlp's `prepend_extension(filename, "temp")` naming used by
/// `FFmpegMergerPP`: `source.mp4` becomes `source.temp.mp4`.
fn merge_temp_path(output: &Path) -> PathBuf {
    let mut extension = std::ffi::OsString::from("temp");
    if let Some(original) = output.extension() {
        extension.push(".");
        extension.push(original);
    }
    output.with_extension(extension)
}

#[derive(Default)]
struct MergeStartDetector {
    pending: String,
}

impl MergeStartDetector {
    fn push(&mut self, chunk: &str) -> bool {
        self.pending.push_str(chunk);

        while let Some(newline) = self.pending.find('\n') {
            let line = self.pending[..newline].to_string();
            self.pending.drain(..=newline);
            if is_merge_start_line(&line) {
                return true;
            }
        }

        if is_merge_start_line(&self.pending) {
            self.pending.clear();
            return true;
        }

        const MAX_PENDING_BYTES: usize = 512;
        if self.pending.len() > MAX_PENDING_BYTES {
            let mut keep_from = self.pending.len() - MAX_PENDING_BYTES;
            while !self.pending.is_char_boundary(keep_from) {
                keep_from += 1;
            }
            self.pending.drain(..keep_from);
        }
        false
    }
}

fn observe_merge_chunk(
    detector: &mut MergeStartDetector,
    stream: OutputStream,
    chunk: &str,
) -> bool {
    stream == OutputStream::Stdout && detector.push(chunk)
}

pub(crate) struct DownloadProgress {
    pub percent: u8,
    pub total: Option<String>,
    pub speed: Option<String>,
    pub eta: Option<String>,
}

#[derive(Default)]
struct OutputLineBuffer {
    stdout: String,
    stderr: String,
}

impl OutputLineBuffer {
    fn push(&mut self, stream: OutputStream, chunk: &str) -> Vec<String> {
        let pending = match stream {
            OutputStream::Stdout => &mut self.stdout,
            OutputStream::Stderr => &mut self.stderr,
        };
        pending.push_str(chunk);
        let mut lines = Vec::new();
        while let Some(newline) = pending.find('\n') {
            let line = pending[..newline].trim_end_matches('\r').to_string();
            pending.drain(..=newline);
            lines.push(line);
        }

        // yt-dlp lines are normally tiny. Bound malformed/no-newline output
        // so a child cannot grow this parser buffer without limit.
        const MAX_PENDING_BYTES: usize = 64 * 1024;
        if pending.len() > MAX_PENDING_BYTES {
            lines.push(std::mem::take(pending));
        }
        lines
    }
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

    fn retry_input(
        mode: DownloadMode,
        ever_started: bool,
        stage: StallPhase,
        error: DownloadErrorKind,
        counters: RetryCounters,
    ) -> RetryDecisionInput {
        RetryDecisionInput {
            mode,
            ever_started,
            stage,
            error,
            cancellation_requested: false,
            can_cancel: true,
            counters,
        }
    }

    #[test]
    fn foreground_zero_progress_transient_stops() {
        assert_eq!(
            decide_retry(retry_input(
                DownloadMode::Foreground,
                false,
                StallPhase::Preparing,
                DownloadErrorKind::TransientNetwork,
                RetryCounters::default(),
            )),
            RetryDecision::Stop,
        );
    }

    #[test]
    fn background_zero_progress_uses_two_base_retries() {
        for completed in 0..2 {
            assert!(matches!(
                decide_retry(retry_input(
                    DownloadMode::Background,
                    false,
                    StallPhase::Preparing,
                    DownloadErrorKind::TransientNetwork,
                    RetryCounters {
                        base_retries: completed,
                        ..RetryCounters::default()
                    },
                )),
                RetryDecision::Retry {
                    lane: RetryLane::Base,
                    ..
                }
            ));
        }
        assert_eq!(
            decide_retry(retry_input(
                DownloadMode::Background,
                false,
                StallPhase::Preparing,
                DownloadErrorKind::TransientNetwork,
                RetryCounters {
                    base_retries: 2,
                    ..RetryCounters::default()
                },
            )),
            RetryDecision::Stop,
        );
    }

    #[test]
    fn cookie_error_stops_even_after_download_started() {
        let error = crate::error::AppError::Subprocess(
            "Sign in to confirm you're not a bot; unable to download webpage".into(),
        );
        assert_eq!(
            classify_yt_dlp_error(&error),
            DownloadErrorKind::Deterministic
        );
        assert_eq!(
            decide_retry(retry_input(
                DownloadMode::Foreground,
                true,
                StallPhase::Downloading,
                classify_yt_dlp_error(&error),
                RetryCounters::default(),
            )),
            RetryDecision::Stop,
        );
    }

    #[test]
    fn removed_video_stops_even_after_download_started() {
        let error = crate::error::AppError::Subprocess("This video has been removed".into());
        assert_eq!(
            classify_yt_dlp_error(&error),
            DownloadErrorKind::Deterministic
        );
    }

    #[test]
    fn requested_format_is_deterministic() {
        let error =
            crate::error::AppError::Subprocess("ERROR: Requested format is not available".into());
        assert_eq!(
            classify_yt_dlp_error(&error),
            DownloadErrorKind::Deterministic
        );
    }

    #[test]
    fn local_postprocessing_error_wins_over_broken_pipe_text() {
        let error = crate::error::AppError::Subprocess(
            "ERROR: Postprocessing: ffmpeg failed while writing output: Broken pipe".into(),
        );
        assert_eq!(
            classify_yt_dlp_error(&error),
            DownloadErrorKind::LocalDependency
        );
        assert_eq!(
            decide_retry(retry_input(
                DownloadMode::Foreground,
                true,
                StallPhase::Merging,
                classify_yt_dlp_error(&error),
                RetryCounters::default(),
            )),
            RetryDecision::Stop,
        );
    }

    #[test]
    fn started_connection_reset_uses_network_resume() {
        let error = crate::error::AppError::Subprocess("connection reset by peer".into());
        assert_eq!(
            classify_yt_dlp_error(&error),
            DownloadErrorKind::TransientNetwork
        );
        assert!(matches!(
            decide_retry(retry_input(
                DownloadMode::Foreground,
                true,
                StallPhase::Downloading,
                classify_yt_dlp_error(&error),
                RetryCounters::default(),
            )),
            RetryDecision::Retry {
                lane: RetryLane::NetworkResume,
                retry_number: 1,
                cleanup: RetryCleanup::PreserveAll,
                ..
            }
        ));
    }

    #[test]
    fn common_proxy_and_socket_failures_are_transient() {
        for message in [
            "Connection refused",
            "Network is unreachable",
            "No route to host",
            "Tunnel connection failed: 502 Bad Gateway",
            "WinError 10061",
        ] {
            let error = crate::error::AppError::Subprocess(message.into());
            assert_eq!(
                classify_yt_dlp_error(&error),
                DownloadErrorKind::TransientNetwork,
                "{message}"
            );
        }
    }

    #[test]
    fn certificate_extractor_and_non_retryable_http_errors_stop() {
        for message in [
            "certificate verify failed",
            "nsig extraction failed",
            "player response not found",
            "HTTP Error 404: Not Found; unable to download webpage",
        ] {
            let error = crate::error::AppError::Subprocess(message.into());
            assert!(
                matches!(
                    classify_yt_dlp_error(&error),
                    DownloadErrorKind::Deterministic | DownloadErrorKind::LocalDependency
                ),
                "{message}"
            );
        }
    }

    #[test]
    fn uncancellable_started_download_has_a_finite_resume_budget() {
        let mut input = retry_input(
            DownloadMode::Background,
            true,
            StallPhase::Downloading,
            DownloadErrorKind::TransientNetwork,
            RetryCounters {
                network_resumes: 5,
                ..RetryCounters::default()
            },
        );
        input.can_cancel = false;
        assert_eq!(decide_retry(input), RetryDecision::Stop);
    }

    #[test]
    fn started_stall_uses_stall_resume() {
        let error = crate::error::AppError::Subprocess("yt-dlp stalled".into());
        assert_eq!(classify_yt_dlp_error(&error), DownloadErrorKind::Stall);
        assert!(matches!(
            decide_retry(retry_input(
                DownloadMode::Foreground,
                true,
                StallPhase::Merging,
                classify_yt_dlp_error(&error),
                RetryCounters::default(),
            )),
            RetryDecision::Retry {
                lane: RetryLane::StallResume,
                cleanup: RetryCleanup::RemoveMergeOutputs,
                ..
            }
        ));
    }

    #[test]
    fn network_and_stall_counters_are_independent() {
        let counters = RetryCounters {
            network_resumes: 4,
            stall_resumes: 7,
            ..RetryCounters::default()
        };
        assert!(matches!(
            decide_retry(retry_input(
                DownloadMode::Foreground,
                true,
                StallPhase::Downloading,
                DownloadErrorKind::TransientNetwork,
                counters,
            )),
            RetryDecision::Retry {
                retry_number: 5,
                ..
            }
        ));
        assert!(matches!(
            decide_retry(retry_input(
                DownloadMode::Foreground,
                true,
                StallPhase::Downloading,
                DownloadErrorKind::Stall,
                counters,
            )),
            RetryDecision::Retry {
                retry_number: 8,
                ..
            }
        ));
    }

    #[test]
    fn resume_backoff_is_3_5_10_20_then_30() {
        let expected = [3, 5, 10, 20, 30, 30];
        for (completed, seconds) in expected.into_iter().enumerate() {
            assert!(matches!(
                decide_retry(retry_input(
                    DownloadMode::Foreground,
                    true,
                    StallPhase::Downloading,
                    DownloadErrorKind::TransientNetwork,
                    RetryCounters {
                        network_resumes: completed as u32,
                        ..RetryCounters::default()
                    },
                )),
                RetryDecision::Retry { delay, .. }
                    if delay == std::time::Duration::from_secs(seconds)
            ));
        }
    }

    #[test]
    fn resume_has_no_fixed_retry_limit() {
        assert!(matches!(
            decide_retry(retry_input(
                DownloadMode::Foreground,
                true,
                StallPhase::Downloading,
                DownloadErrorKind::TransientNetwork,
                RetryCounters {
                    network_resumes: 50_000,
                    ..RetryCounters::default()
                },
            )),
            RetryDecision::Retry {
                retry_number: 50_001,
                ..
            }
        ));
    }

    #[test]
    fn cancellation_precedes_every_other_decision() {
        let mut input = retry_input(
            DownloadMode::Background,
            true,
            StallPhase::Merging,
            DownloadErrorKind::TransientNetwork,
            RetryCounters::default(),
        );
        input.cancellation_requested = true;
        assert_eq!(decide_retry(input), RetryDecision::Stop);
    }

    #[test]
    fn progress_makes_ever_started_sticky() {
        let mut session = DownloadSession::default();
        session.observe_attempt(StallPhase::Downloading);
        assert!(session.ever_started);
        assert_eq!(session.last_stage, StallPhase::Downloading);
    }

    #[test]
    fn merging_makes_ever_started_sticky() {
        let mut session = DownloadSession::default();
        session.observe_attempt(StallPhase::Merging);
        assert!(session.ever_started);
        assert_eq!(session.last_stage, StallPhase::Merging);
    }

    #[test]
    fn later_preparing_attempt_does_not_clear_ever_started() {
        let mut session = DownloadSession::default();
        session.observe_attempt(StallPhase::Downloading);
        session.observe_attempt(StallPhase::Preparing);
        assert!(session.ever_started);
        assert_eq!(session.last_stage, StallPhase::Preparing);
    }

    fn retry_cleanup_fixture(name: &str) -> (PathBuf, Vec<PathBuf>) {
        let dir = unique_temp_dir(name);
        std::fs::create_dir_all(&dir).unwrap();
        let paths = [
            "source.mp4",
            "source.temp.mp4",
            "source.f137.mp4",
            "source.f140.m4a",
            "source.f137.mp4.part",
            "source.ytdl",
            "fragment.part-Frag42",
        ]
        .into_iter()
        .map(|name| dir.join(name))
        .collect::<Vec<_>>();
        for path in &paths {
            std::fs::write(path, b"fixture").unwrap();
        }
        (dir, paths)
    }

    #[test]
    fn download_retry_preserves_all_partial_files() {
        let (dir, paths) = retry_cleanup_fixture("preserve-all");
        apply_retry_cleanup(RetryCleanup::PreserveAll, &dir.join("source.mp4")).unwrap();
        assert!(paths.iter().all(|path| path.exists()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn merge_retry_removes_only_merge_outputs() {
        let (dir, paths) = retry_cleanup_fixture("merge-only");
        apply_retry_cleanup(RetryCleanup::RemoveMergeOutputs, &dir.join("source.mp4")).unwrap();
        assert!(!paths[0].exists());
        assert!(!paths[1].exists());
        assert!(paths[2..].iter().all(|path| path.exists()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn cancellation_interrupts_thirty_second_backoff() {
        let token = CancellationToken::new();
        token.cancel();
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            wait_retry_delay(Duration::from_secs(30), Some(&token)),
        )
        .await
        .expect("cancelled backoff must return immediately");
        assert!(matches!(result, Err(AppError::Cancelled)));
    }

    fn unique_temp_dir(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "whatsub-ytdlp-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn detects_yt_dlp_merger_start() {
        assert!(is_merge_start_line(
            "[Merger] Merging formats into \"source.mp4\""
        ));
        assert!(!is_merge_start_line("[download] 100% of 42MiB"));
        assert!(!is_merge_start_line(
            "[Merger] Fixing MPEG-TS in MP4 container of source.mp4"
        ));
    }

    #[test]
    fn detects_merger_start_split_across_output_chunks() {
        let mut detector = MergeStartDetector::default();
        assert!(!detector.push("[download] 100%\n[Merger] Merg"));
        assert!(detector.push("ing formats into \"source.mp4\"\n"));
    }

    #[test]
    fn stderr_does_not_corrupt_split_stdout_merger_line() {
        let mut detector = MergeStartDetector::default();
        assert!(!observe_merge_chunk(
            &mut detector,
            OutputStream::Stdout,
            "[Merger] Merg"
        ));
        assert!(!observe_merge_chunk(
            &mut detector,
            OutputStream::Stderr,
            "WARNING: unrelated stderr\n"
        ));
        assert!(observe_merge_chunk(
            &mut detector,
            OutputStream::Stdout,
            "ing formats into \"source.mp4\"\n"
        ));
    }

    #[test]
    fn merge_temp_path_matches_yt_dlp_prepend_extension() {
        assert_eq!(
            merge_temp_path(Path::new("downloads/source.mp4")),
            PathBuf::from("downloads/source.temp.mp4")
        );
        assert_eq!(
            merge_temp_path(Path::new("downloads/source")),
            PathBuf::from("downloads/source.temp")
        );
    }

    #[test]
    fn all_quality_formats_require_mp4_compatible_separate_audio() {
        for quality in ["low", "standard", "high", "best"] {
            let format = yt_dlp_format(quality);
            assert!(
                !format.contains("ext!=webm"),
                "{quality} still relies on a container exclusion: {format}"
            );
            for term in format.split('/') {
                if term.contains("+ba") {
                    assert!(
                        term.contains("ba[ext=m4a]") || term.contains("ba[acodec^=mp4a]"),
                        "{quality} has an unconstrained separate-audio term: {term}"
                    );
                }
            }
        }
    }

    #[test]
    fn parses_full_progress_line() {
        let p = parse_progress("[progress] 42.3%|458.3MiB|1.2MiB/s|00:42").unwrap();
        assert_eq!(p.percent, 42);
        assert_eq!(p.total.as_deref(), Some("458.3MiB"));
        assert_eq!(p.speed.as_deref(), Some("1.2MiB/s"));
        assert_eq!(p.eta.as_deref(), Some("00:42"));
    }

    #[test]
    fn buffers_progress_lines_split_across_process_reads() {
        let mut lines = OutputLineBuffer::default();

        assert!(lines
            .push(OutputStream::Stdout, "[progress] 42.3%|458.3")
            .is_empty());
        let completed = lines.push(OutputStream::Stdout, "MiB|1.2MiB/s|00:42\r\n");

        assert_eq!(completed, vec!["[progress] 42.3%|458.3MiB|1.2MiB/s|00:42"]);
        assert_eq!(parse_progress(&completed[0]).unwrap().percent, 42);
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
