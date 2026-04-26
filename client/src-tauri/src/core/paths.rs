use std::path::PathBuf;

pub fn app_data_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|d| d.join("Get_Video"))
        .ok_or_else(|| "could not determine data dir".to_string())
}

pub fn library_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("library"))
}

pub fn models_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("models"))
}

pub fn settings_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("settings.json"))
}

pub fn library_index_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("library.json"))
}

pub fn video_dir(video_id: &str) -> Result<PathBuf, String> {
    Ok(library_dir()?.join(video_id))
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
