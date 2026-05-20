use crate::core::paths;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LibrarySource {
    #[serde(rename = "local")]
    Local {
        #[serde(rename = "originalPath")]
        original_path: String,
    },
    #[serde(rename = "url")]
    Url { url: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum LibraryStatus {
    #[serde(rename = "analyzing")]
    Analyzing,
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "failed")]
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub id: String,
    pub title: String,
    pub source: LibrarySource,
    pub duration_sec: f64,
    pub thumbnail_path: String,
    pub created_at: String,
    pub status: LibraryStatus,
    pub last_error: Option<String>,
    /// Absolute path to the directory holding source.mp4, transcript.srt, analysis.json
    /// for this video. Frozen at import time so changing settings.libraryDir later
    /// does not orphan existing entries. Optional for backward compat with old entries
    /// written before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_dir: Option<String>,

    /// Translation style chosen at import time (e.g. "colloquial", "playful",
    /// "cinematic", "formal", "literary"). Drives the system prompt for this
    /// entry's LLM analysis. Optional: missing means legacy entry — Player
    /// falls back to settings.translationStyle then to "colloquial". We keep
    /// this as a free-form String at the Rust layer so adding new styles in
    /// the frontend doesn't require a Rust enum bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analysis_style: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolder {
    pub id: String,
    pub name: String,
    pub video_ids: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum LibraryItemRef {
    Video { id: String },
    Folder { id: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Library {
    pub videos: Vec<LibraryEntry>,
    #[serde(default)]
    pub folders: Vec<LibraryFolder>,
    #[serde(default, rename = "topLevelOrder")]
    pub top_level_order: Vec<LibraryItemRef>,
}

fn read_index() -> AppResult<Library> {
    let path = paths::library_index_path()?;
    if !path.exists() {
        return Ok(Library::default());
    }
    let raw = fs::read_to_string(&path)?;
    let mut lib: Library = serde_json::from_str(&raw)?;
    if lib.top_level_order.is_empty() && !lib.videos.is_empty() {
        // Legacy file: synthesize default top-level order from the videos list.
        lib.top_level_order = lib
            .videos
            .iter()
            .map(|v| LibraryItemRef::Video { id: v.id.clone() })
            .collect();
    }
    Ok(lib)
}

fn write_index(lib: &Library) -> AppResult<()> {
    let dir = paths::app_data_dir()?;
    fs::create_dir_all(&dir)?;
    let pretty = serde_json::to_string_pretty(lib)?;
    fs::write(paths::library_index_path()?, pretty)?;
    Ok(())
}

#[tauri::command]
pub fn library_list() -> AppResult<Library> {
    read_index()
}

#[tauri::command]
pub fn library_get(id: String) -> AppResult<Option<LibraryEntry>> {
    let lib = read_index()?;
    Ok(lib.videos.into_iter().find(|v| v.id == id))
}

fn upsert_in_memory(lib: &mut Library, entry: LibraryEntry) {
    if let Some(existing) = lib.videos.iter_mut().find(|v| v.id == entry.id) {
        *existing = entry;
    } else {
        lib.videos.push(entry);
    }
}

#[tauri::command]
pub fn library_upsert(entry: LibraryEntry) -> AppResult<()> {
    let mut lib = read_index()?;
    upsert_in_memory(&mut lib, entry);
    write_index(&lib)
}

#[tauri::command]
pub fn library_delete(id: String) -> AppResult<()> {
    let mut lib = read_index()?;
    lib.videos.retain(|v| v.id != id);
    write_index(&lib)?;
    let dir = paths::video_dir(&id)?;
    if dir.exists() {
        fs::remove_dir_all(dir)?;
    }
    Ok(())
}

fn set_status_in_memory(
    lib: &mut Library,
    id: &str,
    status: LibraryStatus,
    error: Option<String>,
) {
    if let Some(entry) = lib.videos.iter_mut().find(|v| v.id == id) {
        entry.status = status;
        entry.last_error = error;
    }
}

#[tauri::command]
pub fn library_set_status(
    id: String,
    status: LibraryStatus,
    error: Option<String>,
) -> AppResult<()> {
    let mut lib = read_index()?;
    set_status_in_memory(&mut lib, &id, status, error);
    write_index(&lib)
}

#[tauri::command]
pub fn library_rename(id: String, title: String) -> AppResult<()> {
    let mut lib = read_index()?;
    if let Some(entry) = lib.videos.iter_mut().find(|v| v.id == id) {
        entry.title = title;
    }
    write_index(&lib)
}

#[tauri::command]
pub fn library_reorder(ordered_ids: Vec<String>) -> AppResult<()> {
    let mut lib = read_index()?;
    // Build a map from id -> entry, then re-insert in the requested order.
    // Any ids missing from `ordered_ids` are appended at the end (defensive).
    let mut by_id: std::collections::HashMap<String, LibraryEntry> = lib
        .videos
        .into_iter()
        .map(|e| (e.id.clone(), e))
        .collect();
    let mut new_videos: Vec<LibraryEntry> = Vec::with_capacity(by_id.len());
    for id in &ordered_ids {
        if let Some(entry) = by_id.remove(id) {
            new_videos.push(entry);
        }
    }
    // Append remaining (shouldn't happen if frontend keeps in sync, but be safe)
    for (_, entry) in by_id {
        new_videos.push(entry);
    }
    lib.videos = new_videos;
    write_index(&lib)
}

/// Freeze the `videoDir` field on every library entry that does not already have one,
/// using the **currently-resolved** `library_dir()` value. Call this BEFORE persisting a
/// new `settings.libraryDir`, so legacy entries continue pointing at the old location
/// while new imports go to the new one.
///
/// Returns the number of entries that were frozen.
#[tauri::command]
pub fn library_freeze_paths() -> AppResult<usize> {
    let mut lib = read_index()?;
    let current_lib_dir = crate::core::paths::library_dir()?;
    let mut frozen = 0;
    for entry in lib.videos.iter_mut() {
        if entry.video_dir.as_deref().map(str::trim).unwrap_or("").is_empty() {
            let dir = current_lib_dir.join(&entry.id);
            entry.video_dir = Some(dir.to_string_lossy().to_string());
            frozen += 1;
        }
    }
    write_index(&lib)?;
    Ok(frozen)
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> AppResult<()> {
    use crate::error::AppError;

    #[cfg(target_os = "windows")]
    {
        // explorer /select takes the path as a single arg; do not quote in CreateProcess form.
        std::process::Command::new("explorer")
            .arg(format!("/select,{path}"))
            .spawn()
            .map_err(|e| AppError::Subprocess(format!("explorer: {e}")))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| AppError::Subprocess(format!("open: {e}")))?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."));
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| AppError::Subprocess(format!("xdg-open: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // PURE IN-MEMORY TESTS ONLY. Do NOT touch paths::library_index_path() —
    // it resolves to %APPDATA%\whatsub\library.json (the user's real library
    // index). An earlier version of this test module called fs::remove_file
    // on it; running `cargo test` wiped the user's entire library. Never again.
    use super::*;

    fn sample(id: &str) -> LibraryEntry {
        LibraryEntry {
            id: id.into(),
            title: "Sample".into(),
            source: LibrarySource::Local {
                original_path: "/x".into(),
            },
            duration_sec: 10.0,
            thumbnail_path: "thumb.jpg".into(),
            created_at: "2026-04-26T00:00:00Z".into(),
            status: LibraryStatus::Analyzing,
            last_error: None,
            video_dir: None,
            analysis_style: None,
        }
    }

    #[test]
    fn upsert_creates_then_updates() {
        let mut lib = Library::default();
        upsert_in_memory(&mut lib, sample("a"));
        assert_eq!(lib.videos.len(), 1);

        let mut updated = sample("a");
        updated.title = "Updated".into();
        upsert_in_memory(&mut lib, updated);
        assert_eq!(lib.videos.len(), 1);
        assert_eq!(lib.videos[0].title, "Updated");
    }

    #[test]
    fn set_status_updates_field() {
        let mut lib = Library::default();
        upsert_in_memory(&mut lib, sample("b"));
        set_status_in_memory(&mut lib, "b", LibraryStatus::Ready, None);
        let entry = lib.videos.iter().find(|v| v.id == "b").unwrap();
        assert_eq!(entry.status, LibraryStatus::Ready);
        assert!(entry.last_error.is_none());
    }

    #[test]
    fn set_status_carries_error_message() {
        let mut lib = Library::default();
        upsert_in_memory(&mut lib, sample("c"));
        set_status_in_memory(&mut lib, "c", LibraryStatus::Failed, Some("boom".into()));
        let entry = lib.videos.iter().find(|v| v.id == "c").unwrap();
        assert_eq!(entry.status, LibraryStatus::Failed);
        assert_eq!(entry.last_error.as_deref(), Some("boom"));
    }

    #[test]
    fn library_default_has_empty_folders_and_order() {
        let lib = Library::default();
        assert!(lib.folders.is_empty());
        assert!(lib.top_level_order.is_empty());
    }

    #[test]
    fn library_round_trips_with_folders() {
        let mut lib = Library::default();
        upsert_in_memory(&mut lib, sample("v1"));
        lib.folders.push(LibraryFolder {
            id: "f1".into(),
            name: "Folder".into(),
            video_ids: vec!["v1".into()],
            created_at: "2026-05-20T00:00:00Z".into(),
        });
        lib.top_level_order = vec![LibraryItemRef::Folder { id: "f1".into() }];
        let json = serde_json::to_string(&lib).unwrap();
        let parsed: Library = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.folders.len(), 1);
        assert_eq!(parsed.folders[0].video_ids, vec!["v1".to_string()]);
        assert_eq!(parsed.top_level_order.len(), 1);
        match &parsed.top_level_order[0] {
            LibraryItemRef::Folder { id } => assert_eq!(id, "f1"),
            _ => panic!("expected folder ref"),
        }
    }

    #[test]
    fn library_legacy_json_decodes_with_default_fields() {
        let legacy = r#"{"videos":[]}"#;
        let lib: Library = serde_json::from_str(legacy).unwrap();
        assert_eq!(lib.videos.len(), 0);
        assert!(lib.folders.is_empty());
        assert!(lib.top_level_order.is_empty());
    }
}
