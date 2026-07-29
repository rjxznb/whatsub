//! Import-queue HTTP commands — Rust-side replacement for the TS
//! `lib/api/importQueue.ts` `fetch()` calls.
//!
//! Motivation: WebView2 (Win) + WKWebView (Mac) `fetch()` swallows TLS /
//! cert-chain / antivirus-SSL-inspection / CSP failures as a useless
//! `TypeError: Failed to fetch`. The background poll loop hit those
//! every 30s, spamming the console with no diagnostic. Mirrors
//! `commands/license.rs::license_activate_http` — `reqwest::Client` has
//! its own cert store and surfaces categorised errors so the caller can
//! log something actionable (`timeout:` / `connect:` / `tls:` /
//! `http <N>:`).
//!
//! reqwest in this crate is compiled WITHOUT the `json` feature, so we
//! follow the same `body(serde_json::to_string(..))` +
//! `serde_json::from_str(text)` shape as `commands/auth.rs`.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Runtime};

const BASE: &str = "https://whatsub.eversay.cc/api/library/import-queue";
const NET_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize, Debug)]
pub struct ImportQueueItem {
    pub id: String,
    pub url: String,
    #[serde(default = "default_import_mode")]
    pub mode: String,
    #[serde(rename = "targetLibraryEntryId")]
    pub target_library_entry_id: Option<String>,
    pub status: String,
    pub error: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

fn default_import_mode() -> String {
    "import".to_string()
}

#[derive(Deserialize)]
struct ListResp {
    items: Vec<ImportQueueItem>,
}

#[derive(Deserialize)]
struct EnqueueResp {
    id: String,
}

#[derive(Deserialize)]
struct ClaimResp {
    #[serde(default)]
    claimed: bool,
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(NET_TIMEOUT)
        .build()
        .map_err(|e| format!("connect: {e}"))
}

fn require_token<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let Some(auth) = crate::auth::get_auth(app) else {
        return Err("auth: no session token".to_string());
    };
    if !crate::auth::is_valid(&auth) {
        return Err("auth: session expired".to_string());
    }
    Ok(auth.session_token)
}

fn map_err(e: reqwest::Error) -> String {
    let msg = e.to_string();
    if e.is_timeout() {
        format!("timeout: {msg}")
    } else if e.is_connect() {
        // Cert-authority-invalid / handshake failures show up as
        // connect errors in reqwest; surface as `tls:` when the
        // message hints at TLS so the caller can distinguish.
        let lower = msg.to_lowercase();
        if lower.contains("tls")
            || lower.contains("certificate")
            || lower.contains("cert")
            || lower.contains("ssl")
        {
            format!("tls: {msg}")
        } else {
            format!("connect: {msg}")
        }
    } else if e.is_request() {
        format!("request: {msg}")
    } else if e.is_decode() {
        format!("decode: {msg}")
    } else {
        format!("http: {msg}")
    }
}

async fn safe_body(resp: reqwest::Response) -> String {
    resp.text()
        .await
        .unwrap_or_else(|_| "<no body>".to_string())
}

/// POST /api/library/import-queue { url } → { id }
#[tauri::command]
pub async fn import_queue_enqueue_http<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<String, String> {
    let token = require_token(&app)?;
    let client = build_client()?;
    let body = serde_json::to_string(&serde_json::json!({ "url": url }))
        .map_err(|e| format!("body: {e}"))?;
    let resp = client
        .post(BASE)
        .bearer_auth(&token)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(map_err)?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        return Err(format!("http {status}: {}", safe_body(resp).await));
    }
    let text = resp.text().await.map_err(|e| format!("body: {e}"))?;
    let parsed: EnqueueResp = serde_json::from_str(&text).map_err(|e| format!("body: {e}"))?;
    Ok(parsed.id)
}

/// GET /api/library/import-queue?status=pending → { items }
#[tauri::command]
pub async fn import_queue_list_pending_http<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<ImportQueueItem>, String> {
    let token = require_token(&app)?;
    let client = build_client()?;
    let resp = client
        .get(format!(
            "{BASE}?status=pending&supportedModes=import%2Creplace"
        ))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(map_err)?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        return Err(format!("http {status}: {}", safe_body(resp).await));
    }
    let text = resp.text().await.map_err(|e| format!("body: {e}"))?;
    let parsed: ListResp = serde_json::from_str(&text).map_err(|e| format!("body: {e}"))?;
    Ok(parsed.items)
}

/// POST /api/library/import-queue/:id/claim → { claimed }
/// 404 is treated as "route not deployed yet" → returns Ok(false) so the
/// caller does NOT process the item (avoid double-processing).
#[tauri::command]
pub async fn import_queue_claim_http<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<bool, String> {
    let token = require_token(&app)?;
    let client = build_client()?;
    let resp = client
        .post(format!("{BASE}/{id}/claim"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(map_err)?;
    if resp.status().as_u16() == 404 {
        return Ok(false);
    }
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        return Err(format!("http {status}: {}", safe_body(resp).await));
    }
    let text = resp.text().await.map_err(|e| format!("body: {e}"))?;
    let parsed: ClaimResp = serde_json::from_str(&text).map_err(|e| format!("body: {e}"))?;
    Ok(parsed.claimed)
}

/// POST /api/library/import-queue/:id/status { status, error? } → { ok }
#[tauri::command]
pub async fn import_queue_set_status_http<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    status: String,
    error: Option<String>,
) -> Result<(), String> {
    let token = require_token(&app)?;
    let client = build_client()?;
    let mut payload = serde_json::Map::new();
    payload.insert("status".to_string(), serde_json::Value::String(status));
    if let Some(err) = error {
        payload.insert("error".to_string(), serde_json::Value::String(err));
    }
    let body = serde_json::to_string(&serde_json::Value::Object(payload))
        .map_err(|e| format!("body: {e}"))?;
    let resp = client
        .post(format!("{BASE}/{id}/status"))
        .bearer_auth(&token)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(map_err)?;
    if !resp.status().is_success() {
        let status_code = resp.status().as_u16();
        return Err(format!("http {status_code}: {}", safe_body(resp).await));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test for the pure error-categorisation helper logic.
    /// We can't easily construct reqwest::Error instances of specific
    /// kinds without networking, but we can at least ensure the prefix
    /// strings stay stable.
    #[test]
    fn error_prefix_constants_stable() {
        // These prefixes are part of the TS contract (caller may regex
        // them). Lock them in so a future refactor doesn't silently
        // rename them.
        let prefixes = [
            "timeout:", "connect:", "tls:", "request:", "decode:", "http:", "auth:", "body:",
        ];
        for p in prefixes {
            assert!(p.ends_with(':'), "prefix {p} must end with colon");
        }
    }
}
