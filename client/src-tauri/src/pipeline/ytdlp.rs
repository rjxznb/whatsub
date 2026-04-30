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

/// Best-effort node lookup on macOS / Linux. yt-dlp v2026 wants a JS runtime
/// for full YouTube format support; without one it emits a warning but still
/// works for most videos. So this lookup is purely a "nice to have".
fn find_js_runtime() -> Option<(String, String)> {
    // (name, path) — name is what yt-dlp expects for --js-runtimes <name>:<path>
    let candidates = [
        ("node", "/opt/homebrew/bin/node"), // Apple Silicon Homebrew
        ("node", "/usr/local/bin/node"),    // Intel Homebrew / system
        ("node", "/usr/bin/node"),
        ("deno", "/opt/homebrew/bin/deno"),
        ("deno", "/usr/local/bin/deno"),
    ];
    for (name, path) in candidates {
        if std::path::Path::new(path).exists() {
            return Some((name.into(), path.into()));
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

    // JS runtime (best-effort). With one, YouTube extraction is fully reliable;
    // without one, yt-dlp emits a "no JS runtime" warning but most videos still
    // download. Skip the flag entirely if we can't find a runtime — passing
    // `--js-runtimes node` when node isn't installed anywhere doesn't help.
    if let Some((name, path)) = find_js_runtime() {
        args.push("--js-runtimes".into());
        args.push(format!("{name}:{path}"));
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
        "--progress-template".into(),
        "[download] %(progress._percent_str)s".into(),
        url.into(),
    ]);
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    run_sidecar(
        app,
        "yt-dlp",
        &arg_refs,
        move |line| {
            emit_log(line);
            if let Some(p) = parse_percent(line) {
                emit(
                    &app_clone,
                    PipelineEvent::Downloading {
                        video_id: id.clone(),
                        percent: p,
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

fn parse_percent(line: &str) -> Option<u8> {
    let stripped = line.trim();
    let pct_str = stripped.split('%').next()?.split_whitespace().last()?;
    let pct: f32 = pct_str.parse().ok()?;
    Some(pct.clamp(0.0, 100.0) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_percent_from_progress_line() {
        assert_eq!(parse_percent("[download]   42.3% of 10.5MiB"), Some(42));
        assert_eq!(parse_percent("[download] 100.0%"), Some(100));
        assert_eq!(parse_percent("not a progress line"), None);
    }
}
