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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(commands::analysis::ExportState::default())
        .manage(commands::models::ModelDownloadState::default())
        .manage(commands::youtube_auth::LoginState::default())
        .manage(commands::import::ImportState::default())
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::settings_path_string,
            commands::library::library_list,
            commands::library::library_get,
            commands::library::library_upsert,
            commands::library::library_delete,
            commands::library::library_set_status,
            commands::library::library_rename,
            commands::library::library_reorder,
            commands::library::library_freeze_paths,
            commands::library::reveal_in_explorer,
            commands::analysis::save_analysis,
            commands::analysis::load_analysis,
            commands::analysis::load_transcript,
            commands::analysis::video_source_path,
            commands::analysis::write_text_file,
            commands::analysis::export_burned_video,
            commands::analysis::cancel_export,
            commands::models::whisper_model_status,
            commands::models::whisper_model_partial_size,
            commands::models::whisper_model_download,
            commands::models::whisper_model_download_cancel,
            commands::import::import_video,
            commands::import::cancel_import,
            commands::import::retranscribe_video,
            commands::vocabulary::vocab_list,
            commands::vocabulary::vocab_add,
            commands::vocabulary::vocab_remove,
            commands::vocabulary::vocab_update_note,
            commands::license::license_get_device_info,
            commands::license::license_read_state,
            commands::license::license_save_state,
            commands::youtube_auth::site_presets,
            commands::youtube_auth::site_logins_list,
            commands::youtube_auth::site_login_pending,
            commands::youtube_auth::site_login_start,
            commands::youtube_auth::site_login_finish,
            commands::youtube_auth::site_login_cancel,
            commands::youtube_auth::site_login_remove,
            commands::youtube_auth::site_logins_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
