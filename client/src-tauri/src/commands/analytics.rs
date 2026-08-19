use crate::auth;
use crate::commands::license;
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Runtime};

const URL: &str = "https://whatsub.eversay.cc/api/license/analytics/funnel";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunnelEventArgs {
    pub event_name: String,
    pub occurred_at: Option<i64>,
    pub metadata: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn analytics_event_http<R: Runtime>(
    app: AppHandle<R>,
    args: FunnelEventArgs,
) -> Result<(), String> {
    let token = auth::get_auth(&app).filter(|v| v.expires_at > chrono::Utc::now().timestamp_millis())
        .map(|v| v.session_token)
        .or_else(|| license::trial_read_state().ok().flatten().and_then(|v| v.trial_token));
    let Some(token) = token else { return Ok(()); };
    let body = json!({
        "eventName": args.event_name,
        "occurredAt": args.occurred_at,
        "metadata": args.metadata.unwrap_or_else(|| json!({})),
    });
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build().map_err(|e| e.to_string())?;
    client.post(URL).header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .header("x-whatsub-client", "desktop")
        .body(body.to_string()).send().await.map_err(|e| e.to_string())?;
    Ok(())
}
