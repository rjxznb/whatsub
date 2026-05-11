use crate::core::progress::{emit, PipelineEvent};
use crate::error::AppResult;
use crate::pipeline::spawn::run_sidecar;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

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
pub async fn download(
    app: &AppHandle,
    url: &str,
    out_dir: &Path,
    video_id: &str,
    quality: &str,
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

    let id = video_id.to_string();
    let app_clone = app.clone();
    let id_for_log = video_id.to_string();
    let app_for_log = app.clone();
    let emit_log = move |line: &str| {
        for actual in line.lines() {
            let t = actual.trim();
            if t.is_empty() {
                continue;
            }
            emit(
                &app_for_log,
                PipelineEvent::Log {
                    video_id: id_for_log.clone(),
                    source: "yt-dlp".into(),
                    line: t.into(),
                },
            );
        }
    };
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

    args.extend([
        // YouTube URLs frequently include &list=...&index=N when copied from a
        // playlist context. Without this flag yt-dlp would walk the WHOLE
        // playlist, repeatedly writing every video into the same source.mp4 +
        // thumb.jpg (hence the "Replacing existing file" spam) and bailing if
        // any single video in the list is unavailable. We only ever want the
        // one video the URL points at.
        "--no-playlist".into(),
        "-f".into(),
        yt_dlp_format(quality).into(),
        "--merge-output-format".into(),
        "mp4".into(),
        // Belt + suspenders for Mac WKWebView playback: even if the format
        // selector falls through to a non-m4a audio stream (rare — old uploads
        // missing AAC tracks), force-transcode the audio to AAC during the
        // merge step so the resulting mp4 plays in AVFoundation. Video stream
        // is still copied (`-c:v copy`) so no re-encoding cost there. Audio
        // re-encode is tiny (a few seconds for a 10-minute video).
        "--postprocessor-args".into(),
        "Merger:-c:v copy -c:a aac -b:a 192k".into(),
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

    run_sidecar(
        app,
        "yt-dlp",
        &arg_refs,
        move |line| {
            emit_log(line);
            if let Some(p) = parse_progress(line) {
                emit(
                    &app_clone,
                    PipelineEvent::Downloading {
                        video_id: id.clone(),
                        percent: p.percent,
                        total: p.total,
                        speed: p.speed,
                        eta: p.eta,
                    },
                );
            }
        },
    )
    .await?;

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

pub(crate) struct DownloadProgress {
    pub percent: u8,
    pub total: Option<String>,
    pub speed: Option<String>,
    pub eta: Option<String>,
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
