mod core;
mod error;
mod commands;
mod pipeline;
mod bridge;
pub mod auth;

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
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(commands::analysis::ExportState::default())
        .manage(commands::models::ModelDownloadState::default())
        .manage(commands::youtube_auth::LoginState::default())
        .manage(commands::import::ImportState::default())
        .manage(bridge::BridgeState::default())
        .setup(|app| {
            // Bridge: gated by settings.bridgeEnabled (default true).
            // Users without the browser plugin can flip it off in
            // Settings — `bridge_set_enabled` command toggles it at
            // runtime now (no restart needed). At startup we honour
            // the on-disk setting so users who explicitly turned it
            // off don't see it come back.
            if bridge_enabled_from_settings() {
                if let Some(h) = bridge::start_bridge(app.handle().clone()) {
                    use tauri::Manager;
                    if let Some(state) = app.try_state::<bridge::BridgeState>() {
                        if let Ok(mut g) = state.handle.lock() {
                            *g = Some(h);
                        }
                    }
                }
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
            bridge::bridge_set_enabled,
            commands::youtube_auth::site_presets,
            commands::youtube_auth::site_logins_list,
            commands::youtube_auth::site_login_pending,
            commands::youtube_auth::site_login_start,
            commands::youtube_auth::site_login_finish,
            commands::youtube_auth::site_login_cancel,
            commands::youtube_auth::site_login_remove,
            commands::youtube_auth::site_logins_clear,
            commands::auth::auth_send_code,
            commands::auth::auth_verify_code,
            commands::auth::auth_me,
            commands::auth::auth_logout,
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
