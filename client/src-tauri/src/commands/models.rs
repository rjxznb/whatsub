use crate::error::AppResult;
use crate::pipeline::whisper;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, State};

/// Single-active-download cancel flag, Tauri-managed. UI invokes
/// `whisper_model_download_cancel` to set it; the in-flight download
/// loop checks it once per chunk and returns `AppError::Other("cancelled")`,
/// which the frontend treats as "paused" rather than a hard error.
#[derive(Default)]
pub struct ModelDownloadState {
    cancel: AtomicBool,
}

#[tauri::command]
pub fn whisper_model_status(size: String) -> AppResult<bool> {
    whisper::model_exists(&size)
}

/// Bytes already on disk for an in-progress (partial) download. 0 if no
/// partial file exists. Lets the UI render "继续 (45%)" when reopened
/// after the user paused mid-download in a previous session.
#[tauri::command]
pub fn whisper_model_partial_size(size: String) -> AppResult<u64> {
    whisper::partial_size(&size)
}

#[tauri::command]
pub async fn whisper_model_download(
    app: AppHandle,
    state: State<'_, ModelDownloadState>,
    size: String,
) -> AppResult<()> {
    state.cancel.store(false, Ordering::Relaxed);
    whisper::download_model(&app, &size, &state.cancel).await
}

#[tauri::command]
pub fn whisper_model_download_cancel(state: State<'_, ModelDownloadState>) -> AppResult<()> {
    state.cancel.store(true, Ordering::Relaxed);
    Ok(())
}
