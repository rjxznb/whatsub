//! Session token storage for whatSub cloud auth.
//!
//! Persists the {sessionToken, email, expiresAt} tuple as a plain JSON file at
//! `%APPDATA%/whatsub/auth.json` — the SAME hand-rolled app-data dir as
//! settings / license / trial (see core::paths). It previously used
//! tauri-plugin-store, which writes under `%APPDATA%/<bundle-identifier>/`
//! (com.whatsub.app) — a SEPARATE dir from everything else, so "clear local
//! state" by wiping `whatsub/` silently left the session token behind (which
//! is why a wiped install could still come up SUB_ACTIVE).
//!
//! `get_auth` migrates the old plugin-store file into the new location on
//! first read, so currently-logged-in users aren't signed out by the move.

use crate::core::paths;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    pub session_token: String,
    /// Usually empty — the server resolves email from the token. Kept for
    /// shape-compat with the old plugin-store file (and future use).
    #[serde(default)]
    pub email: String,
    pub expires_at: i64,
}

fn read_file(path: &PathBuf) -> Option<AuthState> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<AuthState>(&raw).ok()
}

fn write_file(path: &PathBuf, auth: &AuthState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(auth).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Old tauri-plugin-store location: `<app_data_dir-by-identifier>/auth.json`
/// (e.g. `%APPDATA%/com.whatsub.app/auth.json`). The plugin wrote the same
/// `{sessionToken, email, expiresAt}` JSON shape, so `read_file` parses it.
fn legacy_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("auth.json"))
}

pub fn get_auth<R: Runtime>(app: &AppHandle<R>) -> Option<AuthState> {
    let path = paths::auth_path().ok()?;
    if let Some(state) = read_file(&path) {
        return Some(state);
    }
    // One-time migration from the old plugin-store dir → whatsub/auth.json.
    let legacy = legacy_path(app)?;
    if legacy != path {
        if let Some(state) = read_file(&legacy) {
            let _ = write_file(&path, &state);
            let _ = std::fs::remove_file(&legacy);
            return Some(state);
        }
    }
    None
}

pub fn set_auth<R: Runtime>(_app: &AppHandle<R>, auth: &AuthState) -> Result<(), String> {
    write_file(&paths::auth_path()?, auth)
}

pub fn clear_auth<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let _ = std::fs::remove_file(paths::auth_path()?);
    // Also wipe any legacy copy so a stale token there can't resurrect the
    // session on the next launch (the migration in get_auth would re-import it).
    if let Some(legacy) = legacy_path(app) {
        let _ = std::fs::remove_file(legacy);
    }
    Ok(())
}

pub fn is_valid(auth: &AuthState) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    auth.expires_at > now
}
