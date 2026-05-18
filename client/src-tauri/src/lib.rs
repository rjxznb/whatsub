mod core;
mod error;
mod commands;
mod pipeline;
mod bridge;

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
        .setup(|app| {
            // Bridge: gated by settings.bridgeEnabled (default true).
            // Users without the browser plugin can flip it off in
            // Settings so we don't bind a port + spawn a thread for
            // nothing. Takes effect on next launch — actix System
            // runs forever once spawned. Default to true if settings
            // unavailable to preserve existing plugin users' flow.
            if bridge_enabled_from_settings() {
                bridge::start_bridge(app.handle().clone());
            }
            Ok(())
        })
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
            commands::license::trial_read_state,
            commands::license::trial_save_state,
            commands::license::license_activate_http,
            commands::license::license_trial_start_http,
            commands::yt_dlp::yt_dlp_get_status,
            commands::yt_dlp::yt_dlp_update,
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

/// Read `bridgeEnabled` from settings.json synchronously at startup.
/// Returns true (= start bridge) if the field is true / missing /
/// settings.json doesn't exist (first-launch preserve-existing-behavior).
/// Returns false ONLY when the user has explicitly set it to false in
/// the Settings UI.
fn bridge_enabled_from_settings() -> bool {
    let Ok(path) = core::paths::settings_path() else {
        return true;
    };
    if !path.exists() {
        return true;
    }
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return true;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return true;
    };
    // Missing field → true (default). Present but non-bool → true (be
    // forgiving with malformed values). Explicit false → false.
    v.get("bridgeEnabled")
        .and_then(|x| x.as_bool())
        .unwrap_or(true)
}
