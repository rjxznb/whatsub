use crate::core::paths;
use crate::error::AppResult;
use serde_json::Value;
use std::fs;
use std::path::Path;

fn get_settings_from(path: &Path) -> AppResult<Value> {
    if !path.exists() {
        return Ok(Value::Null);
    }
    let raw = fs::read_to_string(path)?;
    let v: Value = serde_json::from_str(&raw)?;
    Ok(v)
}

fn save_settings_to(path: &Path, settings: &Value) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let pretty = serde_json::to_string_pretty(settings)?;
    fs::write(path, pretty)?;
    Ok(())
}

#[tauri::command]
pub fn get_settings() -> AppResult<Value> {
    get_settings_from(&paths::settings_path()?)
}

#[tauri::command]
pub fn save_settings(settings: Value) -> AppResult<()> {
    save_settings_to(&paths::settings_path()?, &settings)
}

#[tauri::command]
pub fn settings_path_string() -> AppResult<String> {
    Ok(paths::settings_path()?.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    // ISOLATED-PATH TESTS ONLY. Do NOT call save_settings()/get_settings()
    // directly — they resolve to %APPDATA%\whatsub\settings.json (the user's
    // real settings). An earlier version of this test module did that, and
    // running `cargo test` overwrote the user's settings.json with
    // `{"llmProvider":"claude","claude":{"apiKey":"k"}}`, wiping their real
    // API keys. Always go through the *_from / *_to helpers with a unique
    // temp path.
    use super::*;
    use serde_json::json;

    fn temp_settings_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "whatsub-settings-test-{}-{}-{}.json",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        ))
    }

    #[test]
    fn save_then_get_roundtrips() {
        let path = temp_settings_path("roundtrip");
        let payload = json!({"llmProvider": "claude", "claude": {"apiKey": "k"}});

        save_settings_to(&path, &payload).unwrap();
        let back = get_settings_from(&path).unwrap();
        assert_eq!(back, payload);

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn get_settings_returns_null_when_missing() {
        let path = temp_settings_path("missing");
        // Ensure the path does not exist.
        let _ = fs::remove_file(&path);
        let v = get_settings_from(&path).unwrap();
        assert_eq!(v, Value::Null);
    }
}
