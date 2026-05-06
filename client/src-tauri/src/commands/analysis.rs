use crate::core::paths;
use crate::core::progress::{emit, PipelineEvent};
use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::collections::VecDeque;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[tauri::command]
pub fn save_analysis(video_id: String, analysis: Value) -> AppResult<()> {
    let dir = paths::video_dir(&video_id)?;
    fs::create_dir_all(&dir)?;
    let path = dir.join("analysis.json");
    let pretty = serde_json::to_string_pretty(&analysis)?;
    fs::write(&path, pretty)?;
    Ok(())
}

#[tauri::command]
pub fn load_analysis(video_id: String) -> AppResult<Option<Value>> {
    let path = paths::video_dir(&video_id)?.join("analysis.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)?;
    Ok(Some(serde_json::from_str(&raw)?))
}

#[tauri::command]
pub fn load_transcript(video_id: String) -> AppResult<Option<String>> {
    let path = paths::video_dir(&video_id)?.join("transcript.srt");
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(fs::read_to_string(&path)?))
}

#[tauri::command]
pub fn video_source_path(video_id: String) -> AppResult<String> {
    let path = paths::video_dir(&video_id)?.join("source.mp4");
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> AppResult<()> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, content)?;
    Ok(())
}

/// Shared state used by the burn-in export command so a separate `cancel_export`
/// invocation can SIGTERM the running ffmpeg process. There's only ever at most
/// one export running at a time (UI prevents starting another).
#[derive(Default)]
pub struct ExportState {
    child: Mutex<Option<CommandChild>>,
    cancel_requested: AtomicBool,
}

/// Escape a path for use inside ffmpeg's `-vf subtitles='...'` filter argument.
/// Filter syntax uses `:` to separate options and `\` for escapes, so colons
/// in Windows drive letters and any backslashes need handling.
fn escape_for_subtitles_filter(path: &str) -> String {
    path.replace('\\', "/").replace(':', "\\:")
}

/// Burn an ASS subtitle into the video, re-encoding video with libx264 and
/// audio with AAC. Audio is ALWAYS transcoded (not -c:a copy) so the output
/// MP4 is universally playable — Opus-in-MP4 from yt-dlp downloads silently
/// fails on a lot of Windows/phone players.
#[tauri::command]
/// `quality`: one of `"high"` / `"standard"` / `"smooth"` (or omitted → default
/// "standard"). Maps to libx264 CRF + preset:
///   "high"     → CRF 18, preset slow    (visually lossless, ~2× file size)
///   "standard" → CRF 22, preset medium  (default, decent balance)
///   "smooth"   → CRF 26, preset fast    (smaller file, fastest encode)
/// Ignored when ass_content is empty (stream copy is always lossless).
pub async fn export_burned_video(
    app: AppHandle,
    state: State<'_, ExportState>,
    video_id: String,
    ass_content: String,
    output_path: String,
    duration_sec: f64,
    quality: Option<String>,
) -> AppResult<()> {
    // Reject overlapping exports — UI should prevent this but guard anyway.
    if state.child.lock().unwrap().is_some() {
        return Err(AppError::Other("已有导出任务正在进行".into()));
    }
    state.cancel_requested.store(false, Ordering::Relaxed);

    let video_dir = paths::video_dir(&video_id)?;
    let source = video_dir.join("source.mp4");
    if !source.exists() {
        return Err(AppError::NotFound(format!(
            "source.mp4 not found for {video_id}"
        )));
    }

    // Empty ass_content → user wants the original video copy without
    // any subtitle burn-in. Skip the subtitles filter entirely and use
    // stream copy (`-c copy`) — no re-encoding, runs in seconds instead
    // of minutes-to-hours.
    let burn_subtitles = !ass_content.is_empty();
    let ass_path = video_dir.join("_export.ass");
    let vf;
    if burn_subtitles {
        // Write the ASS to a sibling temp file. We delete it on both success
        // and failure so the library dir doesn't accumulate junk.
        fs::write(&ass_path, &ass_content)?;
        let escaped = escape_for_subtitles_filter(&ass_path.to_string_lossy());
        vf = format!("subtitles='{}'", escaped);
    } else {
        vf = String::new();
    }

    let source_str = source.to_string_lossy().to_string();
    // Progress comes from ffmpeg's standard stderr "time=HH:MM:SS.cs" line —
    // more reliable than `-progress pipe:1` (which gets block-buffered through
    // Tauri's shell pipe on Windows). `-stats_period 0.5` makes ffmpeg print
    // progress twice a second instead of the default 0.5s..2s heuristic.
    // Map user-facing quality preset → libx264 CRF + preset.
    // CRF: lower = higher quality, exponentially larger files
    //   18 ≈ visually lossless; 23 = libx264 default; 28 = noticeably soft
    let (crf, preset) = match quality.as_deref() {
        Some("high") => ("18", "slow"),
        Some("smooth") => ("26", "fast"),
        _ => ("22", "medium"),
    };

    let args: Vec<&str> = if burn_subtitles {
        vec![
            "-y",
            "-i", &source_str,
            "-vf", &vf,
            "-c:v", "libx264",
            "-crf", crf,
            "-preset", preset,
            // Audio: always transcode to AAC so the output MP4 plays on every
            // platform regardless of source codec (yt-dlp often delivers Opus).
            "-c:a", "aac",
            "-b:a", "192k",
            "-ac", "2",
            "-stats_period", "0.5",
            &output_path,
        ]
    } else {
        // Stream copy — no re-encoding. Both video and audio bytes are
        // copied as-is; container is rewritten to MP4 (`-f mp4` is
        // implicit from .mp4 output). 5-50× faster than the burn-in
        // path because ffmpeg never decodes or re-encodes a single
        // frame.
        vec![
            "-y",
            "-i", &source_str,
            "-c", "copy",
            "-stats_period", "0.5",
            &output_path,
        ]
    };

    let cmd = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| AppError::Subprocess(format!("sidecar ffmpeg: {e}")))?
        .args(&args);

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| AppError::Subprocess(format!("spawn ffmpeg: {e}")))?;

    *state.child.lock().unwrap() = Some(child);

    // Track last emitted percent to avoid flooding the event bus.
    let mut last_percent: u8 = 255;
    let mut stderr_tail: VecDeque<String> = VecDeque::new();
    let mut exit_code: Option<i32> = None;
    // ffmpeg's per-frame progress line is one long line (with \r between
    // updates, not \n) — buffer the active line and parse on each refresh.
    let mut stderr_buf = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                // ffmpeg may write to stdout if we ever wire `-progress pipe:1`;
                // tee whatever shows up to the log channel for diagnostics.
                let chunk = String::from_utf8_lossy(&bytes).to_string();
                for line in chunk.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    emit(
                        &app,
                        PipelineEvent::Log {
                            video_id: video_id.clone(),
                            source: "ffmpeg-stdout".into(),
                            line: trimmed.into(),
                        },
                    );
                }
            }
            CommandEvent::Stderr(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes).to_string();
                stderr_buf.push_str(&chunk);
                // ffmpeg uses '\r' to overwrite the live progress line. We
                // split on both '\n' and '\r' so each refresh is a complete
                // unit we can parse / log.
                let pieces: Vec<&str> = stderr_buf.split(|c: char| c == '\n' || c == '\r').collect();
                let last = pieces.last().copied().unwrap_or("").to_string();
                for piece in &pieces[..pieces.len().saturating_sub(1)] {
                    let trimmed = piece.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if stderr_tail.len() >= 30 {
                        stderr_tail.pop_front();
                    }
                    stderr_tail.push_back(trimmed.to_string());
                    // Surface every stderr line as a Log event so the UI can
                    // show ffmpeg's banner + per-frame status. The frontend
                    // can throttle / filter as it sees fit.
                    emit(
                        &app,
                        PipelineEvent::Log {
                            video_id: video_id.clone(),
                            source: "ffmpeg".into(),
                            line: trimmed.into(),
                        },
                    );
                    if let Some(secs) = extract_time_field(trimmed) {
                        if duration_sec > 0.0 {
                            let pct = ((secs / duration_sec) * 100.0)
                                .clamp(0.0, 99.0) as u8;
                            if pct != last_percent {
                                last_percent = pct;
                                emit(
                                    &app,
                                    PipelineEvent::Exporting {
                                        video_id: video_id.clone(),
                                        percent: pct,
                                    },
                                );
                            }
                        }
                    }
                }
                stderr_buf = last;
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
            }
            _ => {}
        }
    }

    *state.child.lock().unwrap() = None;
    let cancelled = state.cancel_requested.swap(false, Ordering::Relaxed);

    // Best-effort cleanup of the temp ASS, regardless of outcome.
    let _ = fs::remove_file(&ass_path);

    if cancelled {
        // User pressed cancel → kill produced a non-zero exit; treat as
        // success-with-no-output and remove any partial output file.
        let _ = fs::remove_file(&output_path);
        return Err(AppError::Other("用户已取消导出".into()));
    }

    match exit_code {
        Some(0) => {
            emit(
                &app,
                PipelineEvent::Exported {
                    video_id,
                    output_path,
                },
            );
            Ok(())
        }
        Some(c) => {
            let tail = stderr_tail
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            let _ = fs::remove_file(&output_path);
            Err(AppError::Subprocess(format!(
                "ffmpeg exit {c}\n--- ffmpeg stderr (last {} lines) ---\n{}",
                stderr_tail.len(),
                tail
            )))
        }
        None => Err(AppError::Subprocess(
            "ffmpeg terminated abnormally".into(),
        )),
    }
}

/// Cancel an in-flight export. Sets the cancel flag (so the export command
/// reports cancellation rather than treating the kill as a generic failure)
/// and SIGTERMs the ffmpeg child.
#[tauri::command]
pub fn cancel_export(state: State<'_, ExportState>) -> AppResult<()> {
    state.cancel_requested.store(true, Ordering::Relaxed);
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    Ok(())
}

/// Extract the `time=HH:MM:SS.cs` field from a single ffmpeg stderr status
/// line and return it as seconds. Status lines look like:
/// `frame=  123 fps=45 q=28.0 size=    256kB time=00:00:04.10 bitrate=...`
fn extract_time_field(line: &str) -> Option<f64> {
    let idx = line.find("time=")?;
    let rest = &line[idx + 5..];
    let token = rest
        .split_whitespace()
        .next()?
        .trim_end_matches(',');
    if token == "N/A" {
        return None;
    }
    let parts: Vec<&str> = token.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let sec: f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ffmpeg_progress_line() {
        let line = "frame=  123 fps=45 q=28.0 size=    256kB time=00:00:04.10 bitrate=512.0kbits/s speed=1.2x";
        assert_eq!(extract_time_field(line), Some(4.10));
    }

    #[test]
    fn handles_na_time() {
        assert_eq!(extract_time_field("frame=0 time=N/A bitrate=N/A"), None);
    }

    #[test]
    fn rejects_lines_without_time() {
        assert_eq!(extract_time_field("ffmpeg version 6.0 Copyright (c) ..."), None);
    }
}

