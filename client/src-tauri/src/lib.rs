mod core;
mod error;
mod commands;
mod pipeline;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::settings_path_string,
            commands::library::library_list,
            commands::library::library_get,
            commands::library::library_upsert,
            commands::library::library_delete,
            commands::library::library_set_status,
            commands::analysis::save_analysis,
            commands::analysis::load_analysis,
            commands::analysis::load_transcript,
            commands::analysis::video_source_path,
            commands::models::whisper_model_status,
            commands::models::whisper_model_download,
            commands::import::import_video,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
