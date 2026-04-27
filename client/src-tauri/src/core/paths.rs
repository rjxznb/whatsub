use std::path::PathBuf;

pub fn app_data_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|d| d.join("Get_Video"))
        .ok_or_else(|| "could not determine data dir".to_string())
}

pub fn settings_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("settings.json"))
}

pub fn library_index_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("library.json"))
}

/// Custom library dir from settings, or `<app_data_dir>/library` by default.
pub fn library_dir() -> Result<PathBuf, String> {
    if let Some(custom) = read_settings_string("libraryDir") {
        if !custom.trim().is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }
    Ok(app_data_dir()?.join("library"))
}

/// Custom Whisper models dir from settings, or `<app_data_dir>/models` by default.
pub fn models_dir() -> Result<PathBuf, String> {
    if let Some(custom) = read_settings_string("modelsDir") {
        if !custom.trim().is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }
    Ok(app_data_dir()?.join("models"))
}

pub fn video_dir(video_id: &str) -> Result<PathBuf, String> {
    Ok(library_dir()?.join(video_id))
}

fn read_settings_string(key: &str) -> Option<String> {
    let path = settings_path().ok()?;
    if !path.exists() {
        return None;
    }
    let raw = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get(key)?.as_str().map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_data_dir_contains_get_video() {
        let p = app_data_dir().unwrap();
        assert!(p.to_string_lossy().contains("Get_Video"));
    }

    #[test]
    fn video_dir_under_library() {
        let v = video_dir("abc123").unwrap();
        let l = library_dir().unwrap();
        assert!(v.starts_with(&l));
        assert!(v.ends_with("abc123"));
    }
}
