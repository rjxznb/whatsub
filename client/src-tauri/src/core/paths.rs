use std::path::PathBuf;

pub fn app_data_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|d| d.join("whatsub"))
        .ok_or_else(|| "could not determine data dir".to_string())
}

pub fn settings_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("settings.json"))
}

pub fn library_index_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("library.json"))
}

pub fn vocabulary_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("vocabulary.json"))
}

pub fn license_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("license.json"))
}

/// Local copy of the trial registration returned by `/api/trial/start`.
/// Presence = TRIAL_ACTIVE state; absence + no license = call the server.
pub fn trial_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("trial.json"))
}

/// Returns %APPDATA%/whatsub/agent_history.json — AI agent conversation
/// history persistence (capped at 5MB; oldest conversations dropped first).
pub fn agent_history_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("agent_history.json"))
}

/// Multi-site cookie jar (JSON, source of truth). Holds per-site
/// buckets keyed by site_key. Always re-derive cookies.txt from this.
pub fn cookies_jar_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("cookies.json"))
}

/// Netscape cookies.txt (derived from the jar). yt-dlp reads this via
/// `--cookies <path>` when `settings.cookieSource === "in-app"`.
pub fn cookies_txt_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("cookies.txt"))
}

/// Pre-multi-site path. Used only during the one-time migration in
/// cookie_jar::load(). Don't reference outside that flow.
pub fn legacy_youtube_cookies_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("yt-cookies.txt"))
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

/// Resolve a video's directory.
///
/// Order of precedence:
/// 1. The `videoDir` field stored in this entry's library.json record (frozen at import time).
/// 2. `library_dir()/<id>` — the default for fresh imports, also a sensible fallback for
///    legacy entries written before the `videoDir` field existed.
///
/// This means changing `settings.libraryDir` does NOT relocate existing videos —
/// each entry remembers where it was put.
pub fn video_dir(video_id: &str) -> Result<PathBuf, String> {
    if let Some(stored) = read_entry_video_dir(video_id) {
        if !stored.trim().is_empty() {
            return Ok(PathBuf::from(stored));
        }
    }
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

fn read_entry_video_dir(video_id: &str) -> Option<String> {
    let path = library_index_path().ok()?;
    if !path.exists() {
        return None;
    }
    let raw = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let videos = v.get("videos")?.as_array()?;
    for entry in videos {
        if entry.get("id").and_then(|x| x.as_str()) == Some(video_id) {
            return entry
                .get("videoDir")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_data_dir_contains_whatsub() {
        let p = app_data_dir().unwrap();
        assert!(p.to_string_lossy().contains("whatsub"));
    }

    #[test]
    fn video_dir_under_library() {
        let v = video_dir("abc123").unwrap();
        let l = library_dir().unwrap();
        assert!(v.starts_with(&l));
        assert!(v.ends_with("abc123"));
    }
}
