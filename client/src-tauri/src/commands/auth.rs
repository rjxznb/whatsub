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
        Self::from_send_flags(error.is_timeout(), error.is_connect())
    }

    fn from_send_flags(is_timeout: bool, is_connect: bool) -> Self {
        if is_timeout {
            Self::Uncertain
        } else if is_connect {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthEndpoint {
    SendCode,
    VerifyCode,
    Me,
    FromLicense,
}

impl AuthEndpoint {
    fn url(self) -> String {
        let path = match self {
            Self::SendCode => "/auth/send-code",
            Self::VerifyCode => "/auth/verify-code",
            Self::Me => "/auth/me",
            Self::FromLicense => "/auth/from-license",
        };
        format!("{SERVER_BASE}{path}")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthRequestPolicy {
    Once,
    RetryConnect,
}

fn auth_request_policy(endpoint: AuthEndpoint) -> AuthRequestPolicy {
    match endpoint {
        AuthEndpoint::VerifyCode => AuthRequestPolicy::RetryConnect,
        AuthEndpoint::SendCode | AuthEndpoint::Me | AuthEndpoint::FromLicense => {
            AuthRequestPolicy::Once
        }
    }
}

async fn execute_auth_request<T, Op, OpFuture, Sleep, SleepFuture>(
    endpoint: AuthEndpoint,
    mut operation: Op,
    sleep: Sleep,
) -> Result<T, AuthHttpError>
where
    Op: FnMut() -> OpFuture,
    OpFuture: Future<Output = Result<T, AuthHttpError>>,
    Sleep: FnMut(Duration) -> SleepFuture,
    SleepFuture: Future<Output = ()>,
{
    match auth_request_policy(endpoint) {
        AuthRequestPolicy::Once => operation().await,
        AuthRequestPolicy::RetryConnect => retry_connect_only(operation, sleep).await,
    }
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
    let url = AuthEndpoint::SendCode.url();
    let (status, body_val) = execute_auth_request(
        AuthEndpoint::SendCode,
        || post_json_body(&client, &url, body.clone()),
        |delay| tokio::time::sleep(delay),
    )
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
    let url = AuthEndpoint::VerifyCode.url();
    let (status, body_val) = execute_auth_request(
        AuthEndpoint::VerifyCode,
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
    let resp = execute_auth_request(
        AuthEndpoint::Me,
        || {
            let request = build_me_request(&client, &auth.session_token);
            async move {
                request
                    .send()
                    .await
                    .map_err(|error| AuthHttpError::from_send(&error))
            }
        },
        |delay| tokio::time::sleep(delay),
    )
    .await
    .map_err(|error| error.code().to_string())?;
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
    let url = AuthEndpoint::FromLicense.url();
    let (status, body_val) = execute_auth_request(
        AuthEndpoint::FromLicense,
        || post_json_body(&client, &url, body.clone()),
        |delay| tokio::time::sleep(delay),
    )
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
    use std::{
        cell::RefCell,
        future::ready,
        io::{Read, Write},
        net::TcpListener,
        thread::JoinHandle,
        time::Duration,
    };

    fn local_test_client(timeout: Duration) -> Client {
        Client::builder()
            .no_proxy()
            .timeout(timeout)
            .build()
            .expect("localhost test client should build")
    }

    fn spawn_raw_http_response(response: Vec<u8>) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("localhost listener should bind");
        let address = listener
            .local_addr()
            .expect("localhost listener should have an address");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("test request should connect");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            stream
                .write_all(&response)
                .expect("test response should write");
        });
        (format!("http://{address}/auth-test"), server)
    }

    fn spawn_json_response(status: &str, body: &str) -> (String, JoinHandle<()>) {
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        spawn_raw_http_response(response.into_bytes())
    }

    #[test]
    fn send_error_classification_prioritizes_timeout_over_connect() {
        assert_eq!(
            AuthHttpError::from_send_flags(true, true),
            AuthHttpError::Uncertain
        );
        assert_eq!(
            AuthHttpError::from_send_flags(false, true),
            AuthHttpError::Connect
        );
    }

    #[tokio::test]
    async fn reqwest_timeout_maps_to_uncertain() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("localhost listener should bind");
        let address = listener
            .local_addr()
            .expect("localhost listener should have an address");
        let server = std::thread::spawn(move || {
            let (_stream, _) = listener.accept().expect("test request should connect");
            std::thread::sleep(Duration::from_millis(200));
        });

        let error = local_test_client(Duration::from_millis(50))
            .get(format!("http://{address}/auth-test"))
            .send()
            .await
            .expect_err("stalled localhost response should time out");
        server.join().expect("test server should exit");

        assert!(error.is_timeout());
        assert_eq!(AuthHttpError::from_send(&error), AuthHttpError::Uncertain);
    }

    #[tokio::test]
    async fn post_json_body_returns_http_4xx_status_and_business_body() {
        let (url, server) = spawn_json_response("400 Bad Request", r#"{"error":"bad_code"}"#);

        let result = post_json_body(
            &local_test_client(Duration::from_secs(1)),
            &url,
            "{}".to_string(),
        )
        .await;
        server.join().expect("test server should exit");

        let (status, body) = result.expect("HTTP errors are transport successes");
        assert_eq!(status, reqwest::StatusCode::BAD_REQUEST);
        assert_eq!(body, serde_json::json!({ "error": "bad_code" }));
    }

    #[tokio::test]
    async fn post_json_body_maps_malformed_json_to_protocol() {
        let (url, server) = spawn_json_response("200 OK", "not-json");

        let result = post_json_body(
            &local_test_client(Duration::from_secs(1)),
            &url,
            "{}".to_string(),
        )
        .await;
        server.join().expect("test server should exit");

        assert_eq!(result.unwrap_err(), AuthHttpError::Protocol);
    }

    #[tokio::test]
    async fn post_json_body_maps_truncated_body_to_uncertain() {
        let body = br#"{"ok":true}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len() + 10
        )
        .into_bytes()
        .into_iter()
        .chain(body.iter().copied())
        .collect();
        let (url, server) = spawn_raw_http_response(response);

        let result = post_json_body(
            &local_test_client(Duration::from_secs(1)),
            &url,
            "{}".to_string(),
        )
        .await;
        server.join().expect("test server should exit");

        assert_eq!(result.unwrap_err(), AuthHttpError::Uncertain);
    }

    #[test]
    fn endpoint_policy_retries_only_verify_code() {
        assert_eq!(
            auth_request_policy(AuthEndpoint::VerifyCode),
            AuthRequestPolicy::RetryConnect
        );
        for endpoint in [
            AuthEndpoint::SendCode,
            AuthEndpoint::Me,
            AuthEndpoint::FromLicense,
        ] {
            assert_eq!(auth_request_policy(endpoint), AuthRequestPolicy::Once);
        }
    }

    #[tokio::test]
    async fn verify_policy_does_not_retry_http_business_result() {
        let attempts = RefCell::new(0);
        let delays = RefCell::new(Vec::new());

        let result: Result<(reqwest::StatusCode, serde_json::Value), AuthHttpError> =
            execute_auth_request(
                AuthEndpoint::VerifyCode,
                || {
                    *attempts.borrow_mut() += 1;
                    ready(Ok((
                        reqwest::StatusCode::BAD_REQUEST,
                        serde_json::json!({ "error": "bad_code" }),
                    )))
                },
                |delay| {
                    delays.borrow_mut().push(delay);
                    ready(())
                },
            )
            .await;

        let (status, body) = result.expect("HTTP business response should stay successful");
        assert_eq!(status, reqwest::StatusCode::BAD_REQUEST);
        assert_eq!(body, serde_json::json!({ "error": "bad_code" }));
        assert_eq!(*attempts.borrow(), 1);
        assert!(delays.borrow().is_empty());
    }

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
