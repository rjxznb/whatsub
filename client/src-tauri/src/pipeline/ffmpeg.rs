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
