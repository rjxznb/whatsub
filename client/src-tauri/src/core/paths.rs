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

/// 30-day cloud session bearer ({sessionToken, email, expiresAt}). Lives in
/// the same `whatsub/` dir as everything else; `auth.rs` migrates legacy
/// copies written by tauri-plugin-store under the bundle-identifier dir.
pub fn auth_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("auth.json"))
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

/// Returns %APPDATA%/whatsub/learner_profile.json — the persistent learner
/// model: error events + derived mastery index. Local only, never synced.
pub fn learner_profile_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("learner_profile.json"))
}

/// Returns %APPDATA%/whatsub/lesson_state.json — resume state for the most
/// recent in-progress guided lesson. Single-lesson at a time (no
/// multi-video resume queue). Deleted on lesson completion.
pub fn lesson_state_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("lesson_state.json"))
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
    // A video id is a YouTube / Bilibili-BV / sha256 handle — `[A-Za-z0-9_-]`,
    // never a path. Reject anything that could escape the library directory.
    // The AI agent's tools (delete_video → library_delete → remove_dir_all,
    // read_video_analysis → load_analysis, etc.) pass an LLM-supplied id
    // straight in; without this guard an id like `../../../Users/x/Documents`
    // would `join` past library_dir() and the OS would resolve the `..` at
    // remove/read time. Validate centrally so every caller is covered.
    if !is_safe_video_id(video_id) {
        return Err(format!("invalid video id: {video_id:?}"));
    }
    if let Some(stored) = read_entry_video_dir(video_id) {
        if !stored.trim().is_empty() {
            return Ok(PathBuf::from(stored));
        }
    }
    Ok(library_dir()?.join(video_id))
}

/// True only for ids that cannot traverse out of the library directory.
/// Rejects empty / `.` / `..`, any path separator, any embedded `..`, and
/// absolute paths (e.g. `C:\...` or `/etc/...`).
fn is_safe_video_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains("..")
        && !std::path::Path::new(id).is_absolute()
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

    #[test]
    fn video_dir_rejects_path_traversal() {
        for hostile in [
            "../../../etc",
            "..\\..\\Windows",
            "a/b",
            "a\\b",
            "..",
            "",
            "foo/../bar",
        ] {
            assert!(
                video_dir(hostile).is_err(),
                "expected {hostile:?} to be rejected"
            );
        }
        // An absolute path must not be accepted as an id either.
        assert!(video_dir("/etc/passwd").is_err());
    }
}
