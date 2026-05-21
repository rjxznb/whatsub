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

    /// Unix ms — set when entry was last successfully uploaded to /api/library/sync
    /// (Plan 3, 2026-05-21). Undefined = never synced or unsynced from cloud.
    /// v1 only YouTube sources get a value; others stay None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_at: Option<i64>,

    /// Friendly error message from the LAST sync attempt that failed.
    /// Cleared on next successful sync. Used by SyncButton in the UI
    /// to render the ✗ state + show the message in a tooltip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_error: Option<String>,
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

// === ID + timestamp helpers ===

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn new_id(prefix: &str) -> String {
    use sha2::{Digest, Sha256};
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(now.as_secs().to_le_bytes());
    hasher.update(now.subsec_nanos().to_le_bytes());
    let hex = hex::encode(hasher.finalize());
    format!("{}{}", prefix, &hex[..10])
}

// === Pure in-memory helpers (Tauri commands below call these + write_index) ===

fn create_folder_in_memory(lib: &mut Library, name: Option<String>) -> String {
    let id = new_id("f-");
    let folder = LibraryFolder {
        id: id.clone(),
        name: name.unwrap_or_else(|| "新建文件夹".to_string()),
        video_ids: Vec::new(),
        created_at: now_iso(),
    };
    lib.folders.push(folder);
    lib.top_level_order
        .push(LibraryItemRef::Folder { id: id.clone() });
    id
}

fn delete_folder_in_memory(lib: &mut Library, folder_id: &str) -> Result<(), String> {
    let folder_idx = lib
        .folders
        .iter()
        .position(|f| f.id == folder_id)
        .ok_or_else(|| format!("folder {} not found", folder_id))?;
    let folder = lib.folders.remove(folder_idx);
    let pos = lib
        .top_level_order
        .iter()
        .position(|r| matches!(r, LibraryItemRef::Folder { id } if id == folder_id));
    if let Some(pos) = pos {
        lib.top_level_order.remove(pos);
    }
    for vid in folder.video_ids {
        lib.top_level_order
            .push(LibraryItemRef::Video { id: vid });
    }
    Ok(())
}

fn rename_folder_in_memory(
    lib: &mut Library,
    folder_id: &str,
    name: String,
) -> Result<(), String> {
    let folder = lib
        .folders
        .iter_mut()
        .find(|f| f.id == folder_id)
        .ok_or_else(|| format!("folder {} not found", folder_id))?;
    folder.name = name;
    Ok(())
}

fn move_video_to_folder_in_memory(
    lib: &mut Library,
    video_id: &str,
    target_folder_id: Option<&str>,
    insert_at: Option<usize>,
) -> Result<(), String> {
    for folder in lib.folders.iter_mut() {
        folder.video_ids.retain(|v| v != video_id);
    }
    lib.top_level_order
        .retain(|r| !matches!(r, LibraryItemRef::Video { id } if id == video_id));

    match target_folder_id {
        Some(fid) => {
            let folder = lib
                .folders
                .iter_mut()
                .find(|f| f.id == fid)
                .ok_or_else(|| format!("folder {} not found", fid))?;
            let pos = insert_at
                .unwrap_or(folder.video_ids.len())
                .min(folder.video_ids.len());
            folder.video_ids.insert(pos, video_id.to_string());
        }
        None => {
            let pos = insert_at
                .unwrap_or(lib.top_level_order.len())
                .min(lib.top_level_order.len());
            lib.top_level_order
                .insert(pos, LibraryItemRef::Video { id: video_id.to_string() });
        }
    }
    Ok(())
}

fn merge_into_folder_in_memory(
    lib: &mut Library,
    video_ids: Vec<String>,
    name: Option<String>,
) -> Result<String, String> {
    if video_ids.len() < 2 {
        return Err("merge requires at least 2 videos".into());
    }
    let insert_pos = lib
        .top_level_order
        .iter()
        .position(|r| matches!(r, LibraryItemRef::Video { id } if id == &video_ids[0]))
        .unwrap_or(lib.top_level_order.len());

    for vid in &video_ids {
        for folder in lib.folders.iter_mut() {
            folder.video_ids.retain(|v| v != vid);
        }
        lib.top_level_order
            .retain(|r| !matches!(r, LibraryItemRef::Video { id } if id == vid));
    }

    let insert_pos = insert_pos.min(lib.top_level_order.len());

    let folder_id = new_id("f-");
    lib.folders.push(LibraryFolder {
        id: folder_id.clone(),
        name: name.unwrap_or_else(|| "新建文件夹".to_string()),
        video_ids,
        created_at: now_iso(),
    });
    lib.top_level_order
        .insert(insert_pos, LibraryItemRef::Folder { id: folder_id.clone() });
    Ok(folder_id)
}

fn set_top_level_order_in_memory(
    lib: &mut Library,
    refs: Vec<LibraryItemRef>,
) -> Result<(), String> {
    for r in &refs {
        match r {
            LibraryItemRef::Video { id } => {
                if !lib.videos.iter().any(|v| &v.id == id) {
                    return Err(format!("unknown video id {}", id));
                }
            }
            LibraryItemRef::Folder { id } => {
                if !lib.folders.iter().any(|f| &f.id == id) {
                    return Err(format!("unknown folder id {}", id));
                }
            }
        }
    }
    lib.top_level_order = refs;
    Ok(())
}

// === Tauri commands wrapping the helpers ===

#[tauri::command]
pub fn library_create_folder(name: Option<String>) -> AppResult<String> {
    let mut lib = read_index()?;
    let id = create_folder_in_memory(&mut lib, name);
    write_index(&lib)?;
    Ok(id)
}

#[tauri::command]
pub fn library_delete_folder(folder_id: String) -> AppResult<()> {
    let mut lib = read_index()?;
    delete_folder_in_memory(&mut lib, &folder_id)?;
    write_index(&lib)
}

#[tauri::command]
pub fn library_rename_folder(folder_id: String, name: String) -> AppResult<()> {
    let mut lib = read_index()?;
    rename_folder_in_memory(&mut lib, &folder_id, name)?;
    write_index(&lib)
}

#[tauri::command]
pub fn library_move_video_to_folder(
    video_id: String,
    target_folder_id: Option<String>,
    insert_at: Option<usize>,
) -> AppResult<()> {
    let mut lib = read_index()?;
    move_video_to_folder_in_memory(&mut lib, &video_id, target_folder_id.as_deref(), insert_at)?;
    write_index(&lib)
}

#[tauri::command]
pub fn library_merge_into_folder(
    video_ids: Vec<String>,
    name: Option<String>,
) -> AppResult<String> {
    let mut lib = read_index()?;
    let id = merge_into_folder_in_memory(&mut lib, video_ids, name)?;
    write_index(&lib)?;
    Ok(id)
}

#[tauri::command]
pub fn library_set_top_level_order(refs: Vec<LibraryItemRef>) -> AppResult<()> {
    let mut lib = read_index()?;
    set_top_level_order_in_memory(&mut lib, refs)?;
    write_index(&lib)
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
            synced_at: None,
            sync_error: None,
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

    #[test]
    fn create_folder_appends_to_top_level() {
        let mut lib = Library::default();
        upsert_in_memory(&mut lib, sample("v1"));
        lib.top_level_order = vec![LibraryItemRef::Video { id: "v1".into() }];
        let folder_id = create_folder_in_memory(&mut lib, Some("Test".into()));
        assert_eq!(lib.folders.len(), 1);
        assert_eq!(lib.folders[0].name, "Test");
        assert_eq!(lib.folders[0].video_ids.len(), 0);
        assert_eq!(lib.top_level_order.len(), 2);
        match &lib.top_level_order[1] {
            LibraryItemRef::Folder { id } => assert_eq!(id, &folder_id),
            _ => panic!("expected folder ref at end"),
        }
    }

    #[test]
    fn merge_into_folder_pulls_videos_from_top_level() {
        let mut lib = Library::default();
        upsert_in_memory(&mut lib, sample("v1"));
        upsert_in_memory(&mut lib, sample("v2"));
        upsert_in_memory(&mut lib, sample("v3"));
        lib.top_level_order = vec![
            LibraryItemRef::Video { id: "v1".into() },
            LibraryItemRef::Video { id: "v2".into() },
            LibraryItemRef::Video { id: "v3".into() },
        ];
        let folder_id = merge_into_folder_in_memory(
            &mut lib,
            vec!["v2".into(), "v3".into()],
            Some("Pair".into()),
        )
        .unwrap();
        assert_eq!(lib.top_level_order.len(), 2);
        match &lib.top_level_order[0] {
            LibraryItemRef::Video { id } => assert_eq!(id, "v1"),
            _ => panic!(),
        }
        match &lib.top_level_order[1] {
            LibraryItemRef::Folder { id } => assert_eq!(id, &folder_id),
            _ => panic!(),
        }
        assert_eq!(lib.folders[0].video_ids, vec!["v2".to_string(), "v3".into()]);
    }

    #[test]
    fn move_video_to_folder_then_back() {
        let mut lib = Library::default();
        upsert_in_memory(&mut lib, sample("v1"));
        upsert_in_memory(&mut lib, sample("v2"));
        let folder_id = create_folder_in_memory(&mut lib, None);
        lib.top_level_order = vec![
            LibraryItemRef::Video { id: "v1".into() },
            LibraryItemRef::Video { id: "v2".into() },
            LibraryItemRef::Folder { id: folder_id.clone() },
        ];
        move_video_to_folder_in_memory(&mut lib, "v1", Some(&folder_id), None).unwrap();
        assert_eq!(lib.folders[0].video_ids, vec!["v1".to_string()]);
        assert!(!lib
            .top_level_order
            .iter()
            .any(|r| matches!(r, LibraryItemRef::Video { id } if id == "v1")));

        move_video_to_folder_in_memory(&mut lib, "v1", None, None).unwrap();
        assert_eq!(lib.folders[0].video_ids.len(), 0);
        assert!(lib
            .top_level_order
            .iter()
            .any(|r| matches!(r, LibraryItemRef::Video { id } if id == "v1")));
    }

    #[test]
    fn delete_folder_returns_videos_to_top_level_end() {
        let mut lib = Library::default();
        upsert_in_memory(&mut lib, sample("v1"));
        upsert_in_memory(&mut lib, sample("v2"));
        upsert_in_memory(&mut lib, sample("v3"));
        let folder_id =
            merge_into_folder_in_memory(&mut lib, vec!["v2".into(), "v3".into()], None).unwrap();
        lib.top_level_order
            .insert(0, LibraryItemRef::Video { id: "v1".into() });
        delete_folder_in_memory(&mut lib, &folder_id).unwrap();
        assert_eq!(lib.folders.len(), 0);
        assert_eq!(lib.top_level_order.len(), 3);
        let ids: Vec<_> = lib
            .top_level_order
            .iter()
            .filter_map(|r| match r {
                LibraryItemRef::Video { id } => Some(id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(ids, vec!["v1", "v2", "v3"]);
    }

    #[test]
    fn rename_folder_updates_name() {
        let mut lib = Library::default();
        let folder_id = create_folder_in_memory(&mut lib, Some("Old".into()));
        rename_folder_in_memory(&mut lib, &folder_id, "New".into()).unwrap();
        assert_eq!(lib.folders[0].name, "New");
    }
}
