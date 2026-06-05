use crate::error::{AppError, AppResult};
use crate::pipeline::{spawn::run_sidecar, whisper};
use tauri::AppHandle;

/// Transcribe a spoken utterance from a base64-encoded 16-bit PCM WAV.
///
/// Called by the TS voice layer after mic capture + VAD detect a complete
/// utterance. Writes the WAV to a temp file, runs whisper-cli with `-otxt`
/// to produce a plain-text transcript (no SRT timestamps), reads the result,
/// cleans up both temp files, and returns the trimmed text.
///
/// `model`  — whisper model size ("tiny" | "base" | "small" | "medium" | "large-v3").
///            Must already be downloaded; returns AppError::NotFound otherwise.
/// `lang`   — BCP-47 language code for whisper's `-l` flag. Defaults to "en".
#[tauri::command]
pub async fn voice_transcribe(
    app: AppHandle,
    wav_base64: String,
    model: String,
    lang: Option<String>,
) -> AppResult<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let bytes = STANDARD
        .decode(wav_base64.as_bytes())
        .map_err(|e| AppError::InvalidInput(format!("voice: bad base64: {e}")))?;

    // Unique temp basenames (nanoseconds) under the OS temp dir so concurrent
    // calls don't clobber each other.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir();
    let wav_path = dir.join(format!("whatsub_voice_{stamp}.wav"));
    let out_base = dir.join(format!("whatsub_voice_{stamp}_out"));

    std::fs::write(&wav_path, &bytes)?;

    let model_file = match whisper::resolve_model_path(&app, &model) {
        Some(p) => p,
        None => {
            let _ = std::fs::remove_file(&wav_path);
            return Err(AppError::NotFound(format!("model not downloaded: {model}")));
        }
    };

    let model_str = model_file.to_string_lossy().to_string();
    let wav_str = wav_path.to_string_lossy().to_string();
    let out_str = out_base.to_string_lossy().to_string();
    let lang = lang.unwrap_or_else(|| "en".to_string());

    let run = run_sidecar(
        &app,
        "whisper-cli",
        &[
            "-m", &model_str,
            "-f", &wav_str,
            "-l", &lang,
            "-mc", "0",  // no context carryover (matches pipeline::whisper)
            "-nt",       // no timestamps — plain text output
            "-otxt",
            "-of", &out_str,
        ],
        |_chunk| {}, // no pipeline events for voice STT
        None,
    )
    .await;

    // whisper-cli with -otxt writes <out_str>.txt
    let txt_path = out_base.with_extension("txt");
    let text = std::fs::read_to_string(&txt_path)
        .unwrap_or_default()
        .trim()
        .to_string();

    // Clean up temp files before propagating any error.
    let _ = std::fs::remove_file(&wav_path);
    let _ = std::fs::remove_file(&txt_path);

    run?; // propagate sidecar error after cleanup
    Ok(text)
}
