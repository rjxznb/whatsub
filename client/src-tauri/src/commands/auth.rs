//! Auth Tauri commands invoked from the React UI.
//! Wraps server HTTP calls + persists session via `crate::auth::*`.
//!
//! Note: reqwest is compiled without the `json` feature in this crate,
//! so we manually set Content-Type + serialize/deserialize bodies ourselves
//! (same pattern as `commands/license.rs`).

use crate::auth::{self, AuthState};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

const SERVER_BASE: &str = "https://whatsub.eversay.cc/api/license";

#[derive(Serialize)]
struct SendCodeReq<'a> {
    email: &'a str,
}

#[derive(Serialize)]
struct VerifyCodeReq<'a> {
    email: &'a str,
    code: &'a str,
}

#[derive(Deserialize)]
struct VerifyCodeResp {
    #[serde(rename = "sessionToken")]
    session_token: String,
    #[serde(rename = "expiresAt")]
    expires_at: i64,
}

#[derive(Deserialize)]
struct MeResp {
    email: String,
    #[serde(rename = "hasActiveLicense")]
    has_active_license: bool,
}

#[derive(Serialize)]
pub struct AuthResult {
    pub ok: bool,
    pub reason: Option<String>,
}

#[derive(Serialize)]
pub struct StatusResult {
    pub authenticated: bool,
    pub email: Option<String>,
    #[serde(rename = "hasActiveLicense")]
    pub has_active_license: Option<bool>,
}

fn map_reason(body: &serde_json::Value) -> String {
    body.get("error")
        .and_then(|e| e.as_str())
        .or_else(|| body.get("reason").and_then(|r| r.as_str()))
        .unwrap_or("unknown")
        .to_string()
}

/// POST JSON body to `url`, return the parsed response value.
/// Mirrors the approach in `license.rs` (no reqwest `json` feature).
async fn post_json_body(
    client: &Client,
    url: &str,
    body_bytes: String,
) -> Result<(reqwest::StatusCode, serde_json::Value), String> {
    let resp = client
        .post(url)
        .header("content-type", "application/json")
        .body(body_bytes)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let value: serde_json::Value =
        serde_json::from_str(&text).unwrap_or(serde_json::json!({}));
    Ok((status, value))
}

#[tauri::command]
pub async fn auth_send_code(email: String) -> Result<AuthResult, String> {
    let client = Client::new();
    let body = serde_json::to_string(&SendCodeReq { email: &email })
        .map_err(|e| e.to_string())?;
    let (status, body_val) =
        post_json_body(&client, &format!("{}/auth/send-code", SERVER_BASE), body).await?;
    if status.is_success() {
        Ok(AuthResult { ok: true, reason: None })
    } else {
        Ok(AuthResult { ok: false, reason: Some(map_reason(&body_val)) })
    }
}

#[tauri::command]
pub async fn auth_verify_code<R: Runtime>(
    app: AppHandle<R>,
    email: String,
    code: String,
) -> Result<AuthResult, String> {
    let client = Client::new();
    let body = serde_json::to_string(&VerifyCodeReq { email: &email, code: &code })
        .map_err(|e| e.to_string())?;
    let (status, body_val) =
        post_json_body(&client, &format!("{}/auth/verify-code", SERVER_BASE), body).await?;
    if status.is_success() {
        let v: VerifyCodeResp =
            serde_json::from_value(body_val).map_err(|e| e.to_string())?;
        auth::set_auth(
            &app,
            &AuthState {
                session_token: v.session_token,
                email: email.clone(),
                expires_at: v.expires_at,
            },
        )?;
        Ok(AuthResult { ok: true, reason: None })
    } else {
        Ok(AuthResult { ok: false, reason: Some(map_reason(&body_val)) })
    }
}

#[tauri::command]
pub async fn auth_me<R: Runtime>(app: AppHandle<R>) -> Result<StatusResult, String> {
    let Some(auth) = auth::get_auth(&app) else {
        return Ok(StatusResult {
            authenticated: false,
            email: None,
            has_active_license: None,
        });
    };
    if !auth::is_valid(&auth) {
        let _ = auth::clear_auth(&app);
        return Ok(StatusResult {
            authenticated: false,
            email: None,
            has_active_license: None,
        });
    }
    let client = Client::new();
    let resp = client
        .get(format!("{}/auth/me", SERVER_BASE))
        .header("Authorization", format!("Bearer {}", auth.session_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        let m: MeResp =
            serde_json::from_str(&text).map_err(|e| e.to_string())?;
        Ok(StatusResult {
            authenticated: true,
            email: Some(m.email),
            has_active_license: Some(m.has_active_license),
        })
    } else {
        // Token rejected — drop it locally too
        let _ = auth::clear_auth(&app);
        Ok(StatusResult {
            authenticated: false,
            email: None,
            has_active_license: None,
        })
    }
}

#[tauri::command]
pub async fn auth_logout<R: Runtime>(app: AppHandle<R>) -> Result<AuthResult, String> {
    if let Some(auth) = auth::get_auth(&app) {
        let client = Client::new();
        let _ = client
            .post(format!("{}/auth/logout", SERVER_BASE))
            .header("Authorization", format!("Bearer {}", auth.session_token))
            .send()
            .await; // fire-and-forget — clear local regardless
    }
    auth::clear_auth(&app)?;
    Ok(AuthResult { ok: true, reason: None })
}

#[derive(Serialize)]
struct FromLicenseReq<'a> {
    #[serde(rename = "licenseKey")]
    license_key: &'a str,
}

#[derive(Deserialize)]
struct FromLicenseResp {
    #[serde(rename = "sessionToken")]
    session_token: String,
    #[serde(rename = "expiresAt")]
    expires_at: i64,
}

/// Exchange a license key for a session token.
/// Calls `POST /auth/from-license` and persists the resulting session locally.
/// Email is left empty — `auth_me` must be called after to populate it.
#[tauri::command]
pub async fn auth_from_license<R: Runtime>(
    app: AppHandle<R>,
    license_key: String,
) -> Result<AuthResult, String> {
    let client = Client::new();
    let body = serde_json::to_string(&FromLicenseReq { license_key: &license_key })
        .map_err(|e| e.to_string())?;
    let (status, body_val) =
        post_json_body(&client, &format!("{}/auth/from-license", SERVER_BASE), body).await?;
    if status.is_success() {
        let v: FromLicenseResp =
            serde_json::from_value(body_val).map_err(|e| e.to_string())?;
        auth::set_auth(
            &app,
            &AuthState {
                session_token: v.session_token,
                email: String::new(),
                expires_at: v.expires_at,
            },
        )?;
        Ok(AuthResult { ok: true, reason: None })
    } else {
        Ok(AuthResult { ok: false, reason: Some(map_reason(&body_val)) })
    }
}
