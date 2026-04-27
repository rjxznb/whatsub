use crate::core::progress::{emit, PipelineEvent};
use crate::error::AppResult;
use crate::pipeline::spawn::run_sidecar;
use std::path::Path;
use tauri::AppHandle;

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
    let info_path = out_dir.join("info.json").to_string_lossy().to_string();

    let id = video_id.to_string();
    let app_clone = app.clone();
    let thumb_template = format!("thumbnail:{}", thumb_path.trim_end_matches(".jpg"));
    let info_template = format!("infojson:{}", info_path.trim_end_matches(".json"));

    let cookies = read_cookies_file();
    let mut args: Vec<String> = Vec::new();
    if let Some(c) = &cookies {
        args.push("--cookies".into());
        args.push(c.clone());
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
        "--write-info-json".into(),
        "-o".into(),
        info_template.clone(),
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
        |line| {
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

    let info: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&info_path)?)?;
    let title = info
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let duration = info.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);

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
