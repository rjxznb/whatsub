use crate::error::{AppError, AppResult};
use tauri::AppHandle;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Run a sidecar to completion, capturing stdout. Streams stderr to a callback for progress parsing.
pub async fn run_sidecar<F>(
    app: &AppHandle,
    bin_name: &str,
    args: &[&str],
    mut on_stderr_line: F,
) -> AppResult<String>
where
    F: FnMut(&str),
{
    let cmd = app
        .shell()
        .sidecar(bin_name)
        .map_err(|e| AppError::Subprocess(format!("sidecar {bin_name}: {e}")))?
        .args(args);

    let (mut rx, _child) = cmd
        .spawn()
        .map_err(|e| AppError::Subprocess(format!("spawn {bin_name}: {e}")))?;

    let mut stdout = String::new();
    let mut exit_code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                stdout.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                on_stderr_line(&line);
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
            }
            _ => {}
        }
    }

    match exit_code {
        Some(0) => Ok(stdout),
        Some(c) => Err(AppError::Subprocess(format!("{bin_name} exit {c}"))),
        None => Err(AppError::Subprocess(format!(
            "{bin_name} terminated abnormally"
        ))),
    }
}
