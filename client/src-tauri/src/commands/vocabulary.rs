use crate::core::paths;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::fs;

/// One saved phrase. id is the dedupe key — stable per-expression so toggling
/// is possible without juggling UUIDs from the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabEntry {
    pub id: String,
    pub expression: String,
    #[serde(default)]
    pub meaning_zh: String,
    #[serde(default)]
    pub usage: String,
    #[serde(default)]
    pub video_id: String,
    #[serde(default)]
    pub video_title: String,
    #[serde(default)]
    pub added_at: String,
    /// Time (seconds) of the first cue that contained this expression, so the
    /// vocab page can deep-link back to the moment in the video.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cue_time: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cue_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Vocabulary {
    pub entries: Vec<VocabEntry>,
}

fn read() -> AppResult<Vocabulary> {
    let path = paths::vocabulary_path()?;
    if !path.exists() {
        return Ok(Vocabulary::default());
    }
    let raw = fs::read_to_string(&path)?;
    if raw.trim().is_empty() {
        return Ok(Vocabulary::default());
    }
    Ok(serde_json::from_str(&raw)?)
}

fn write(v: &Vocabulary) -> AppResult<()> {
    let path = paths::vocabulary_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let pretty = serde_json::to_string_pretty(v)?;
    fs::write(&path, pretty)?;
    Ok(())
}

#[tauri::command]
pub fn vocab_list() -> AppResult<Vec<VocabEntry>> {
    Ok(read()?.entries)
}

/// Insert if id is new, otherwise update in place. Returns the full list.
#[tauri::command]
pub fn vocab_add(entry: VocabEntry) -> AppResult<Vec<VocabEntry>> {
    let mut v = read()?;
    if let Some(slot) = v.entries.iter_mut().find(|e| e.id == entry.id) {
        *slot = entry;
    } else {
        v.entries.push(entry);
    }
    write(&v)?;
    Ok(v.entries)
}

#[tauri::command]
pub fn vocab_remove(id: String) -> AppResult<Vec<VocabEntry>> {
    let mut v = read()?;
    v.entries.retain(|e| e.id != id);
    write(&v)?;
    Ok(v.entries)
}
