use crate::core::paths;
use crate::error::AppResult;
use serde_json::Value;
use std::path::Path;

pub fn lesson_state_load_from(path: &Path) -> AppResult<Option<Value>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(Some(v))
}

pub fn lesson_state_save_to(path: &Path, state: &Value) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn lesson_state_clear_at(path: &Path) -> AppResult<()> {
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn lesson_state_load() -> AppResult<Option<Value>> {
    lesson_state_load_from(&paths::lesson_state_path()?)
}

#[tauri::command]
pub fn lesson_state_save(state: Value) -> AppResult<()> {
    lesson_state_save_to(&paths::lesson_state_path()?, &state)
}

#[tauri::command]
pub fn lesson_state_clear() -> AppResult<()> {
    lesson_state_clear_at(&paths::lesson_state_path()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> std::path::PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut p = std::env::temp_dir();
        p.push(format!("whatsub_test_lesson_state_{}_{}.json", name, n));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn load_missing_returns_none() {
        let p = temp_path("missing");
        assert!(lesson_state_load_from(&p).unwrap().is_none());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let p = temp_path("roundtrip");
        let v = serde_json::json!({ "videoId": "abc", "currentAnchorIdx": 2 });
        lesson_state_save_to(&p, &v).unwrap();
        let back = lesson_state_load_from(&p).unwrap().unwrap();
        assert_eq!(back["videoId"], "abc");
        assert_eq!(back["currentAnchorIdx"], 2);
    }

    #[test]
    fn clear_removes_file() {
        let p = temp_path("clear");
        let v = serde_json::json!({});
        lesson_state_save_to(&p, &v).unwrap();
        assert!(p.exists());
        lesson_state_clear_at(&p).unwrap();
        assert!(!p.exists());
    }

    #[test]
    fn clear_missing_is_noop() {
        let p = temp_path("clear_missing");
        // No save first
        lesson_state_clear_at(&p).unwrap(); // should not error
    }
}
