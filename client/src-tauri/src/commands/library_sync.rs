//! Cloud-sync Tauri commands for library entries (Plan 3, 2026-05-21).
//!
//! - POST /api/library/sync
//! - DELETE /api/library/sync/:id
//! - GET /api/library/list
//!
//! All session-auth via Bearer token read from `crate::auth::get_auth`.
//! Wire format + endpoint contract pinned in Plan 1's backend deploy
//! (whatsub-license/src/routes/library.ts). Update both sides in lockstep.
//!
//! HTTP follows the `commands::license` pattern: per-call reqwest::Client
//! with 30s timeout, manual JSON encode (no `json` feature on reqwest in
//! this crate), error-categorisation prefixes the TS layer can map to
//! friendly Chinese (`timeout:` / `connect:` / `http <N>:` / `parse:`).

use crate::auth;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

const API_BASE: &str = "https://whatsub.eversay.cc/api/library";
const NET_TIMEOUT_SECS: u64 = 30;

#[derive(Serialize)]
pub struct SyncOk {
    pub ok: bool,
    #[serde(rename = "syncedAt")]
    pub synced_at: i64,
}

#[derive(Serialize, Deserialize)]
pub struct CloudLibraryEntry {
    pub id: String,
    #[serde(rename = "youtubeId")]
    pub youtube_id: String,
    #[serde(rename = "sourceUrl")]
    pub source_url: String,
    pub title: String,
    #[serde(rename = "durationSec")]
    pub duration_sec: Option<i64>,
    #[serde(rename = "thumbUrl")]
    pub thumb_url: Option<String>,
    #[serde(rename = "syncedAt")]
    pub synced_at: i64,
}

#[tauri::command]
pub async fn library_sync_to_cloud<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<SyncOk, String> {
    // 1. Auth
    let auth_state = auth::get_auth(&app).ok_or_else(|| "auth_required".to_string())?;
    if !auth::is_valid(&auth_state) {
        return Err("auth_required".into());
    }

    // 2. Read library entry from disk
    let library = crate::commands::library::read_index()
        .map_err(|e| format!("library read: {e}"))?;
    let entry = library
        .videos
        .iter()
        .find(|v| v.id == id)
        .ok_or_else(|| "not_found".to_string())?
        .clone();

    // 3. Validation
    if entry.status != crate::commands::library::LibraryStatus::Ready {
        return Err("entry_not_ready".into());
    }
    let source_url = match &entry.source {
        crate::commands::library::LibrarySource::Url { url } => url.clone(),
        _ => return Err("only_youtube_sources_supported".into()),
    };
    let youtube_id = extract_youtube_id_rust(&source_url)
        .ok_or_else(|| "not_youtube".to_string())?;
    let video_dir = entry
        .video_dir
        .as_deref()
        .ok_or_else(|| "missing video_dir".to_string())?;
    let analysis_path = std::path::Path::new(video_dir).join("analysis.json");
    let transcript_path = std::path::Path::new(video_dir).join("transcript.srt");
    let analysis_text = std::fs::read_to_string(&analysis_path)
        .map_err(|e| format!("analysis read: {e}"))?;
    let transcript_text = std::fs::read_to_string(&transcript_path)
        .map_err(|e| format!("transcript read: {e}"))?;
    let analysis_json: serde_json::Value = serde_json::from_str(&analysis_text)
        .map_err(|e| format!("analysis parse: {e}"))?;

    // 4. POST
    let body = serde_json::json!({
        "id": entry.id,
        "youtubeId": youtube_id,
        "sourceUrl": source_url,
        "title": entry.title,
        "durationSec": entry.duration_sec as i64,
        "thumbUrl": format!("https://i.ytimg.com/vi/{youtube_id}/mqdefault.jpg"),
        "transcriptSrt": transcript_text,
        "analysisJson": analysis_json,
    });
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(NET_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("client build: {e}"))?;
    let resp = client
        .post(format!("{API_BASE}/sync"))
        .header("content-type", "application/json")
        .header(
            "authorization",
            format!("Bearer {}", auth_state.session_token),
        )
        .body(serde_json::to_string(&body).map_err(|e| format!("encode: {e}"))?)
        .send()
        .await
        .map_err(|e| categorise(&e))?;
    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "http {}: {}",
            status.as_u16(),
            truncate(&body_text, 200)
        ));
    }

    // 5. Persist syncedAt
    crate::commands::library::set_synced_at(&id, Some(now), None)
        .map_err(|e| format!("library write: {e}"))?;

    Ok(SyncOk {
        ok: true,
        synced_at: now,
    })
}

#[tauri::command]
pub async fn library_unsync_from_cloud<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<(), String> {
    let auth_state = auth::get_auth(&app).ok_or_else(|| "auth_required".to_string())?;
    if !auth::is_valid(&auth_state) {
        return Err("auth_required".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(NET_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("client build: {e}"))?;
    let resp = client
        .delete(format!("{API_BASE}/sync/{id}"))
        .header(
            "authorization",
            format!("Bearer {}", auth_state.session_token),
        )
        .send()
        .await
        .map_err(|e| categorise(&e))?;
    let status = resp.status();
    // 404 is OK from user POV: cloud entry is gone either way.
    if !status.is_success() && status.as_u16() != 404 {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "http {}: {}",
            status.as_u16(),
            truncate(&body_text, 200)
        ));
    }
    crate::commands::library::set_synced_at(&id, None, None)
        .map_err(|e| format!("library write: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn library_list_synced<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<CloudLibraryEntry>, String> {
    let auth_state = auth::get_auth(&app).ok_or_else(|| "auth_required".to_string())?;
    if !auth::is_valid(&auth_state) {
        return Err("auth_required".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(NET_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("client build: {e}"))?;
    let resp = client
        .get(format!("{API_BASE}/list"))
        .header(
            "authorization",
            format!("Bearer {}", auth_state.session_token),
        )
        .send()
        .await
        .map_err(|e| categorise(&e))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("read body: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "http {}: {}",
            status.as_u16(),
            truncate(&text, 200)
        ));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse: {e}"))?;
    let entries = parsed
        .get("entries")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "missing entries field".to_string())?;
    let mut out: Vec<CloudLibraryEntry> = Vec::with_capacity(entries.len());
    for v in entries {
        let entry: CloudLibraryEntry = serde_json::from_value(v.clone())
            .map_err(|e| format!("entry parse: {e}"))?;
        out.push(entry);
    }
    Ok(out)
}

fn extract_youtube_id_rust(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_lowercase();
    let is_yt = host == "youtu.be"
        || host == "youtube.com"
        || host == "www.youtube.com"
        || host == "m.youtube.com";
    if !is_yt {
        return None;
    }
    if host == "youtu.be" {
        let id = parsed.path().trim_start_matches('/');
        return id_valid(id).then(|| id.to_string());
    }
    if parsed.path() == "/watch" {
        return parsed
            .query_pairs()
            .find(|(k, _)| k == "v")
            .and_then(|(_, v)| id_valid(&v).then(|| v.into_owned()));
    }
    for prefix in &["/embed/", "/shorts/"] {
        if let Some(rest) = parsed.path().strip_prefix(prefix) {
            let id = rest.split('/').next().unwrap_or("");
            if id_valid(id) {
                return Some(id.to_string());
            }
        }
    }
    None
}

fn id_valid(id: &str) -> bool {
    id.len() >= 6 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "..."
}

fn categorise(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        format!("timeout: {e}")
    } else if e.is_connect() {
        format!("connect: {e}")
    } else {
        format!("network: {e}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yt_id_from_watch() {
        assert_eq!(
            extract_youtube_id_rust("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".to_string())
        );
    }

    #[test]
    fn yt_id_from_short_url() {
        assert_eq!(
            extract_youtube_id_rust("https://youtu.be/dQw4w9WgXcQ?t=10"),
            Some("dQw4w9WgXcQ".to_string())
        );
    }

    #[test]
    fn yt_id_from_shorts() {
        assert_eq!(
            extract_youtube_id_rust("https://www.youtube.com/shorts/abc123XYZ_-"),
            Some("abc123XYZ_-".to_string())
        );
    }

    #[test]
    fn non_youtube_returns_none() {
        assert_eq!(
            extract_youtube_id_rust("https://www.bilibili.com/video/BV1xx411c7mu"),
            None
        );
    }
}
