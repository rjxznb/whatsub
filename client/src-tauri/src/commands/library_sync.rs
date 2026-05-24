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
pub async fn library_sync_to_cloud(
    app: AppHandle,
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
    // Generic: a real YouTube id when the source is YouTube (keeps the i.ytimg
    // cover + the iOS YouTube-embed fallback working); otherwise the entry's own
    // id (BV id / u_ hash). For non-YouTube the cover comes from thumbData (the
    // local ffmpeg thumb, built above) and playback from the OSS video below.
    let yt_id_opt = extract_youtube_id_rust(&source_url);
    let is_youtube = yt_id_opt.is_some();
    let youtube_id = yt_id_opt.unwrap_or_else(|| entry.id.clone());
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

    // Downscale local thumb.jpg → small JPEG → base64 (best-effort).
    let thumb_b64: Option<String> = {
        let thumb_src = std::path::Path::new(video_dir).join("thumb.jpg");
        let thumb_small = std::path::Path::new(video_dir).join("thumb_small.jpg");
        if thumb_src.exists() {
            match crate::pipeline::ffmpeg::downscale_jpeg(&app, &thumb_src, &thumb_small, 320, &id, None).await {
                Ok(()) => std::fs::read(&thumb_small).ok().map(|bytes| {
                    use base64::Engine;
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                }),
                Err(_) => None,
            }
        } else {
            None
        }
    };

    // Quota pre-check: only for NEW cloud videos (not re-syncs of an already-
    // uploaded entry). If used >= limit we return early WITHOUT uploading so no
    // orphan OSS object is created. If the GET /quota request itself fails
    // (network/parse) we fall through and let the POST /sync backstop enforce.
    if entry.synced_at.is_none() {
        #[derive(serde::Deserialize)]
        struct QuotaResp {
            used: i64,
            limit: i64,
        }
        let quota_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(NET_TIMEOUT_SECS))
            .build();
        if let Ok(qc) = quota_client {
            let quota_result = qc
                .get(format!("{API_BASE}/quota"))
                .header("authorization", format!("Bearer {}", auth_state.session_token))
                .send()
                .await;
            if let Ok(qresp) = quota_result {
                if let Ok(qtext) = qresp.text().await {
                    if let Ok(q) = serde_json::from_str::<QuotaResp>(&qtext) {
                        if q.used >= q.limit {
                            return Err(format!(
                                "quota_exceeded {{\"used\":{}, \"limit\":{}}}",
                                q.used, q.limit
                            ));
                        }
                    }
                }
            }
        }
    }

    // Transcode source.mp4 → 720p mobile.mp4, request a presigned PUT, upload
    // direct to OSS. Best-effort: any failure → no videoKey → iOS falls back to
    // the YouTube embed for this entry.
    let video_key: Option<String> =
        upload_video(&app, video_dir, &id, &auth_state.session_token).await;

    // 4. POST
    let body = serde_json::json!({
        "id": entry.id,
        "youtubeId": youtube_id,
        "sourceUrl": source_url,
        "title": entry.title,
        "durationSec": entry.duration_sec as i64,
        "thumbUrl": if is_youtube {
            serde_json::Value::String(format!("https://i.ytimg.com/vi/{youtube_id}/mqdefault.jpg"))
        } else {
            serde_json::Value::Null
        },
        "transcriptSrt": transcript_text,
        "analysisJson": analysis_json,
        "thumbData": thumb_b64,
        "videoKey": video_key,
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

    // Reconcile: a video deleted from the cloud elsewhere (e.g. the mobile app)
    // should lose its local "synced" badge. Clear synced_at for local entries
    // with it set that are absent from the cloud list. Best-effort — never fail
    // the listing on a reconcile hiccup.
    let cloud_ids: std::collections::HashSet<&str> =
        out.iter().map(|e| e.id.as_str()).collect();
    if let Ok(mut library) = crate::commands::library::read_index() {
        let mut changed = false;
        for v in library.videos.iter_mut() {
            if v.synced_at.is_some() && !cloud_ids.contains(v.id.as_str()) {
                v.synced_at = None;
                v.sync_error = None;
                changed = true;
            }
        }
        if changed {
            let _ = crate::commands::library::write_index(&library);
        }
    }

    Ok(out)
}

/// Transcode source.mp4 → 720p mobile.mp4, obtain a presigned PUT URL from
/// the backend, and upload straight to OSS. Returns the `videoKey` on success.
/// Fully best-effort: any step failure returns `None` (caller omits videoKey →
/// iOS falls back to the YouTube embed).
async fn upload_video(
    app: &AppHandle,
    video_dir: &str,
    id: &str,
    token: &str,
) -> Option<String> {
    let src = std::path::Path::new(video_dir).join("source.mp4");
    if !src.exists() {
        return None;
    }
    let mobile = std::path::Path::new(video_dir).join("mobile.mp4");

    // Step 1: transcode to 720p H.264 (never upscales)
    crate::pipeline::ffmpeg::transcode_720p(app, &src, &mobile, id, None)
        .await
        .ok()?;

    // Step 2: request a presigned PUT URL from the backend
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(NET_TIMEOUT_SECS))
        .build()
        .ok()?;

    #[derive(serde::Deserialize)]
    struct UploadUrl {
        #[serde(rename = "putUrl")]
        put_url: String,
        #[serde(rename = "videoKey")]
        video_key: String,
    }

    let uu_text = client
        .post(format!("{API_BASE}/upload-url"))
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .body(
            serde_json::json!({ "id": id, "contentType": "video/mp4" }).to_string(),
        )
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()?;
    let uu: UploadUrl = serde_json::from_str(&uu_text).ok()?;

    // Step 3: PUT the file straight to OSS.
    // Content-Type MUST exactly match the presigned signature ("video/mp4").
    // Use a separate client with a larger timeout — the payload can be 100s of MB.
    let bytes = std::fs::read(&mobile).ok()?;
    let put_resp = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(NET_TIMEOUT_SECS * 4))
        .build()
        .ok()?
        .put(&uu.put_url)
        .header("content-type", "video/mp4")
        .body(bytes)
        .send()
        .await
        .ok()?;

    if !put_resp.status().is_success() {
        return None;
    }

    // Clean up the temp transcoded file after a successful upload.
    let _ = std::fs::remove_file(&mobile);

    Some(uu.video_key)
}

#[tauri::command]
pub async fn library_materialize_from_cloud(app: AppHandle, id: String) -> Result<(), String> {
    let auth_state = auth::get_auth(&app).ok_or_else(|| "auth_required".to_string())?;
    if !auth::is_valid(&auth_state) {
        return Err("auth_required".into());
    }

    // 1. GET /api/library/entry/:id → full cloud entry
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(NET_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("client build: {e}"))?;
    let resp = client
        .get(format!("{API_BASE}/entry/{id}"))
        .header("authorization", format!("Bearer {}", auth_state.session_token))
        .send()
        .await
        .map_err(|e| categorise(&e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("read body: {e}"))?;
    if !status.is_success() {
        return Err(format!("http {}: {}", status.as_u16(), truncate(&text, 200)));
    }
    let entry_json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse: {e}"))?;

    let source_url = entry_json["sourceUrl"].as_str().unwrap_or_default().to_string();
    let title = entry_json["title"].as_str().unwrap_or("Untitled").to_string();
    let duration_sec_cloud = entry_json["durationSec"].as_f64().unwrap_or(0.0);
    let transcript = entry_json["transcriptSrt"].as_str().unwrap_or_default().to_string();
    let analysis = entry_json["analysisJson"].clone();
    if source_url.is_empty() {
        return Err("missing sourceUrl".into());
    }

    // 2. Download the video locally (reuse the import download path).
    let out_dir = crate::core::paths::video_dir(&id).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let dl = crate::pipeline::ytdlp::download(&app, &source_url, &out_dir, &id, "standard", true, None)
        .await
        .map_err(|e| e.to_string())?;

    // 3. Write transcript.srt + analysis.json from cloud data (NO re-whisper/re-LLM).
    std::fs::write(out_dir.join("transcript.srt"), &transcript).map_err(|e| e.to_string())?;
    crate::commands::analysis::save_analysis(id.clone(), analysis).map_err(|e| e.to_string())?;

    // 4. Build a full local library entry (status Ready, synced since it came from cloud).
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let duration_sec = if duration_sec_cloud > 0.0 { duration_sec_cloud } else { dl.duration_sec };
    let entry = crate::commands::library::LibraryEntry {
        id: id.clone(),
        title: if dl.title.is_empty() { title } else { dl.title },
        source: crate::commands::library::LibrarySource::Url { url: source_url },
        duration_sec,
        thumbnail_path: dl.thumb_path.clone(),
        created_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        status: crate::commands::library::LibraryStatus::Ready,
        last_error: None,
        video_dir: Some(out_dir.to_string_lossy().to_string()),
        analysis_style: None,
        synced_at: Some(now),
        sync_error: None,
    };
    crate::commands::library::library_upsert(entry).map_err(|e| e.to_string())?;
    Ok(())
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
