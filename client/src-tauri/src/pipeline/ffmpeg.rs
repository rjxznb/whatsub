use crate::core::progress::{emit, PipelineEvent};
use crate::error::AppResult;
use crate::pipeline::spawn::run_sidecar;
use std::path::Path;
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

fn make_log_emitter(app: &AppHandle, video_id: &str) -> impl Fn(&str) {
    let app = app.clone();
    let id = video_id.to_string();
    move |chunk: &str| {
        for line in chunk.lines() {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            emit(
                &app,
                PipelineEvent::Log {
                    video_id: id.clone(),
                    source: "ffmpeg".into(),
                    line: t.into(),
                },
            );
        }
    }
}

/// Convert any video to 16kHz mono PCM WAV at `out_path`. Whisper.cpp expects this format.
///
/// Tolerance flags: a single corrupt AAC packet should NOT bring down the
/// whole extraction. ffmpeg's defaults are surprisingly strict — the AAC
/// decoder bails when its rolling error rate crosses 2/3, exiting 69
/// ("Conversion failed!") and turning a recoverable file into a hard
/// import failure. We loosen three knobs at the input side:
///
///   -fflags +discardcorrupt   drop packets the demuxer flags as corrupt
///   -err_detect ignore_err    keep going on minor decode errors instead
///                              of treating them as fatal
///   -max_error_rate 0.95      raise the abort threshold so even a very
///                              broken stream still produces best-effort
///                              WAV instead of nothing
///
/// Best-effort by design: whisper will get whatever audio is decodable.
/// For a slightly-damaged track this is a clean rescue; for a deeply-broken
/// one whisper transcribes garbage, but that's preferable to a hard
/// import failure with no recourse for the user.
pub async fn extract_audio_wav(
    app: &AppHandle,
    video_path: &Path,
    out_path: &Path,
    video_id: &str,
    cancel: Option<&CancellationToken>,
) -> AppResult<()> {
    let video_str = video_path.to_string_lossy().to_string();
    let out_str = out_path.to_string_lossy().to_string();
    let log = make_log_emitter(app, video_id);
    run_sidecar(
        app,
        "ffmpeg",
        &[
            "-y",
            "-fflags", "+discardcorrupt",
            "-err_detect", "ignore_err",
            "-i", &video_str,
            "-vn",
            "-ac", "1",
            "-ar", "16000",
            "-c:a", "pcm_s16le",
            "-max_error_rate", "0.95",
            &out_str,
        ],
        log,
        cancel,
    )
    .await?;
    Ok(())
}

/// Extract first frame as JPEG thumbnail at `out_path`.
pub async fn extract_thumbnail(
    app: &AppHandle,
    video_path: &Path,
    out_path: &Path,
    video_id: &str,
    cancel: Option<&CancellationToken>,
) -> AppResult<()> {
    let video_str = video_path.to_string_lossy().to_string();
    let out_str = out_path.to_string_lossy().to_string();
    let log = make_log_emitter(app, video_id);
    run_sidecar(
        app,
        "ffmpeg",
        &[
            "-y",
            "-ss", "0.5",
            "-i", &video_str,
            "-vframes", "1",
            "-q:v", "2",
            &out_str,
        ],
        log,
        cancel,
    )
    .await?;
    Ok(())
}

/// Downscale an existing image (e.g. thumb.jpg) to `width` px wide (height
/// auto via -2, kept even for the encoder) as JPEG. Used by library cloud-sync
/// to ship a small (~15 KB) cover instead of the full-res frame. Reuses the
/// bundled ffmpeg sidecar — no new deps.
pub async fn downscale_jpeg(
    app: &AppHandle,
    src_path: &Path,
    out_path: &Path,
    width: u32,
    video_id: &str,
    cancel: Option<&CancellationToken>,
) -> AppResult<()> {
    let src = src_path.to_string_lossy().to_string();
    let out = out_path.to_string_lossy().to_string();
    let scale = format!("scale={width}:-2");
    let log = make_log_emitter(app, video_id);
    run_sidecar(
        app,
        "ffmpeg",
        &["-y", "-i", &src, "-vf", &scale, "-q:v", "5", &out],
        log,
        cancel,
    )
    .await?;
    Ok(())
}

/// Probe a media file's duration in seconds via ffprobe. Best-effort: returns
/// 0.0 if it can't be determined (a missing duration just hides the library
/// card's duration line — it must never fail the import). yt-dlp gives URL
/// imports their duration for free; LOCAL-file imports have none, so we probe.
pub async fn probe_duration_secs(app: &AppHandle, path: &Path) -> f64 {
    let p = path.to_string_lossy().to_string();
    let out = run_sidecar(
        app,
        "ffprobe",
        &[
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &p,
        ],
        |_line: &str| {},
        None,
    )
    .await;
    match out {
        Ok(s) => s.trim().parse::<f64>().unwrap_or(0.0).max(0.0),
        Err(_) => 0.0,
    }
}

/// Probe the first video + audio stream's codec names (lowercased; empty when a
/// stream is absent). One ffprobe call, CSV `codec_type,codec_name` per stream.
pub async fn probe_codecs(app: &AppHandle, path: &Path) -> (String, String) {
    let p = path.to_string_lossy().to_string();
    let out = run_sidecar(
        app,
        "ffprobe",
        &[
            "-v", "error",
            "-show_entries", "stream=codec_type,codec_name",
            "-of", "csv=p=0",
            &p,
        ],
        |_l: &str| {},
        None,
    )
    .await;
    let (mut vcodec, mut acodec) = (String::new(), String::new());
    if let Ok(s) = out {
        for line in s.lines() {
            let parts: Vec<&str> = line.trim().split(',').collect();
            if parts.len() < 2 {
                continue;
            }
            // -show_entries stream=codec_type,codec_name → "video,h264" / "audio,ac3"
            match parts[0] {
                "video" if vcodec.is_empty() => vcodec = parts[1].to_ascii_lowercase(),
                "audio" if acodec.is_empty() => acodec = parts[1].to_ascii_lowercase(),
                _ => {}
            }
        }
    }
    (vcodec, acodec)
}

/// Probe the container format name (ffprobe `format=format_name`, lowercased),
/// e.g. "mov,mp4,m4a,3gp,3g2,mj2" or "matroska,webm". Empty string on failure.
pub async fn probe_container(app: &AppHandle, path: &Path) -> String {
    let p = path.to_string_lossy().to_string();
    let out = run_sidecar(
        app,
        "ffprobe",
        &[
            "-v", "error",
            "-show_entries", "format=format_name",
            "-of", "default=nk=1:nw=1",
            &p,
        ],
        |_l: &str| {},
        None,
    )
    .await;
    out.map(|s| s.trim().to_ascii_lowercase()).unwrap_or_default()
}

/// Decide how to make a source web-playable, given its ffprobe `format_name`
/// container and first video/audio codec names. Returns
/// `(byte_copy, video_copy, audio_copy)`:
/// - `byte_copy`: a raw file copy is safe — the source is ALREADY an MP4-family
///   container AND uses web-decodable codecs. This is the fast path for real mp4s.
/// - otherwise the file must go through ffmpeg; `video_copy`/`audio_copy` say
///   whether each stream can be stream-copied (fast) or must be re-encoded.
///
/// The container check is load-bearing: an MKV/WebM whose codecs happen to be
/// web-OK (h264 + aac) must NOT be byte-copied — it stays a Matroska container
/// that WebView2/Chromium plays without sound. With `byte_copy=false` and both
/// streams copyable, ffmpeg does a pure REMUX into MP4 (fast, no re-encode).
pub fn web_playable_plan(container: &str, vcodec: &str, acodec: &str) -> (bool, bool, bool) {
    let is_mp4 = container
        .split(',')
        .any(|c| matches!(c.trim(), "mp4" | "mov" | "m4a"));
    let video_copy = vcodec == "h264";
    let audio_copy = acodec.is_empty() || matches!(acodec, "aac" | "mp3");
    let byte_copy = is_mp4 && video_copy && audio_copy;
    (byte_copy, video_copy, audio_copy)
}

/// Make a local import playable in the WebView `<video>` element, writing the
/// result to `dest` (source.mp4). WebView2/Chromium can't decode AC-3 / DTS /
/// E-AC-3 audio (common in MKV) → the picture plays but there's NO SOUND; and
/// HEVC / VP9 / AV1 video may not play at all. So: if the source is already
/// H.264 + (AAC|MP3) we just byte-copy (fast — most mp4s). Otherwise we
/// transcode, copying the video stream when it's already H.264 (only re-encoding
/// the offending audio — fast) and re-encoding video only when it isn't. Audio
/// re-encode forces stereo (`-ac 2`) to dodge the multichannel-AAC corruption
/// noted in CLAUDE-PITFALLS.
pub async fn ensure_web_playable_mp4(
    app: &AppHandle,
    src_path: &Path,
    dest_path: &Path,
    video_id: &str,
    cancel: Option<&CancellationToken>,
) -> AppResult<()> {
    let (vcodec, acodec) = probe_codecs(app, src_path).await;
    let container = probe_container(app, src_path).await;
    let (byte_copy, video_ok, audio_ok) = web_playable_plan(&container, &vcodec, &acodec);

    if byte_copy {
        std::fs::copy(src_path, dest_path)?;
        return Ok(());
    }

    let app_for_log = app.clone();
    let vid = video_id.to_string();
    let log = move |line: &str| {
        emit(
            &app_for_log,
            PipelineEvent::Log {
                video_id: vid.clone(),
                source: "ffmpeg".into(),
                line: line.into(),
            },
        );
    };
    let msg = if video_ok && audio_ok {
        // Codecs are fine; only the container is wrong (e.g. MKV/WebM) → pure remux.
        format!("检测到非 MP4 封装（{}），正在转封装为 MP4 以便播放…", container)
    } else {
        format!(
            "检测到内置播放器不兼容的编码（视频 {} / 音频 {}），正在转码以便播放…",
            if vcodec.is_empty() { "?" } else { &vcodec },
            if acodec.is_empty() { "无" } else { &acodec },
        )
    };
    emit(
        app,
        PipelineEvent::Log {
            video_id: video_id.to_string(),
            source: "whatsub".into(),
            line: msg,
        },
    );

    let src = src_path.to_string_lossy().to_string();
    let out = dest_path.to_string_lossy().to_string();
    let mut args: Vec<&str> = vec!["-y", "-i", &src];
    if video_ok {
        args.extend(["-c:v", "copy"]);
    } else {
        args.extend(["-c:v", "libx264", "-crf", "20", "-preset", "veryfast"]);
    }
    if audio_ok {
        args.extend(["-c:a", "copy"]);
    } else {
        args.extend(["-c:a", "aac", "-b:a", "192k", "-ac", "2"]);
    }
    args.extend(["-movflags", "+faststart", &out]);

    run_sidecar(app, "ffmpeg", &args, log, cancel).await?;
    Ok(())
}

/// Transcode a video to a mobile-friendly 720p H.264 MP4 (never upscales) with
/// faststart (moov atom up front for progressive streaming). Used by library
/// cloud-sync before uploading to OSS.
pub async fn transcode_720p(
    app: &AppHandle,
    src_path: &Path,
    out_path: &Path,
    video_id: &str,
    duration_sec: f64,
    cancel: Option<&CancellationToken>,
) -> AppResult<()> {
    use crate::commands::analysis::extract_time_field;

    let src = src_path.to_string_lossy().to_string();
    let out = out_path.to_string_lossy().to_string();

    // Progress-aware stderr sink: surface raw ffmpeg lines as Log events (same
    // as make_log_emitter) AND parse `time=` → emit Uploading{percent} (0–99),
    // mirroring the burn-in export progress in commands/analysis.rs.
    let app_for_log = app.clone();
    let vid = video_id.to_string();
    let mut last_percent: u8 = 0;
    let log = move |line: &str| {
        emit(
            &app_for_log,
            PipelineEvent::Log {
                video_id: vid.clone(),
                source: "ffmpeg".into(),
                line: line.into(),
            },
        );
        if let Some(secs) = extract_time_field(line) {
            if duration_sec > 0.0 {
                let pct = ((secs / duration_sec) * 100.0).clamp(0.0, 99.0) as u8;
                if pct > last_percent {
                    last_percent = pct;
                    emit(
                        &app_for_log,
                        PipelineEvent::Uploading {
                            video_id: vid.clone(),
                            percent: pct,
                            note: None,
                        },
                    );
                }
            }
        }
    };

    run_sidecar(
        app,
        "ffmpeg",
        &[
            "-y", "-i", &src,
            "-vf", "scale=-2:'min(720,ih)'",
            "-c:v", "libx264", "-crf", "23", "-preset", "veryfast",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            &out,
        ],
        log,
        cancel,
    )
    .await?;
    Ok(())
}

/// Extract a small mono AAC sidecar (.m4a) from the already-transcoded mp4.
/// Used by `library_sync_to_cloud` (2026-05-29 audio sidecar feature) so iOS
/// practice modes can fetch ~3-5% of the bytes (audio only) instead of pulling
/// MP4 byte ranges that mostly contain video frames they don't display.
///
/// Cheap relative to the main transcode — re-encodes audio only (mobile.mp4
/// is already h264+AAC, so video is skipped entirely with -vn). Typical 30-min
/// video: ~5-10 seconds on a laptop CPU. +faststart so the moov atom is at
/// the front for instant byte-range startup over CDN.
///
/// No cancellation token: the caller (upload_video) runs this best-effort
/// after the video PUT succeeds; a hard cancellation isn't needed at this
/// stage of the pipeline. No progress emission for the same reason — UI is
/// already at "uploading 100%" by the time this runs.
pub async fn extract_audio_aac(
    app: &AppHandle,
    src_mp4: &Path,
    dst_m4a: &Path,
    video_id: &str,
) -> AppResult<()> {
    let src = src_mp4.to_string_lossy().to_string();
    let out = dst_m4a.to_string_lossy().to_string();
    let app_for_log = app.clone();
    let vid = video_id.to_string();
    let log = move |line: &str| {
        emit(
            &app_for_log,
            PipelineEvent::Log {
                video_id: vid.clone(),
                source: "ffmpeg-audio".into(),
                line: line.into(),
            },
        );
    };
    run_sidecar(
        app,
        "ffmpeg",
        &[
            "-y", "-i", &src,
            "-vn",                       // no video
            "-c:a", "aac", "-b:a", "64k", // 64 kbps AAC
            "-ac", "1",                  // mono
            "-movflags", "+faststart",   // moov atom at the front for fast byte-range startup
            &out,
        ],
        log,
        None, // no cancellation — fast + best-effort
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::web_playable_plan;

    #[test]
    fn plan_byte_copies_only_mp4_family_with_web_codecs() {
        // Already a real MP4 (h264 + aac): raw byte-copy is safe.
        assert_eq!(web_playable_plan("mov,mp4,m4a,3gp,3g2,mj2", "h264", "aac"), (true, true, true));
        // MP4 with no audio stream: still byte-copy.
        assert_eq!(web_playable_plan("mov,mp4,m4a,3gp,3g2,mj2", "h264", ""), (true, true, true));
    }

    #[test]
    fn plan_remuxes_mkv_even_with_web_codecs() {
        // The bug: h264 + AAC inside MKV was byte-copied → stayed matroska → no sound.
        // Now: NOT byte-copy (container), pure remux (both streams copied) into MP4.
        assert_eq!(web_playable_plan("matroska,webm", "h264", "aac"), (false, true, true));
        // MKV with no audio: still remux (container must change).
        assert_eq!(web_playable_plan("matroska,webm", "h264", ""), (false, true, true));
    }

    #[test]
    fn plan_transcodes_incompatible_codecs() {
        // MKV h264 + ac3: copy video, re-encode audio (the common MKV case).
        assert_eq!(web_playable_plan("matroska,webm", "h264", "ac3"), (false, true, false));
        // MKV hevc + ac3: re-encode both.
        assert_eq!(web_playable_plan("matroska,webm", "hevc", "ac3"), (false, false, false));
        // MP4 container but HEVC video + aac: container ok, but re-encode video.
        assert_eq!(web_playable_plan("mov,mp4,m4a,3gp,3g2,mj2", "hevc", "aac"), (false, false, true));
    }
}
