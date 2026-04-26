use crate::core::paths;
use crate::error::AppResult;
use serde_json::Value;
use std::fs;

#[tauri::command]
pub fn get_settings() -> AppResult<Value> {
    let path = paths::settings_path()?;
    if !path.exists() {
        return Ok(Value::Null);
    }
    let raw = fs::read_to_string(&path)?;
    let v: Value = serde_json::from_str(&raw)?;
    Ok(v)
}

#[tauri::command]
pub fn save_settings(settings: Value) -> AppResult<()> {
    let dir = paths::app_data_dir()?;
    fs::create_dir_all(&dir)?;
    let path = paths::settings_path()?;
    let pretty = serde_json::to_string_pretty(&settings)?;
    fs::write(&path, pretty)?;
    Ok(())
}

#[tauri::command]
pub fn settings_path_string() -> AppResult<String> {
    Ok(paths::settings_path()?.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn save_then_get_roundtrips() {
        let payload = json!({"llmProvider": "claude", "claude": {"apiKey": "k"}});
        save_settings(payload.clone()).unwrap();
        let back = get_settings().unwrap();
        assert_eq!(back, payload);
    }
}
