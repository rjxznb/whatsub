//! Session token storage for whatSub cloud auth (Plan C).
//!
//! Uses tauri-plugin-store to persist the email + sessionToken + expiresAt
//! tuple in the OS app-data dir. Survives app restart; cleared by logout.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "auth.json";
const KEY_SESSION_TOKEN: &str = "sessionToken";
const KEY_EMAIL: &str = "email";
const KEY_EXPIRES_AT: &str = "expiresAt";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthState {
    pub session_token: String,
    pub email: String,
    pub expires_at: i64,
}

pub fn get_auth<R: Runtime>(app: &AppHandle<R>) -> Option<AuthState> {
    let store = app.store(STORE_FILE).ok()?;
    let token = store.get(KEY_SESSION_TOKEN)?.as_str()?.to_string();
    let email = store.get(KEY_EMAIL)?.as_str()?.to_string();
    let expires_at = store.get(KEY_EXPIRES_AT)?.as_i64()?;
    Some(AuthState { session_token: token, email, expires_at })
}

pub fn set_auth<R: Runtime>(app: &AppHandle<R>, auth: &AuthState) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(KEY_SESSION_TOKEN, serde_json::Value::String(auth.session_token.clone()));
    store.set(KEY_EMAIL, serde_json::Value::String(auth.email.clone()));
    store.set(KEY_EXPIRES_AT, serde_json::Value::Number(auth.expires_at.into()));
    store.save().map_err(|e| e.to_string())
}

pub fn clear_auth<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.delete(KEY_SESSION_TOKEN);
    store.delete(KEY_EMAIL);
    store.delete(KEY_EXPIRES_AT);
    store.save().map_err(|e| e.to_string())
}

pub fn is_valid(auth: &AuthState) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    auth.expires_at > now
}
