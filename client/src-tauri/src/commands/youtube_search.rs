//! YouTube search via yt-dlp's `ytsearchN:` mode.
//!
//! Exposes a single Tauri command (`youtube_search`) the AI agent calls
//! to discover videos by topic. Uses the same yt-dlp resolution priority
//! as `pipeline::ytdlp::download()` — AppData copy (user-updated via
//! Settings → 更新 yt-dlp) first, bundled sidecar fallback — but invokes
//! a much narrower subset of flags: no download, just `--flat-playlist
//! --dump-json` so each result is one JSON object on stdout.
//!
//! Security boundary (spec §3.7.5): the only yt-dlp mode this command
//! ever uses is `ytsearchN:<query>` — never a raw URL. Results are
//! filtered to youtube.com domains as a defense-in-depth measure before
//! returning to the caller.

use crate::commands::yt_dlp::resolve_appdata_yt_dlp;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;
use tokio::process::Command;
use tokio::time::timeout;

/// Hard ceiling for a single search. yt-dlp's `--socket-timeout` only bounds
/// individual socket ops, NOT the overall run — on a machine that can't reach
/// YouTube (GFW / no proxy / DNS black hole) the process can hang far longer
/// than the user is willing to wait, freezing the AI tool call indefinitely.
const SEARCH_TIMEOUT_SECS: u64 = 45;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct YouTubeSearchHit {
    pub id: String,
    pub title: String,
    pub channel: Option<String>,
    #[serde(rename = "durationSec")]
    pub duration_sec: Option<u32>,
    #[serde(rename = "viewCount")]
    pub view_count: Option<u64>,
    pub url: String,
}

/// Pure-fn: parse yt-dlp's `--dump-json` stdout into structured hits.
///
/// Each non-empty line is expected to be one JSON object describing a
/// single video. Lines that fail to parse, have no `id`, or yield a URL
/// outside `https://www.youtube.com/` are silently dropped (the latter
/// is the §3.7.5 domain filter; should never trigger in practice since
/// `ytsearch` only returns YouTube videos, but cheap belt-and-suspenders).
pub fn parse_search_output(stdout: &str) -> Vec<YouTubeSearchHit> {
    let mut hits = Vec::new();
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(json) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let id = json["id"].as_str().unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let url = format!("https://www.youtube.com/watch?v={}", id);
        // Defense in depth — should always start with the YouTube domain
        // because we construct it ourselves, but guard anyway.
        if !url.starts_with("https://www.youtube.com/") {
            continue;
        }
        hits.push(YouTubeSearchHit {
            id,
            title: json["title"].as_str().unwrap_or("").to_string(),
            channel: json["channel"]
                .as_str()
                .or_else(|| json["uploader"].as_str())
                .map(String::from),
            duration_sec: json["duration"].as_f64().map(|d| d.max(0.0) as u32),
            view_count: json["view_count"].as_u64(),
            url,
        });
    }
    hits
}

/// Resolve the bundled yt-dlp sidecar path (mirrors the
/// `sidecar_path("yt-dlp")` logic in `pipeline::ytdlp::sidecar_path`,
/// kept local to avoid a cross-module dependency that would force a
/// pub-visibility bump).
fn bundled_yt_dlp_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let suffix = std::env::consts::EXE_SUFFIX;
    let target_triple: &str = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
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
    let candidates: [PathBuf; 2] = if target_triple.is_empty() {
        [dir.join(format!("yt-dlp{suffix}")), dir.join("yt-dlp")]
    } else {
        [
            dir.join(format!("yt-dlp-{target_triple}{suffix}")),
            dir.join(format!("yt-dlp{suffix}")),
        ]
    };
    candidates.into_iter().find(|p| p.exists())
}

/// Resolution priority matches `pipeline::ytdlp::download()`:
/// 1. `<app_data>/bin/yt-dlp{.exe}` — user-updated copy from Settings.
/// 2. Bundled sidecar (`binaries/yt-dlp-<triple>{.exe}`) next to the main
///    executable after Tauri's build-time rename.
fn resolve_yt_dlp_path(_app: &AppHandle) -> AppResult<PathBuf> {
    if let Some(p) = resolve_appdata_yt_dlp() {
        return Ok(p);
    }
    if let Some(p) = bundled_yt_dlp_path() {
        return Ok(p);
    }
    Err(AppError::NotFound(
        "yt-dlp 不可用 (AppData + 内置都未找到)。请打开 Settings → 更新 yt-dlp。".into(),
    ))
}

#[tauri::command]
pub async fn youtube_search(
    app: AppHandle,
    query: String,
    limit: Option<u32>,
) -> AppResult<Vec<YouTubeSearchHit>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("query 为空".into()));
    }
    let n = limit.unwrap_or(10).clamp(1, 20);
    let yt_dlp_path = resolve_yt_dlp_path(&app)?;
    let search_query = format!("ytsearch{}:{}", n, trimmed);
    let mut cmd = Command::new(&yt_dlp_path);
    cmd.arg(&search_query)
        .arg("--flat-playlist")
        .arg("--dump-json")
        .arg("--no-warnings")
        .arg("--no-playlist")
        .arg("--socket-timeout")
        .arg("10")
        .arg("--retries")
        .arg("2")
        .arg("--no-call-home")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // If the timeout below fires, the wait_with_output() future is dropped,
        // which drops the Child — kill_on_drop then reaps the yt-dlp process so
        // a hung search doesn't linger after we've already returned an error.
        .kill_on_drop(true);
    let child = cmd
        .spawn()
        .map_err(|e| AppError::Subprocess(format!("yt-dlp spawn failed: {}", e)))?;
    let output = match timeout(
        Duration::from_secs(SEARCH_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    {
        Ok(res) => res.map_err(|e| AppError::Subprocess(format!("yt-dlp wait failed: {}", e)))?,
        Err(_) => {
            return Err(AppError::Subprocess(format!(
                "YouTube 搜索超时（{} 秒未返回）。常见原因：当前网络无法访问 YouTube（需要科学上网），或 yt-dlp 需要在「设置 → 更新 yt-dlp」里更新。",
                SEARCH_TIMEOUT_SECS
            )));
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Subprocess(format!(
            "yt-dlp exited {}: {}",
            output.status, stderr
        )));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_search_output(&stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_one_hit() {
        let stdout = r#"{"id":"abc123","title":"NHS GP basics","channel":"WhatsubDemo","duration":543,"view_count":12000}"#;
        let hits = parse_search_output(stdout);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "abc123");
        assert_eq!(hits[0].title, "NHS GP basics");
        assert_eq!(hits[0].channel.as_deref(), Some("WhatsubDemo"));
        assert_eq!(hits[0].duration_sec, Some(543));
        assert_eq!(hits[0].url, "https://www.youtube.com/watch?v=abc123");
    }

    #[test]
    fn parses_multiple_hits_skipping_invalid_lines() {
        let stdout = r#"{"id":"a","title":"A"}
not valid json
{"id":"b","title":"B","duration":120.5,"uploader":"FallbackChannel"}

{"id":"","title":"empty id skipped"}"#;
        let hits = parse_search_output(stdout);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, "a");
        assert_eq!(hits[1].id, "b");
        assert_eq!(hits[1].channel.as_deref(), Some("FallbackChannel"));
        assert_eq!(hits[1].duration_sec, Some(120));
    }

    #[test]
    fn handles_empty_stdout() {
        let hits = parse_search_output("");
        assert_eq!(hits.len(), 0);
    }

    #[test]
    fn truncates_negative_duration_to_zero() {
        let stdout = r#"{"id":"x","title":"x","duration":-5}"#;
        let hits = parse_search_output(stdout);
        assert_eq!(hits[0].duration_sec, Some(0));
    }
}
