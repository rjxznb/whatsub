use crate::core::progress::{emit, PipelineEvent};
use crate::error::AppResult;
use crate::pipeline::spawn::run_sidecar;
use std::path::Path;
use tauri::AppHandle;

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

    run_sidecar(
        app,
        "binaries/yt-dlp",
        &[
            "-f",
            "bv*[ext=mp4][height<=720]+ba/best[ext=mp4]/best",
            "--merge-output-format",
            "mp4",
            "-o",
            &video_path,
            "--write-thumbnail",
            "--convert-thumbnails",
            "jpg",
            "-o",
            &thumb_template,
            "--write-info-json",
            "-o",
            &info_template,
            "--newline",
            "--progress-template",
            "[download] %(progress._percent_str)s",
            url,
        ],
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
