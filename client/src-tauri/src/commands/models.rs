use crate::error::AppResult;
use crate::pipeline::whisper;
use tauri::AppHandle;

#[tauri::command]
pub fn whisper_model_status(size: String) -> AppResult<bool> {
    whisper::model_exists(&size)
}

#[tauri::command]
pub async fn whisper_model_download(app: AppHandle, size: String) -> AppResult<()> {
    whisper::download_model(&app, &size).await
}
