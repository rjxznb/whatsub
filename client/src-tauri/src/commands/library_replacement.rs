//! Queue-scoped media staging and atomic completion for Library replacements.
//!
//! This path is intentionally separate from `library_sync_to_cloud`: a
//! replacement must upload its video successfully and may become visible only
//! when the backend atomically updates the existing Library row and queue row.

use crate::auth;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

const API_BASE: &str = "https://whatsub.eversay.cc/api/library";
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const PUT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementPayload {
    youtube_id: String,
    source_url: String,
    title: String,
    duration_sec: i64,
    thumb_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumb_data: Option<String>,
    transcript_srt: String,
    analysis_json: serde_json::Value,
    video_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplacementUploadUrl {
    put_url: String,
    #[serde(default)]
    required_headers: HashMap<String, String>,
    video_key: Option<String>,
    audio_key: Option<String>,
}

#[derive(Clone, Copy)]
enum MediaKind {
    Video,
    Audio,
}

impl MediaKind {
    fn wire_name(self) -> &'static str {
        match self {
            Self::Video => "video",
            Self::Audio => "audio",
        }
    }

    fn content_type(self) -> &'static str {
        match self {
            Self::Video => "video/mp4",
            Self::Audio => "audio/mp4",
        }
    }

    fn object_key(self, response: &ReplacementUploadUrl) -> Result<String, String> {
        match self {
            Self::Video => response.video_key.clone(),
            Self::Audio => response.audio_key.clone(),
        }
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| format!("replacement_{}_key_missing", self.wire_name()))
    }
}

fn strict_youtube_id(id: &str) -> bool {
    id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn parse_strict_youtube_id(source_url: &str) -> Option<String> {
    let parsed = url::Url::parse(source_url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    let candidate = if host == "youtu.be" {
        let path = parsed.path().trim_start_matches('/');
        (!path.contains('/')).then_some(path.to_string())
    } else if host == "youtube.com" || host.ends_with(".youtube.com") {
        if parsed.path() == "/watch" {
            parsed
                .query_pairs()
                .find(|(name, _)| name == "v")
                .map(|(_, value)| value.into_owned())
        } else {
            ["/embed/", "/shorts/"]
                .iter()
                .find_map(|prefix| parsed.path().strip_prefix(prefix))
                .and_then(|rest| rest.split('/').next())
                .map(str::to_string)
        }
    } else {
        None
    }?;
    strict_youtube_id(&candidate).then_some(candidate)
}

fn replacement_upload_headers(
    content_type: &str,
    required: &HashMap<String, String>,
) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(content_type).map_err(|e| format!("upload header: {e}"))?,
    );
    for (name, value) in required {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|e| format!("upload header name: {e}"))?;
        let value =
            HeaderValue::from_str(value).map_err(|e| format!("upload header value: {e}"))?;
        headers.insert(name, value);
    }
    Ok(headers)
}

fn auth_token(app: &AppHandle) -> Result<String, String> {
    let state = auth::get_auth(app).ok_or_else(|| "auth_required".to_string())?;
    if !auth::is_valid(&state) {
        return Err("auth_required".to_string());
    }
    Ok(state.session_token)
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("client build: {e}"))
}

fn network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        format!("timeout: {error}")
    } else if error.is_connect() {
        format!("connect: {error}")
    } else {
        format!("network: {error}")
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect::<String>() + "..."
}

async fn replacement_upload_url(
    token: &str,
    queue_id: &str,
    target_id: &str,
    kind: MediaKind,
    byte_count: usize,
    duration_sec: i64,
) -> Result<ReplacementUploadUrl, String> {
    let response = http_client(HTTP_TIMEOUT)?
        .post(format!("{API_BASE}/upload-url"))
        .bearer_auth(token)
        .header(CONTENT_TYPE, "application/json")
        .body(
            serde_json::json!({
                "id": target_id,
                "queueId": queue_id,
                "kind": kind.wire_name(),
                "contentType": kind.content_type(),
                "contentLength": byte_count as i64,
                "durationSec": duration_sec,
            })
            .to_string(),
        )
        .send()
        .await
        .map_err(|e| network_error(&e))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("body: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "http {}: {}",
            status.as_u16(),
            truncate(&text, 200)
        ));
    }
    serde_json::from_str(&text).map_err(|e| format!("replacement upload parse: {e}"))
}

async fn upload_staged_bytes(
    upload: &ReplacementUploadUrl,
    kind: MediaKind,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let object_key = kind.object_key(upload)?;
    let response = http_client(PUT_TIMEOUT)?
        .put(&upload.put_url)
        .headers(replacement_upload_headers(
            kind.content_type(),
            &upload.required_headers,
        )?)
        .body(bytes)
        .send()
        .await
        .map_err(|e| network_error(&e))?;
    if !response.status().is_success() {
        return Err(format!(
            "replacement_{}_upload_http_{}",
            kind.wire_name(),
            response.status().as_u16()
        ));
    }
    Ok(object_key)
}

async fn stage_audio_best_effort(
    app: &AppHandle,
    token: &str,
    queue_id: &str,
    target_id: &str,
    video_id: &str,
    mobile_path: &Path,
    audio_path: &Path,
    duration_sec: i64,
) -> Option<String> {
    if let Err(error) =
        crate::pipeline::ffmpeg::extract_audio_aac(app, mobile_path, audio_path, video_id).await
    {
        eprintln!("[replacement_upload] audio extraction failed: {error}");
        return None;
    }
    let bytes = match std::fs::read(audio_path) {
        Ok(bytes) if !bytes.is_empty() => bytes,
        Ok(_) => return None,
        Err(error) => {
            eprintln!("[replacement_upload] audio read failed: {error}");
            return None;
        }
    };
    let result = async {
        let upload = replacement_upload_url(
            token,
            queue_id,
            target_id,
            MediaKind::Audio,
            bytes.len(),
            duration_sec,
        )
        .await?;
        upload_staged_bytes(&upload, MediaKind::Audio, bytes).await
    }
    .await;
    match result {
        Ok(key) => Some(key),
        Err(error) => {
            eprintln!("[replacement_upload] optional audio upload failed: {error}");
            None
        }
    }
}

fn temporary_media_paths(video_dir: &str, queue_id: &str) -> (PathBuf, PathBuf) {
    let safe_queue_id: String = queue_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    let suffix = if safe_queue_id.is_empty() {
        "queue"
    } else {
        &safe_queue_id
    };
    let root = Path::new(video_dir);
    (
        root.join(format!("replacement-{suffix}.mp4")),
        root.join(format!("replacement-{suffix}.m4a")),
    )
}

#[tauri::command]
pub async fn library_stage_replacement(
    app: AppHandle,
    queue_id: String,
    target_id: String,
    local_video_id: String,
) -> Result<ReplacementPayload, String> {
    let token = auth_token(&app)?;
    if !strict_youtube_id(&local_video_id) {
        return Err("replacement_youtube_invalid".to_string());
    }

    let library =
        crate::commands::library::read_index().map_err(|e| format!("library read: {e}"))?;
    let entry = library
        .videos
        .iter()
        .find(|entry| entry.id == local_video_id)
        .cloned()
        .ok_or_else(|| "not_found".to_string())?;
    if entry.status != crate::commands::library::LibraryStatus::Ready {
        return Err("entry_not_ready".to_string());
    }
    let source_url = match entry.source {
        crate::commands::library::LibrarySource::Url { url } => url,
        _ => return Err("replacement_source_not_youtube".to_string()),
    };
    if parse_strict_youtube_id(&source_url).as_deref() != Some(local_video_id.as_str()) {
        return Err("replacement_youtube_mismatch".to_string());
    }
    let video_dir = entry
        .video_dir
        .as_deref()
        .ok_or_else(|| "missing video_dir".to_string())?;
    let root = Path::new(video_dir);
    let transcript_srt = std::fs::read_to_string(root.join("transcript.srt"))
        .map_err(|e| format!("transcript read: {e}"))?;
    if transcript_srt.trim().is_empty() {
        return Err("replacement_transcript_empty".to_string());
    }
    let analysis_text = std::fs::read_to_string(root.join("analysis.json"))
        .map_err(|e| format!("analysis read: {e}"))?;
    let analysis_json =
        serde_json::from_str(&analysis_text).map_err(|e| format!("analysis parse: {e}"))?;
    let duration_sec = entry.duration_sec.max(0.0).floor() as i64;
    let source_mp4 = root.join("source.mp4");
    if !source_mp4.exists() {
        return Err("replacement_source_video_missing".to_string());
    }

    let (mobile_path, audio_path) = temporary_media_paths(video_dir, &queue_id);
    let staged = async {
        crate::pipeline::ffmpeg::transcode_720p(
            &app,
            &source_mp4,
            &mobile_path,
            &local_video_id,
            entry.duration_sec,
            None,
        )
        .await
        .map_err(|e| format!("replacement_transcode_failed: {e}"))?;
        let video_bytes =
            std::fs::read(&mobile_path).map_err(|e| format!("replacement video read: {e}"))?;
        if video_bytes.is_empty() {
            return Err("replacement_video_empty".to_string());
        }
        let upload = replacement_upload_url(
            &token,
            &queue_id,
            &target_id,
            MediaKind::Video,
            video_bytes.len(),
            duration_sec,
        )
        .await?;
        let video_key = upload_staged_bytes(&upload, MediaKind::Video, video_bytes).await?;
        let audio_key = stage_audio_best_effort(
            &app,
            &token,
            &queue_id,
            &target_id,
            &local_video_id,
            &mobile_path,
            &audio_path,
            duration_sec,
        )
        .await;
        Ok::<_, String>((video_key, audio_key))
    }
    .await;
    let _ = std::fs::remove_file(&mobile_path);
    let _ = std::fs::remove_file(&audio_path);
    let (video_key, audio_key) = staged?;

    let thumb_data = std::fs::read(root.join("thumb.jpg")).ok().map(|bytes| {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    });
    Ok(ReplacementPayload {
        youtube_id: local_video_id.clone(),
        source_url,
        title: entry.title,
        duration_sec,
        thumb_url: Some(format!(
            "https://i.ytimg.com/vi/{local_video_id}/mqdefault.jpg"
        )),
        thumb_data,
        transcript_srt,
        analysis_json,
        video_key,
        audio_key,
    })
}

#[tauri::command]
pub async fn library_complete_replacement_http(
    app: AppHandle,
    queue_id: String,
    target_id: String,
    payload: ReplacementPayload,
) -> Result<(), String> {
    let token = auth_token(&app)?;
    let mut body = serde_json::to_value(payload).map_err(|e| format!("replacement encode: {e}"))?;
    let object = body
        .as_object_mut()
        .ok_or_else(|| "replacement encode: expected object".to_string())?;
    object.insert(
        "targetLibraryEntryId".to_string(),
        serde_json::Value::String(target_id),
    );
    let response = http_client(HTTP_TIMEOUT)?
        .post(format!(
            "{API_BASE}/import-queue/{queue_id}/complete-replacement"
        ))
        .bearer_auth(token)
        .header(CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| network_error(&e))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let text = response.text().await.unwrap_or_default();
    Err(format!(
        "http {}: {}",
        status.as_u16(),
        truncate(&text, 200)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_identity_requires_exact_youtube_id() {
        assert!(strict_youtube_id("dQw4w9WgXcQ"));
        assert!(!strict_youtube_id("abc123"));
        assert!(!strict_youtube_id("dQw4w9WgXcQ-extra"));
    }

    #[test]
    fn replacement_upload_preserves_backend_required_headers() {
        let required = HashMap::from([("x-oss-forbid-overwrite".to_string(), "true".to_string())]);
        let headers = replacement_upload_headers("video/mp4", &required).unwrap();

        assert_eq!(headers.get("content-type").unwrap(), "video/mp4");
        assert_eq!(headers.get("x-oss-forbid-overwrite").unwrap(), "true");
    }

    #[test]
    fn strict_parser_accepts_supported_youtube_urls_only() {
        assert_eq!(
            parse_strict_youtube_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            parse_strict_youtube_id("https://youtu.be/dQw4w9WgXcQ?t=5"),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(parse_strict_youtube_id("https://youtu.be/abc123"), None);
        assert_eq!(
            parse_strict_youtube_id("https://example.com/watch?v=dQw4w9WgXcQ"),
            None
        );
    }
}
