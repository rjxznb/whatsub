use crate::core::paths;
use crate::error::AppResult;
use serde_json::Value;
use std::fs;

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
