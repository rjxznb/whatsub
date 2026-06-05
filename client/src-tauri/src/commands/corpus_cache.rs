//! Corpus SWR cache persistence.
//!
//! Stores the corpus version/list cache as a plain JSON `{key: value}` map at
//! `%APPDATA%/whatsub/corpus_cache.json` — the unified hand-rolled app-data dir
//! (see core::paths), NOT the tauri-plugin-store bundle-identifier dir
//! (`com.whatsub.app/`) it used to live in. `corpus_cache_load` migrates the
//! legacy plugin-store file on first read so the cache survives the move.

use crate::core::paths;
use crate::error::{AppError, AppResult};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn corpus_cache_load(app: AppHandle) -> AppResult<String> {
    let path = paths::corpus_cache_path().map_err(AppError::Other)?;
    if let Ok(s) = std::fs::read_to_string(&path) {
        return Ok(s);
    }
    // One-time migration from the old tauri-plugin-store location
    // (<app_data_dir-by-identifier>/corpus_cache.json). Same plain JSON shape.
    if let Ok(dir) = app.path().app_data_dir() {
        let legacy = dir.join("corpus_cache.json");
        if let Ok(s) = std::fs::read_to_string(&legacy) {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&path, &s);
            let _ = std::fs::remove_file(&legacy);
            return Ok(s);
        }
    }
    Ok("{}".to_string())
}

#[tauri::command]
pub fn corpus_cache_save(contents: String) -> AppResult<()> {
    let path = paths::corpus_cache_path().map_err(AppError::Other)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, contents)?;
    Ok(())
}
