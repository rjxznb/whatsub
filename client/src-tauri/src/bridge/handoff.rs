use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Show a native confirmation dialog asking the user to approve a one-time
/// LLM config handoff (including the API key) to the requesting extension.
///
/// Returns `true` if the user clicked "同意", `false` if they cancelled or
/// clicked "拒绝". Runs the blocking dialog on a Tokio blocking thread so it
/// does not stall the async actix handler.
pub async fn request_handoff(app: &AppHandle, extension_id: &str) -> bool {
    let title = "插件请求继承翻译配置";
    let body = format!(
        "浏览器插件 (id: {extension_id}) 请求一次性读取你的 LLM 配置（含 API Key）。同意吗？"
    );

    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        app.dialog()
            .message(body)
            .title(title)
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "同意".into(),
                "拒绝".into(),
            ))
            .blocking_show()
    })
    .await
    .unwrap_or(false)
}
