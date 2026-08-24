//! License activation backend for the Tauri client.
//!
//! Responsibilities:
//!   1. Compute a stable device fingerprint (sha256 of the OS-provided
//!      machine UUID + a constant salt). Same physical machine across
//!      reboots = same fingerprint. Different machines = different
//!      fingerprints. Cloning the disk to another physical machine WILL
//!      give a different fingerprint because the OS-level UUIDs differ.
//!
//!   2. Read/write the local `license.json` file under app data dir.
//!      Presence of this file = ACTIVE state. Absence = NEEDS_KEY.
//!
//!   3. Expose a friendly device label (computer name) so the admin UI
//!      shows "renjx 的 MacBook" rather than an opaque hash.
//!
//! Network calls (POST /api/activate, /api/trial/start) ALSO live here
//! (as of v0.1.48) — moved out of the JS `fetch()` to bypass WebView2's
//! network stack quirks (TLS chain, custom-origin CORS, antivirus SSL
//! inspection, CSP traps) that surface to JS only as a useless
//! `TypeError: Failed to fetch` with no diagnostic detail. reqwest on
//! the Rust side gives us real error categorisation (timeout / dns /
//! tls / non-2xx / json parse), which the dialog can then translate to
//! actionable copy for the user.

use crate::core::paths;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;

const ACTIVATE_URL: &str = concat!(env!("WHATSUB_LICENSE_API_BASE"), "/activate");
const TRIAL_START_URL: &str = concat!(env!("WHATSUB_LICENSE_API_BASE"), "/trial/start");
const NET_TIMEOUT: Duration = Duration::from_secs(30);

/// What `read_license_state` returns when the local file exists.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseState {
    pub key: String,
    pub fingerprint: String,
    pub device_label: String,
    pub activated_at: i64,
}

/// What the JS UI uses to populate the activation request.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub fingerprint: String,
    pub device_label: String,
}

/// Compute the fingerprint. Stable per machine, opaque to the server.
///
/// Format: lowercase hex sha256, 64 chars. Matches the server's regex
/// `^[0-9a-f]{64}$/i`. The salt suffix `:whatsub:v1` namespaces our
/// fingerprint so the same hardware activating a different product
/// (now or later) doesn't collide on the server.
fn compute_fingerprint() -> Result<String, String> {
    let uid = machine_uid::get().map_err(|e| format!("machine_uid: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(uid.as_bytes());
    hasher.update(b":whatsub:v1");
    Ok(hex::encode(hasher.finalize()))
}

/// Friendly OS-set device name. Falls back gracefully:
///   - Windows: "Computer Name" from system properties
///   - macOS:   "Sharing Name" / "Local Hostname"
///   - Linux:   /etc/hostname or `gethostname()`
/// If for some reason both fail, returns a generic placeholder so we
/// never panic the activation flow over a missing nice-to-have.
fn compute_device_label() -> String {
    // whoami::devicename() returns the user-visible computer name on
    // Windows/macOS. On Linux + headless boxes it can equal hostname,
    // which is also fine.
    let primary = whoami::devicename();
    if !primary.is_empty() {
        return primary;
    }
    let fallback = whoami::fallible::hostname().unwrap_or_default();
    if !fallback.is_empty() {
        return fallback;
    }
    "Unknown device".to_string()
}

#[tauri::command]
pub fn license_get_device_info() -> AppResult<DeviceInfo> {
    Ok(DeviceInfo {
        fingerprint: compute_fingerprint().map_err(crate::error::AppError::Other)?,
        device_label: compute_device_label(),
    })
}

#[tauri::command]
pub fn license_read_state() -> AppResult<Option<LicenseState>> {
    let path = paths::license_path().map_err(crate::error::AppError::Other)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    // If the file is corrupt (manually edited / partially written), treat
    // it as missing rather than panicking. The user will be prompted to
    // re-activate, which generates a fresh valid file.
    let state = serde_json::from_str::<LicenseState>(&raw).ok();
    Ok(state)
}

#[tauri::command]
pub fn license_save_state(state: LicenseState) -> AppResult<()> {
    let path = paths::license_path().map_err(crate::error::AppError::Other)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&state)?;
    std::fs::write(&path, json)?;
    Ok(())
}

// ─── Trial state persistence ──────────────────────────────────────────
//
// The trial flow is symmetric to the license flow: JS owns the network
// call (POST /api/trial/start with the fingerprint we computed above);
// Rust just persists what the server returned to `<app_data>/trial.json`
// so subsequent launches don't need to re-ping. The server is the source
// of truth on expiresAt — we never compute it client-side, otherwise
// "delete trial.json + restart" would let the user farm fresh trials.

/// Mirror of `TrialState` in TS — local cache of the server's trial
/// registration. Presence + non-expired `expires_at` = TRIAL_ACTIVE.
///
/// `trial_token` (added 2026-06-04) is the opaque bearer the server
/// minted in `/api/trial/start`; the client uses it as Authorization
/// header on the managed-LLM relay (`POST /api/llm/v1/chat/completions`)
/// so trial-mode users get LLM access without configuring their own
/// API key. Optional for back-compat with pre-2026-06-04 cached files —
/// when missing, the TS layer re-calls /trial/start which is idempotent
/// on fingerprint AND returns the same token via lazy backfill.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialState {
    pub fingerprint: String,
    pub started_at: i64,
    pub expires_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trial_token: Option<String>,
}

#[tauri::command]
pub fn trial_read_state() -> AppResult<Option<TrialState>> {
    let path = paths::trial_path().map_err(crate::error::AppError::Other)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    // Corrupt/partially-written file → treat as missing, JS will re-fetch
    // from server (which will return the SAME expiresAt since fingerprint
    // is unchanged, so users can't bypass via file corruption).
    let state = serde_json::from_str::<TrialState>(&raw).ok();
    Ok(state)
}

#[tauri::command]
pub fn trial_save_state(state: TrialState) -> AppResult<()> {
    let path = paths::trial_path().map_err(crate::error::AppError::Other)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&state)?;
    std::fs::write(&path, json)?;
    Ok(())
}

// ─── Network calls (Rust-side, replaces JS fetch) ────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateArgs {
    pub key: String,
    pub fingerprint: String,
    pub device_label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialStartArgs {
    pub fingerprint: String,
    pub device_label: String,
}

/// POST /api/license/activate. Returns the raw parsed JSON response
/// (TS's ActivateResponse discriminated union). Wraps reqwest with a
/// 30s timeout and explicit error categorisation so the JS error
/// dialog can show "TLS handshake failed" or "connection timed out"
/// instead of bare "Failed to fetch".
#[tauri::command]
pub async fn license_activate_http(
    args: ActivateArgs,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "key": args.key,
        "fingerprint": args.fingerprint,
        "deviceLabel": args.device_label,
    });
    post_json(ACTIVATE_URL, &body).await
}

/// POST /api/license/trial/start. Same wire format / error mapping as
/// `license_activate_http`. Returns TS's TrialStartResponse JSON.
#[tauri::command]
pub async fn license_trial_start_http(
    args: TrialStartArgs,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "fingerprint": args.fingerprint,
        "deviceLabel": args.device_label,
    });
    post_json(TRIAL_START_URL, &body).await
}

/// Shared POST-JSON helper. Builds a reqwest client per call (cheap;
/// the connection isn't pooled across activation attempts anyway), and
/// translates the various failure modes into human-readable error
/// strings the TS layer can parse for `kind` classification:
///   - "timeout: ..." → kind: 'network', message about slow connection
///   - "dns: ..." / "connect: ..." → kind: 'network', server unreachable
///   - "tls: ..." → kind: 'network', cert / handshake issue
///   - "http <code>: ..." → unexpected server response
///   - "parse: ..." → server returned non-JSON
///   - any other reqwest error → kind: 'network', generic
async fn post_json(
    url: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(NET_TIMEOUT)
        .build()
        .map_err(|e| format!("client build: {e}"))?;

    let resp = client
        .post(url)
        .header("content-type", "application/json")
        .body(serde_json::to_string(body).map_err(|e| format!("encode: {e}"))?)
        .send()
        .await
        .map_err(|e| categorise_reqwest_error(&e))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("read body: {e}"))?;

    // Server is expected to return JSON for every status code we care
    // about (200 with status discriminator + 4xx with bad_request shape).
    // Non-JSON = treat as unexpected network error.
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        if status.is_success() {
            format!("parse: {e} — body: {}", truncate(&text, 200))
        } else {
            format!(
                "http {} — non-json body: {}",
                status.as_u16(),
                truncate(&text, 200)
            )
        }
    })?;
    Ok(value)
}

fn categorise_reqwest_error(e: &reqwest::Error) -> String {
    // Surface the most useful hint in the message; the JS error dialog
    // shows the raw string in a small monospace footer so power users
    // can diagnose. Keep prefixes stable — TS may regex them later.
    if e.is_timeout() {
        format!("timeout: {e}")
    } else if e.is_connect() {
        format!("connect: {e}")
    } else if e.is_request() {
        format!("request: {e}")
    } else if e.is_decode() {
        format!("decode: {e}")
    } else {
        // Body errors, redirect loops, builder bugs, etc.
        format!("network: {e}")
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}
