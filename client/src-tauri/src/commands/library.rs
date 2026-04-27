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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Library {
    pub videos: Vec<LibraryEntry>,
}

fn read_index() -> AppResult<Library> {
    let path = paths::library_index_path()?;
    if !path.exists() {
        return Ok(Library::default());
    }
    let raw = fs::read_to_string(&path)?;
    let lib: Library = serde_json::from_str(&raw)?;
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

#[tauri::command]
pub fn library_upsert(entry: LibraryEntry) -> AppResult<()> {
    let mut lib = read_index()?;
    if let Some(existing) = lib.videos.iter_mut().find(|v| v.id == entry.id) {
        *existing = entry;
    } else {
        lib.videos.push(entry);
    }
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

#[tauri::command]
pub fn library_set_status(
    id: String,
    status: LibraryStatus,
    error: Option<String>,
) -> AppResult<()> {
    let mut lib = read_index()?;
    if let Some(entry) = lib.videos.iter_mut().find(|v| v.id == id) {
        entry.status = status;
        entry.last_error = error;
    }
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
        }
    }

    #[test]
    fn upsert_creates_then_updates() {
        let _ = fs::remove_file(paths::library_index_path().unwrap());

        library_upsert(sample("a")).unwrap();
        let lib = library_list().unwrap();
        assert_eq!(lib.videos.len(), 1);

        let mut updated = sample("a");
        updated.title = "Updated".into();
        library_upsert(updated).unwrap();
        let lib = library_list().unwrap();
        assert_eq!(lib.videos.len(), 1);
        assert_eq!(lib.videos[0].title, "Updated");
    }

    #[test]
    fn set_status_updates_field() {
        let _ = fs::remove_file(paths::library_index_path().unwrap());
        library_upsert(sample("b")).unwrap();
        library_set_status("b".into(), LibraryStatus::Ready, None).unwrap();
        let entry = library_get("b".into()).unwrap().unwrap();
        assert_eq!(entry.status, LibraryStatus::Ready);
    }
}
