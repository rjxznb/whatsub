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
    /// Whether the OSS video upload succeeded. false → entry synced
    /// captions-only (iOS needs VPN); UI shows 上传失败 · 重试上传.
    #[serde(rename = "videoUploaded")]
    pub video_uploaded: bool,
}

/// GET /api/library/quota response. `limits` was added 2026-05-26 (per-video
/// size + duration tier). `serde(default)` keeps deserialization backward-
/// compat with older backends that only returned {used, limit}.
#[derive(serde::Deserialize)]
struct QuotaResp {
    used: i64,
    limit: i64,
    #[serde(default)]
    limits: Option<LibraryLimitsResp>,
}

#[derive(serde::Deserialize, Clone)]
struct LibraryLimitsResp {
    #[serde(rename = "maxVideos")]
    #[allow(dead_code)]
    max_videos: i64,
    #[serde(rename = "maxVideoBytes")]
    max_video_bytes: i64,
    #[serde(rename = "maxVideoSeconds")]
    max_video_seconds: i64,
}

/// Return value of `upload_video` (since 2026-05-29 audio sidecar feature).
/// `audio_key` is None when the best-effort audio extract/upload failed; iOS
/// gracefully falls back to fetching from the video URL in that case. The
/// video_key is non-optional because video upload failure short-circuits to
/// `Ok(None)` before constructing this struct.
struct UploadedKeys {
    video_key: String,
    audio_key: Option<String>,
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

    // Pre-checks: always fetch /quota (cheap), use it for:
    //   (a) count enforcement on NEW uploads (`used >= limit` → 403-equivalent)
    //   (b) per-video DURATION cap pre-transcode (save ~30s-2min of CPU on
    //       over-limit videos — the cheapest fence)
    //   (c) Carry `limits` forward to upload_video for the post-transcode SIZE
    //       check (matches the backend's HEAD backstop)
    // Existing data policy: count + duration only enforce on NEW uploads —
    // re-syncs of already-uploaded entries keep working. Size still enforces
    // since a re-sync that re-uploads is effectively a new OSS object.
    let mut limits_for_upload: Option<LibraryLimitsResp> = None;
    {
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
                        if entry.synced_at.is_none() && q.used >= q.limit {
                            return Err(format!(
                                "quota_exceeded {{\"used\":{}, \"limit\":{}}}",
                                q.used, q.limit
                            ));
                        }
                        if entry.synced_at.is_none() {
                            if let Some(ref lim) = q.limits {
                                if entry.duration_sec > lim.max_video_seconds as f64 {
                                    return Err(format!(
                                        "video_too_long {{\"duration\":{}, \"limit\":{}}}",
                                        entry.duration_sec as i64, lim.max_video_seconds
                                    ));
                                }
                            }
                        }
                        limits_for_upload = q.limits;
                    }
                }
            }
        }
    }

    // Transcode source.mp4 → 720p mobile.mp4, size-check the result, request a
    // presigned PUT, upload to OSS. Ok(Some(key)) on success, Ok(None) on
    // best-effort failure (caller syncs captions-only → iOS falls back to
    // YouTube embed), Err(msg) on user-facing hard errors (video_too_large).
    let uploaded: Option<UploadedKeys> = upload_video(
        &app,
        video_dir,
        &id,
        &auth_state.session_token,
        entry.duration_sec,
        limits_for_upload,
    )
    .await?;
    let video_key: Option<String> = uploaded.as_ref().map(|u| u.video_key.clone());
    let audio_key: Option<String> = uploaded.as_ref().and_then(|u| u.audio_key.clone());

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
        "audioKey": audio_key,
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

    // 5. Persist syncedAt. On OSS-upload failure keep the entry (captions
    // synced) but record sync_error so the card + queue show 上传失败 · 重试.
    let sync_error = if video_key.is_none() {
        Some("video_upload_failed".to_string())
    } else {
        None
    };
    crate::commands::library::set_synced_at(&id, Some(now), sync_error)
        .map_err(|e| format!("library write: {e}"))?;

    Ok(SyncOk {
        ok: true,
        synced_at: now,
        video_uploaded: video_key.is_some(),
    })
}

/// Map the "clear local synced flag" bookkeeping result for unsync. A
/// cloud-only entry (synced from another device / local copy deleted) has no
/// local library.json record — `set_synced_at` returns `not_found`, but there
/// was simply nothing to clear: the unsync itself succeeded, so that's Ok.
/// Any other error is a real local-write failure and surfaces to the UI.
fn clear_synced_flag_best_effort(r: crate::error::AppResult<()>) -> Result<(), String> {
    match r {
        Ok(()) => Ok(()),
        Err(e) if e.to_string() == "not_found" => Ok(()),
        Err(e) => Err(format!("library write: {e}")),
    }
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
    clear_synced_flag_best_effort(crate::commands::library::set_synced_at(&id, None, None))?;
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

/// Transcode source.mp4 → 720p mobile.mp4, size-check the result, obtain a
/// presigned PUT URL, upload straight to OSS. After the video PUT succeeds,
/// extract a small mono AAC sidecar (.m4a) and upload it via a second
/// presigned PUT (kind=audio) so iOS practice modes can fetch ~3-5% of the
/// bytes per cue (2026-05-29 audio sidecar feature).
///
/// Returns:
/// - `Ok(Some(UploadedKeys { video_key, audio_key }))` — video uploaded
///   (audio_key may be None if its best-effort upload failed; iOS falls
///   back to videoKey in that case).
/// - `Ok(None)` — best-effort failure on video (no source / transcode failed
///   / network hiccup on /upload-url or OSS PUT). Caller syncs captions-only
///   → iOS falls back to the YouTube embed.
/// - `Err(msg)` — user-facing hard error to display: `video_too_large
///   {bytes, limit}` or `http 413: ...`. Bubbles out of library_sync_to_cloud
///   via `?` so the TS friendlySyncError can show the upsell dialog.
async fn upload_video(
    app: &AppHandle,
    video_dir: &str,
    id: &str,
    token: &str,
    duration_sec: f64,
    limits: Option<LibraryLimitsResp>,
) -> Result<Option<UploadedKeys>, String> {
    let src = std::path::Path::new(video_dir).join("source.mp4");
    if !src.exists() {
        return Ok(None);
    }
    let mobile = std::path::Path::new(video_dir).join("mobile.mp4");

    // Step 1: transcode to 720p H.264 (never upscales). Best-effort.
    if let Err(e) = crate::pipeline::ffmpeg::transcode_720p(app, &src, &mobile, id, duration_sec, None).await {
        eprintln!("[upload_video] {id}: transcode failed: {e}");
        return Ok(None);
    }

    // Step 2: read transcoded bytes + client-side size pre-check. Doing it
    // BEFORE /upload-url means a violator never even gets a presigned URL —
    // matches the backend's claimed-contentLength check. Backend /sync HEAD
    // re-verifies as backstop against a malicious client that forges this.
    let bytes = match std::fs::read(&mobile) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[upload_video] {id}: mobile.mp4 read failed: {e}");
            return Ok(None);
        }
    };
    let size_mb = bytes.len() / 1_000_000;

    if let Some(ref lim) = limits {
        if (bytes.len() as i64) > lim.max_video_bytes {
            let _ = std::fs::remove_file(&mobile);
            return Err(format!(
                "video_too_large {{\"bytes\":{}, \"limit\":{}}}",
                bytes.len(),
                lim.max_video_bytes
            ));
        }
    }

    // Transcode + size-check done — signal the PUT phase (frontend shows an
    // indeterminate "正在上传…" spinner; we don't track byte-level PUT progress).
    // Stage note added 2026-05-29 so users see what's happening during the
    // (now longer) silent post-transcode phase that includes audio extract.
    crate::core::progress::emit(
        app,
        crate::core::progress::PipelineEvent::Uploading {
            video_id: id.to_string(),
            percent: 100,
            note: Some(format!("正在上传视频 · {size_mb} MB")),
        },
    );

    // Step 3: request a presigned PUT URL. Send contentLength + durationSec so
    // the server can early-fail with 413 even if our client-side check missed
    // (e.g. older client + new limits, or limits not fetched).
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(NET_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("client build: {e}"))?;

    #[derive(serde::Deserialize)]
    struct UploadUrl {
        #[serde(rename = "putUrl")]
        put_url: String,
        #[serde(rename = "videoKey")]
        video_key: String,
    }

    let uu_resp = match client
        .post(format!("{API_BASE}/upload-url"))
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .body(
            serde_json::json!({
                "id": id,
                "contentType": "video/mp4",
                "contentLength": bytes.len() as i64,
                "durationSec": duration_sec as i64,
            })
            .to_string(),
        )
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[upload_video] {id}: /upload-url request failed: {e}");
            let _ = std::fs::remove_file(&mobile);
            return Ok(None);
        }
    };

    // 413 is a USER-FACING error (over limit) — propagate, don't degrade to
    // captions-only. Other HTTP errors are best-effort (network / 5xx).
    if uu_resp.status() == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
        let body = uu_resp.text().await.unwrap_or_default();
        let _ = std::fs::remove_file(&mobile);
        return Err(format!("http 413: {}", truncate(&body, 200)));
    }
    let uu_resp = match uu_resp.error_for_status() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[upload_video] {id}: /upload-url HTTP error: {e}");
            let _ = std::fs::remove_file(&mobile);
            return Ok(None);
        }
    };
    let uu_text = match uu_resp.text().await {
        Ok(t) => t,
        Err(_) => {
            let _ = std::fs::remove_file(&mobile);
            return Ok(None);
        }
    };
    let uu: UploadUrl = match serde_json::from_str(&uu_text) {
        Ok(v) => v,
        Err(_) => {
            let _ = std::fs::remove_file(&mobile);
            return Ok(None);
        }
    };

    // Step 4: PUT the file straight to OSS.
    // Content-Type MUST exactly match the presigned signature ("video/mp4").
    eprintln!("[upload_video] {id}: uploading {size_mb} MB to OSS…");
    // Generous timeout — a multi-hundred-MB 720p file over a home upstream can
    // take many minutes; the old 120s timed out on long videos (e.g. full games).
    let put_client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30 * 60))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    let put_resp = match put_client
        .put(&uu.put_url)
        .header("content-type", "video/mp4")
        .body(bytes)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[upload_video] {id}: OSS PUT failed ({size_mb} MB, timeout/network): {e}");
            return Ok(None);
        }
    };

    if !put_resp.status().is_success() {
        eprintln!("[upload_video] {id}: OSS PUT rejected: HTTP {}", put_resp.status());
        let _ = std::fs::remove_file(&mobile);
        return Ok(None);
    }
    eprintln!("[upload_video] {id}: OSS upload OK ({size_mb} MB), key={}", uu.video_key);

    // Step 5 (audio sidecar, 2026-05-29): extract a small .m4a from mobile.mp4
    // and PUT it to OSS via a separate /upload-url?kind=audio call. Strictly
    // best-effort — any failure leaves audio_key=None and iOS falls back to
    // the video URL. We do NOT remove mobile.mp4 before this because audio
    // extraction reads from it.
    //
    // Both phases emit Uploading{percent:100, note:...} so the otherwise-silent
    // post-transcode phase shows a clear text breakdown for the user.
    crate::core::progress::emit(
        app,
        crate::core::progress::PipelineEvent::Uploading {
            video_id: id.to_string(),
            percent: 100,
            note: Some("正在提取音频".to_string()),
        },
    );
    let audio_m4a = std::path::Path::new(video_dir).join("audio.m4a");
    let audio_key = upload_audio_sidecar(app, &mobile, &audio_m4a, id, token).await;
    let _ = std::fs::remove_file(&mobile);
    let _ = std::fs::remove_file(&audio_m4a);

    Ok(Some(UploadedKeys {
        video_key: uu.video_key,
        audio_key,
    }))
}

/// Best-effort: extract audio from the transcoded mobile.mp4, request a
/// presigned PUT for the audio key (kind=audio so the backend routes to
/// audioKeyFor + the library-audio/ prefix + skips the per-video size cap),
/// PUT the audio bytes, return the key on success.
///
/// Returns None on any failure — caller's iOS clients gracefully fall back
/// to the video URL. Logs every failure path so we can diagnose without
/// nagging the user (the video sync already succeeded).
async fn upload_audio_sidecar(
    app: &AppHandle,
    mobile_mp4: &std::path::Path,
    audio_m4a: &std::path::Path,
    id: &str,
    token: &str,
) -> Option<String> {
    // Extract audio. ffmpeg is fast here (audio-only re-encode) — typical
    // 30-min video ≈ 5-10s.
    if let Err(e) = crate::pipeline::ffmpeg::extract_audio_aac(app, mobile_mp4, audio_m4a, id).await {
        eprintln!("[upload_audio] {id}: extract_audio_aac failed: {e}");
        return None;
    }
    let audio_bytes = match std::fs::read(audio_m4a) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[upload_audio] {id}: audio.m4a read failed: {e}");
            return None;
        }
    };

    #[derive(serde::Deserialize)]
    struct AudioUploadUrl {
        #[serde(rename = "putUrl")]
        put_url: String,
        #[serde(rename = "audioKey")]
        audio_key: String,
    }

    let url_client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(NET_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(_) => return None,
    };
    let url_resp = match url_client
        .post(format!("{API_BASE}/upload-url"))
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .body(
            serde_json::json!({
                "id": id,
                "kind": "audio",
                "contentType": "audio/mp4",
                "contentLength": audio_bytes.len() as i64,
            })
            .to_string(),
        )
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[upload_audio] {id}: /upload-url failed: {e}");
            return None;
        }
    };
    let url_resp = match url_resp.error_for_status() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[upload_audio] {id}: /upload-url HTTP error: {e}");
            return None;
        }
    };
    let auu: AudioUploadUrl = match url_resp.text().await.ok().and_then(|t| serde_json::from_str(&t).ok()) {
        Some(v) => v,
        None => {
            eprintln!("[upload_audio] {id}: /upload-url parse failed");
            return None;
        }
    };

    // Phase note for the user — the audio extract was already announced; this
    // marks the start of the actual upload PUT.
    let audio_mb = (audio_bytes.len() as f64 / 1_000_000.0 * 10.0).round() / 10.0;
    crate::core::progress::emit(
        app,
        crate::core::progress::PipelineEvent::Uploading {
            video_id: id.to_string(),
            percent: 100,
            note: Some(format!("正在上传音频 · {audio_mb} MB")),
        },
    );

    // Audio is small (~3-5% of the video); 60s is plenty even on a slow
    // upstream. Avoids the 30-min video-PUT timeout being overkill here.
    let put_client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
    {
        Ok(c) => c,
        Err(_) => return None,
    };
    let put_resp = match put_client
        .put(&auu.put_url)
        .header("content-type", "audio/mp4")
        .body(audio_bytes)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[upload_audio] {id}: OSS PUT failed: {e}");
            return None;
        }
    };
    if !put_resp.status().is_success() {
        eprintln!("[upload_audio] {id}: OSS PUT rejected: HTTP {}", put_resp.status());
        return None;
    }
    eprintln!("[upload_audio] {id}: OSS audio upload OK, key={}", auu.audio_key);
    Some(auu.audio_key)
}

/// Stream an HTTP URL straight to a file. Used to pull the OSS-hosted mp4 +
/// cover for a cloud video down to local during materialize, instead of
/// re-downloading the original source via yt-dlp. Streams (doesn't buffer the
/// whole video in memory); generous overall timeout for a 720p mp4 (the cover
/// is tiny so the cap never bites it).
async fn download_url_to_file(url: &str, dest: &std::path::Path) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(NET_TIMEOUT_SECS))
        .timeout(std::time::Duration::from_secs(20 * 60))
        .build()
        .map_err(|e| format!("client build: {e}"))?;
    let resp = client.get(url).send().await.map_err(|e| categorise(&e))?;
    if !resp.status().is_success() {
        return Err(format!("http {}", resp.status().as_u16()));
    }
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("stream: {e}"))?;
        file.write_all(&bytes).await.map_err(|e| format!("write: {e}"))?;
    }
    file.flush().await.map_err(|e| format!("flush: {e}"))?;
    Ok(())
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
    // Signed Aliyun CDN URL for the 720p mp4 we uploaded at sync time (2h TTL)
    // + the synced cover. Both null when the original sync was captions-only or
    // the video upload failed — in that case we fall back to a yt-dlp download.
    let video_url = entry_json["videoUrl"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let thumb_url = entry_json["thumbUrl"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if source_url.is_empty() && video_url.is_none() {
        return Err("missing sourceUrl".into());
    }

    let out_dir = crate::core::paths::video_dir(&id).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let thumb_path = out_dir.join("thumb.jpg");

    // 2. Get the video locally. PREFER our own OSS copy (fast, no VPN/cookies,
    //    can't 404 on a taken-down source); only re-download from the original
    //    source via yt-dlp when there's no OSS video or the OSS fetch fails.
    let mut used_oss = false;
    let mut resolved_title = title.clone();
    let mut resolved_duration = duration_sec_cloud;
    let mut resolved_thumb = String::new();

    if let Some(ref vurl) = video_url {
        let mp4 = out_dir.join("source.mp4");
        match download_url_to_file(vurl, &mp4).await {
            Ok(_) => {
                used_oss = true;
                // Cover: prefer the synced thumbUrl (China-reachable
                // /api/library/thumb/:id); else extract a frame from the mp4 so
                // the library card always has a cover.
                let mut got_thumb = false;
                if let Some(ref turl) = thumb_url {
                    if download_url_to_file(turl, &thumb_path).await.is_ok() {
                        got_thumb = true;
                    }
                }
                if !got_thumb {
                    let _ = crate::pipeline::ffmpeg::extract_thumbnail(
                        &app, &mp4, &thumb_path, &id, None,
                    )
                    .await;
                }
                if thumb_path.exists() {
                    resolved_thumb = thumb_path.to_string_lossy().to_string();
                }
            }
            Err(e) => {
                // Partial/failed OSS download — clean up and fall through to yt-dlp.
                let _ = std::fs::remove_file(&mp4);
                eprintln!("[materialize] OSS download failed ({e}); falling back to yt-dlp");
            }
        }
    }

    if !used_oss {
        if source_url.is_empty() {
            return Err("missing sourceUrl".into());
        }
        let dl = crate::pipeline::ytdlp::download(
            &app, &source_url, &out_dir, &id, "standard", true, None,
        )
        .await
        .map_err(|e| e.to_string())?;
        if !dl.title.is_empty() {
            resolved_title = dl.title;
        }
        if dl.duration_sec > 0.0 {
            resolved_duration = dl.duration_sec;
        }
        resolved_thumb = dl.thumb_path;
    }

    // 3. Cloud materialization is an explicit destructive replacement. Revoke
    // any producer lease, then atomically install the downloaded snapshot.
    crate::commands::analysis_store::replace_analysis_snapshot(&id, analysis)
        .map_err(|e| e.to_string())?;
    std::fs::write(out_dir.join("transcript.srt"), &transcript).map_err(|e| e.to_string())?;

    // 4. Build a full local library entry (status Ready, synced since it came from cloud).
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let entry = crate::commands::library::LibraryEntry {
        id: id.clone(),
        title: if resolved_title.is_empty() { "Untitled".into() } else { resolved_title },
        source: crate::commands::library::LibrarySource::Url { url: source_url },
        duration_sec: resolved_duration,
        thumbnail_path: resolved_thumb,
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
    fn unsync_tolerates_missing_local_entry() {
        // Cloud-only entry (never downloaded to this desktop): clearing the
        // local synced flag finds no entry — that's success, not failure.
        assert_eq!(
            clear_synced_flag_best_effort(Err("not_found".to_string().into())),
            Ok(())
        );
        // Real write failures still surface, prefixed for the UI.
        assert_eq!(
            clear_synced_flag_best_effort(Err("disk full".to_string().into())),
            Err("library write: disk full".to_string())
        );
        assert_eq!(clear_synced_flag_best_effort(Ok(())), Ok(()));
    }

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
