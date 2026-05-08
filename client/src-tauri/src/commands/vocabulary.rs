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
    /// User-authored note attached to this vocab card (TipTap JSON document
    /// serialized as a string). None when the user hasn't added a note yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_updated_at: Option<i64>,
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

/// Update just the `note` + `note_updated_at` fields of an existing entry.
/// Pass `note: None` (or omit) to clear the note. Returns the full list so
/// the frontend store stays in sync.
///
/// We could have folded this into `vocab_add` (which is upsert) but that
/// requires the JS caller to know all the other fields to write back —
/// a separate command keeps the call site simple ("just save the note").
#[tauri::command]
pub fn vocab_update_note(id: String, note: Option<String>) -> AppResult<Vec<VocabEntry>> {
    let mut v = read()?;
    let now = chrono::Utc::now().timestamp_millis();
    if let Some(slot) = v.entries.iter_mut().find(|e| e.id == id) {
        match note {
            Some(content) if !content.is_empty() => {
                slot.note = Some(content);
                slot.note_updated_at = Some(now);
            }
            _ => {
                slot.note = None;
                slot.note_updated_at = None;
            }
        }
    }
    write(&v)?;
    Ok(v.entries)
}
