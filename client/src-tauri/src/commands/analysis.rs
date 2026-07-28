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
pub fn begin_analysis_session(
    video_id: String,
    reset: bool,
) -> AppResult<crate::commands::analysis_store::AnalysisSessionStart> {
    crate::commands::analysis_store::begin_session(&video_id, reset)
}

#[tauri::command]
pub fn save_analysis_session(
    video_id: String,
    lease: String,
    analysis: Value,
) -> AppResult<crate::commands::analysis_store::SessionSaveOutcome> {
    crate::commands::analysis_store::save_session(&video_id, &lease, analysis)
}

#[tauri::command]
pub fn end_analysis_session(video_id: String, lease: String) -> AppResult<()> {
    crate::commands::analysis_store::end_session(&video_id, &lease)
}

#[tauri::command]
pub fn load_analysis(video_id: String) -> AppResult<Option<Value>> {
    crate::commands::analysis_store::load_snapshot(&video_id)
}

/// Explicit analysis reset. Missing files are success, but the producer lease
/// is revoked even when a later filesystem removal fails.
#[tauri::command]
pub fn delete_analysis(video_id: String) -> AppResult<()> {
    crate::commands::analysis_store::delete_analysis_snapshot(&video_id)
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
    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "source video not found for {video_id}"
        )));
    }
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

#[derive(Default)]
pub struct ExportState {
    child: Mutex<Option<CommandChild>>,
    cancel_requested: AtomicBool,
}

fn escape_for_subtitles_filter(path: &str) -> String {
    path.replace('\\', "/").replace(':', "\\:")
}

/// Burn an ASS subtitle into the video, or stream-copy the original when no
/// ASS content is supplied.
#[tauri::command]
pub async fn export_burned_video(
    app: AppHandle,
    state: State<'_, ExportState>,
    video_id: String,
    ass_content: String,
    output_path: String,
    duration_sec: f64,
    quality: Option<String>,
) -> AppResult<()> {
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

    let burn_subtitles = !ass_content.is_empty();
    let ass_path = video_dir.join("_export.ass");
    let vf;
    if burn_subtitles {
        fs::write(&ass_path, &ass_content)?;
        let escaped = escape_for_subtitles_filter(&ass_path.to_string_lossy());
        vf = format!("subtitles='{}'", escaped);
    } else {
        vf = String::new();
    }

    let source_str = source.to_string_lossy().to_string();
    let (crf, preset) = match quality.as_deref() {
        Some("high") => ("18", "slow"),
        Some("smooth") => ("26", "fast"),
        _ => ("22", "medium"),
    };

    let args: Vec<&str> = if burn_subtitles {
        vec![
            "-y",
            "-i",
            &source_str,
            "-vf",
            &vf,
            "-c:v",
            "libx264",
            "-crf",
            crf,
            "-preset",
            preset,
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ac",
            "2",
            "-stats_period",
            "0.5",
            &output_path,
        ]
    } else {
        vec![
            "-y",
            "-i",
            &source_str,
            "-c",
            "copy",
            "-stats_period",
            "0.5",
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

    let mut last_percent: u8 = 255;
    let mut stderr_tail: VecDeque<String> = VecDeque::new();
    let mut exit_code: Option<i32> = None;
    let mut stderr_buf = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
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
                let pieces: Vec<&str> =
                    stderr_buf.split(|c: char| c == '\n' || c == '\r').collect();
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
                            let pct = ((secs / duration_sec) * 100.0).clamp(0.0, 99.0) as u8;
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
            CommandEvent::Terminated(payload) => exit_code = payload.code,
            _ => {}
        }
    }

    *state.child.lock().unwrap() = None;
    let cancelled = state.cancel_requested.swap(false, Ordering::Relaxed);
    let _ = fs::remove_file(&ass_path);

    if cancelled {
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
        Some(code) => {
            let tail = stderr_tail.iter().cloned().collect::<Vec<_>>().join("\n");
            let _ = fs::remove_file(&output_path);
            Err(AppError::Subprocess(format!(
                "ffmpeg exit {code}\n--- ffmpeg stderr (last {} lines) ---\n{}",
                stderr_tail.len(),
                tail
            )))
        }
        None => Err(AppError::Subprocess("ffmpeg terminated abnormally".into())),
    }
}

#[tauri::command]
pub fn cancel_export(state: State<'_, ExportState>) -> AppResult<()> {
    state.cancel_requested.store(true, Ordering::Relaxed);
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    Ok(())
}

pub(crate) fn extract_time_field(line: &str) -> Option<f64> {
    let idx = line.find("time=")?;
    let rest = &line[idx + 5..];
    let token = rest.split_whitespace().next()?.trim_end_matches(',');
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
    use super::extract_time_field;

    #[test]
    fn parses_ffmpeg_progress_line() {
        let line = "frame= 123 fps=45 time=00:01:04.50 bitrate=1000kbits/s";
        assert_eq!(extract_time_field(line), Some(64.5));
    }

    #[test]
    fn handles_na_time() {
        assert_eq!(extract_time_field("time=N/A"), None);
    }

    #[test]
    fn rejects_lines_without_time() {
        assert_eq!(extract_time_field("frame=123 fps=45"), None);
    }
}
