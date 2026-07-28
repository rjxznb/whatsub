//! Auth Tauri commands invoked from the React UI.
//! Wraps server HTTP calls + persists session via `crate::auth::*`.
//!
//! Note: reqwest is compiled without the `json` feature in this crate,
//! so we manually set Content-Type + serialize/deserialize bodies ourselves
//! (same pattern as `commands/license.rs`).

use crate::auth::{self, AuthState};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{future::Future, time::Duration};
use tauri::{AppHandle, Runtime};

const SERVER_BASE: &str = "https://whatsub.eversay.cc/api/license";

/// Auth HTTP client with the same 30s timeout discipline as `license.rs`.
/// Without a timeout, one stalled connection turns into an INFINITE spinner
/// in the login dialog / a permanently-unauthed corpus gate (2026-07-13).
fn http_client() -> Result<Client, AuthHttpError> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| AuthHttpError::Protocol)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthHttpError {
    Connect,
    Uncertain,
    Protocol,
}

impl AuthHttpError {
    fn from_send(error: &reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::Uncertain
        } else if error.is_connect() {
            Self::Connect
        } else {
            Self::Uncertain
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::Connect => "auth_connect_failed",
            Self::Uncertain => "auth_result_uncertain",
            Self::Protocol => "auth_protocol_error",
        }
    }
}

async fn retry_connect_only<T, Op, OpFuture, Sleep, SleepFuture>(
    mut operation: Op,
    mut sleep: Sleep,
) -> Result<T, AuthHttpError>
where
    Op: FnMut() -> OpFuture,
    OpFuture: Future<Output = Result<T, AuthHttpError>>,
    Sleep: FnMut(Duration) -> SleepFuture,
    SleepFuture: Future<Output = ()>,
{
    for delay in [Duration::from_millis(500), Duration::from_millis(1500)] {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(AuthHttpError::Connect) => sleep(delay).await,
            Err(error) => return Err(error),
        }
    }
    operation().await
}

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
    /// True iff iOS auto-renew sub is active OR a web_subscriptions row's
    /// expires_at > now. Added 2026-06-04 — used by LicenseGate to let
    /// pure subscribers (no license) into the desktop without buying a
    /// buyout SKU. Field is optional on the wire so older servers still
    /// deserialize cleanly.
    #[serde(rename = "hasActiveSubscription", default)]
    has_active_subscription: bool,
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
    /// Mirrors `MeResp.has_active_subscription`. Drives the desktop
    /// LicenseGate's SUB_ACTIVE branch (2026-06-04).
    #[serde(rename = "hasActiveSubscription")]
    pub has_active_subscription: Option<bool>,
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
) -> Result<(reqwest::StatusCode, serde_json::Value), AuthHttpError> {
    let resp = client
        .post(url)
        .header("content-type", "application/json")
        .body(body_bytes)
        .send()
        .await
        .map_err(|error| AuthHttpError::from_send(&error))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|_| AuthHttpError::Uncertain)?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| AuthHttpError::Protocol)?;
    Ok((status, value))
}

#[tauri::command]
pub async fn auth_send_code(email: String) -> Result<AuthResult, String> {
    let client = http_client().map_err(|error| error.code().to_string())?;
    let body = serde_json::to_string(&SendCodeReq { email: &email })
        .map_err(|_| AuthHttpError::Protocol.code().to_string())?;
    let (status, body_val) =
        post_json_body(&client, &format!("{}/auth/send-code", SERVER_BASE), body)
            .await
            .map_err(|error| error.code().to_string())?;
    if status.is_success() {
        Ok(AuthResult {
            ok: true,
            reason: None,
        })
    } else {
        Ok(AuthResult {
            ok: false,
            reason: Some(map_reason(&body_val)),
        })
    }
}

#[tauri::command]
pub async fn auth_verify_code<R: Runtime>(
    app: AppHandle<R>,
    email: String,
    code: String,
) -> Result<AuthResult, String> {
    let client = http_client().map_err(|error| error.code().to_string())?;
    let body = serde_json::to_string(&VerifyCodeReq {
        email: &email,
        code: &code,
    })
    .map_err(|_| AuthHttpError::Protocol.code().to_string())?;
    let url = format!("{}/auth/verify-code", SERVER_BASE);
    let (status, body_val) = retry_connect_only(
        || post_json_body(&client, &url, body.clone()),
        |delay| tokio::time::sleep(delay),
    )
    .await
    .map_err(|error| error.code().to_string())?;
    if status.is_success() {
        let v: VerifyCodeResp = serde_json::from_value(body_val)
            .map_err(|_| AuthHttpError::Protocol.code().to_string())?;
        auth::set_auth(
            &app,
            &AuthState {
                session_token: v.session_token,
                email: email.clone(),
                expires_at: v.expires_at,
            },
        )?;
        Ok(AuthResult {
            ok: true,
            reason: None,
        })
    } else {
        Ok(AuthResult {
            ok: false,
            reason: Some(map_reason(&body_val)),
        })
    }
}

fn build_me_request(client: &Client, token: &str) -> reqwest::RequestBuilder {
    client
        .get(format!("{}/auth/me", SERVER_BASE))
        .header("Authorization", format!("Bearer {}", token))
        .header("X-Whatsub-Client", "desktop")
}

#[tauri::command]
pub async fn auth_me<R: Runtime>(app: AppHandle<R>) -> Result<StatusResult, String> {
    let Some(auth) = auth::get_auth(&app) else {
        return Ok(StatusResult {
            authenticated: false,
            email: None,
            has_active_license: None,
            has_active_subscription: None,
        });
    };
    if !auth::is_valid(&auth) {
        let _ = auth::clear_auth(&app);
        return Ok(StatusResult {
            authenticated: false,
            email: None,
            has_active_license: None,
            has_active_subscription: None,
        });
    }
    let client = http_client().map_err(|error| error.code().to_string())?;
    let resp = build_me_request(&client, &auth.session_token)
        .send()
        .await
        .map_err(|error| AuthHttpError::from_send(&error).code().to_string())?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|_| AuthHttpError::Uncertain.code().to_string())?;
    if status.is_success() {
        let m: MeResp =
            serde_json::from_str(&text).map_err(|_| AuthHttpError::Protocol.code().to_string())?;
        Ok(StatusResult {
            authenticated: true,
            email: Some(m.email),
            has_active_license: Some(m.has_active_license),
            has_active_subscription: Some(m.has_active_subscription),
        })
    } else {
        // Token rejected — drop it locally too
        let _ = auth::clear_auth(&app);
        Ok(StatusResult {
            authenticated: false,
            email: None,
            has_active_license: None,
            has_active_subscription: None,
        })
    }
}

#[tauri::command]
pub async fn auth_logout<R: Runtime>(app: AppHandle<R>) -> Result<AuthResult, String> {
    if let Some(auth) = auth::get_auth(&app) {
        let client = http_client().map_err(|error| error.code().to_string())?;
        let _ = client
            .post(format!("{}/auth/logout", SERVER_BASE))
            .header("Authorization", format!("Bearer {}", auth.session_token))
            .send()
            .await; // fire-and-forget — clear local regardless
    }
    auth::clear_auth(&app)?;
    Ok(AuthResult {
        ok: true,
        reason: None,
    })
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

/// Return the raw session token (and whether it is still valid) to the
/// TS frontend. Used by the import-queue API client so it can attach a
/// Bearer header without going through a Rust command for every HTTP call.
/// Returns `None` when not logged in or the token has expired.
#[tauri::command]
pub async fn get_session_token<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let Some(auth) = auth::get_auth(&app) else {
        return Ok(None);
    };
    if !auth::is_valid(&auth) {
        return Ok(None);
    }
    Ok(Some(auth.session_token))
}

/// Exchange a license key for a session token.
/// Calls `POST /auth/from-license` and persists the resulting session locally.
/// Email is left empty — `auth_me` must be called after to populate it.
#[tauri::command]
pub async fn auth_from_license<R: Runtime>(
    app: AppHandle<R>,
    license_key: String,
) -> Result<AuthResult, String> {
    let client = http_client().map_err(|error| error.code().to_string())?;
    let body = serde_json::to_string(&FromLicenseReq {
        license_key: &license_key,
    })
    .map_err(|_| AuthHttpError::Protocol.code().to_string())?;
    let (status, body_val) =
        post_json_body(&client, &format!("{}/auth/from-license", SERVER_BASE), body)
            .await
            .map_err(|error| error.code().to_string())?;
    if status.is_success() {
        let v: FromLicenseResp = serde_json::from_value(body_val)
            .map_err(|_| AuthHttpError::Protocol.code().to_string())?;
        auth::set_auth(
            &app,
            &AuthState {
                session_token: v.session_token,
                email: String::new(),
                expires_at: v.expires_at,
            },
        )?;
        Ok(AuthResult {
            ok: true,
            reason: None,
        })
    } else {
        Ok(AuthResult {
            ok: false,
            reason: Some(map_reason(&body_val)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, future::ready, time::Duration};

    #[tokio::test]
    async fn retry_connect_only_retries_twice_with_fixed_delays_then_succeeds() {
        let attempts = RefCell::new(0);
        let delays = RefCell::new(Vec::new());

        let result = retry_connect_only(
            || {
                let attempt = {
                    let mut attempts = attempts.borrow_mut();
                    *attempts += 1;
                    *attempts
                };
                ready(if attempt < 3 {
                    Err(AuthHttpError::Connect)
                } else {
                    Ok("verified")
                })
            },
            |delay| {
                delays.borrow_mut().push(delay);
                ready(())
            },
        )
        .await;

        assert_eq!(result, Ok("verified"));
        assert_eq!(*attempts.borrow(), 3);
        assert_eq!(
            *delays.borrow(),
            [Duration::from_millis(500), Duration::from_millis(1500)]
        );
    }

    #[tokio::test]
    async fn retry_connect_only_stops_after_three_connection_failures() {
        let attempts = RefCell::new(0);
        let delays = RefCell::new(Vec::new());

        let result: Result<(), AuthHttpError> = retry_connect_only(
            || {
                *attempts.borrow_mut() += 1;
                ready(Err(AuthHttpError::Connect))
            },
            |delay| {
                delays.borrow_mut().push(delay);
                ready(())
            },
        )
        .await;

        assert_eq!(result.unwrap_err().code(), "auth_connect_failed");
        assert_eq!(*attempts.borrow(), 3);
        assert_eq!(
            *delays.borrow(),
            [Duration::from_millis(500), Duration::from_millis(1500)]
        );
    }

    #[tokio::test]
    async fn retry_connect_only_does_not_retry_uncertain_errors() {
        let attempts = RefCell::new(0);
        let delays = RefCell::new(Vec::new());

        let result: Result<(), AuthHttpError> = retry_connect_only(
            || {
                *attempts.borrow_mut() += 1;
                ready(Err(AuthHttpError::Uncertain))
            },
            |delay| {
                delays.borrow_mut().push(delay);
                ready(())
            },
        )
        .await;

        assert_eq!(result.unwrap_err().code(), "auth_result_uncertain");
        assert_eq!(*attempts.borrow(), 1);
        assert!(delays.borrow().is_empty());
    }

    #[tokio::test]
    async fn retry_connect_only_does_not_retry_protocol_errors() {
        let attempts = RefCell::new(0);
        let delays = RefCell::new(Vec::new());

        let result: Result<(), AuthHttpError> = retry_connect_only(
            || {
                *attempts.borrow_mut() += 1;
                ready(Err(AuthHttpError::Protocol))
            },
            |delay| {
                delays.borrow_mut().push(delay);
                ready(())
            },
        )
        .await;

        assert_eq!(result.unwrap_err().code(), "auth_protocol_error");
        assert_eq!(*attempts.borrow(), 1);
        assert!(delays.borrow().is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn me_request_identifies_desktop_client() {
        let request = build_me_request(&reqwest::Client::new(), "TOK")
            .build()
            .expect("request builds");
        assert_eq!(
            request.headers().get("X-Whatsub-Client").unwrap(),
            "desktop",
        );
        assert_eq!(request.headers().get("Authorization").unwrap(), "Bearer TOK");
    }
}
