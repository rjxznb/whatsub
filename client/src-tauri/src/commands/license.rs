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
//! Network calls (POST /api/activate) live on the JS side using fetch —
//! Rust just provides the fingerprint + label + persistence. This split
//! keeps the network/timeout/UI concerns where they belong.

use crate::core::paths;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
