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
    // ── Plugin fields (Task 5 / bridge spec §4.1) ──
    /// Origin of the entry: "desktop" | "youtube" | "web"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// URL of the page where the phrase was saved (web/youtube plugin context).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_url: Option<String>,
    /// Direct video URL (youtube/web plugin context).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_url: Option<String>,
    /// Sync lifecycle marker: "pending" | "synced" | "conflict"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_status: Option<String>,
}

impl VocabEntry {
    /// Shallow-merge `incoming` into `self`. Required fields are always
    /// overwritten; optional fields are overwritten only when the incoming
    /// value is `Some`. This preserves any fields the current stored entry
    /// has that the caller did not include (spec §4.1).
    pub fn merge_from(&mut self, incoming: &VocabEntry) {
        self.expression = incoming.expression.clone();
        self.meaning_zh = incoming.meaning_zh.clone();
        self.usage = incoming.usage.clone();
        self.video_id = incoming.video_id.clone();
        self.video_title = incoming.video_title.clone();
        self.added_at = incoming.added_at.clone();
        if incoming.cue_time.is_some() {
            self.cue_time = incoming.cue_time;
        }
        if incoming.cue_text.is_some() {
            self.cue_text = incoming.cue_text.clone();
        }
        if incoming.note.is_some() {
            self.note = incoming.note.clone();
        }
        if incoming.note_updated_at.is_some() {
            self.note_updated_at = incoming.note_updated_at;
        }
        // Plugin fields: incoming overwrites only when Some
        if incoming.source.is_some() {
            self.source = incoming.source.clone();
        }
        if incoming.page_url.is_some() {
            self.page_url = incoming.page_url.clone();
        }
        if incoming.video_url.is_some() {
            self.video_url = incoming.video_url.clone();
        }
        if incoming.sync_status.is_some() {
            self.sync_status = incoming.sync_status.clone();
        }
    }
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

// ── Bridge-accessible internal API (not Tauri commands) ──

/// Upsert a single entry using shallow-merge semantics (spec §4.1).
/// If an entry with the same `id` exists it is merged in-place; otherwise
/// the entry is appended. Returns the `id` on success.
pub fn vocab_upsert(entry: VocabEntry) -> AppResult<String> {
    let mut v = read()?;
    let id = entry.id.clone();
    if let Some(existing) = v.entries.iter_mut().find(|e| e.id == entry.id) {
        existing.merge_from(&entry);
    } else {
        v.entries.push(entry);
    }
    write(&v)?;
    Ok(id)
}

/// Load and return all vocabulary entries. Used by the bridge GET /vocab
/// handler to avoid duplicating the file-read logic.
pub fn vocab_load_all() -> AppResult<Vec<VocabEntry>> {
    Ok(read()?.entries)
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
