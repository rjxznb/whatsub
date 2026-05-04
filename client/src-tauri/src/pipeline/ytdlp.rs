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

fn read_cookies_file() -> Option<String> {
    let path = crate::core::paths::settings_path().ok()?;
    if !path.exists() {
        return None;
    }
    let raw = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
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

/// Download a video to `out_dir/source.mp4` and `out_dir/thumb.jpg`, plus info.json.
pub async fn download(
    app: &AppHandle,
    url: &str,
    out_dir: &Path,
    video_id: &str,
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
    let thumb_template = format!("thumbnail:{}", thumb_path.trim_end_matches(".jpg"));

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
        "-f".into(),
        "bv*[ext=mp4][height<=720]+ba/best[ext=mp4]/best".into(),
        "--merge-output-format".into(),
        "mp4".into(),
        "-o".into(),
        video_path.clone(),
        "--write-thumbnail".into(),
        "--convert-thumbnails".into(),
        "jpg".into(),
        "-o".into(),
        thumb_template.clone(),
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
