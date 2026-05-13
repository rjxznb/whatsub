use crate::error::{AppError, AppResult};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio_util::sync::CancellationToken;

/// Run a sidecar to completion, capturing stdout. Streams stderr to a callback
/// for progress parsing AND retains a tail buffer that gets included in the
/// error message on non-zero exit, so users see yt-dlp/ffmpeg/whisper's actual
/// failure reason rather than a bare "exit 1".
///
/// `cancel`: optional cancellation token. When triggered, the child process
/// is killed and `AppError::Cancelled` is returned. Pass `None` for uncancellable
/// invocations (e.g. retranscribe_video, which doesn't register an
/// ImportState entry).
pub async fn run_sidecar<F>(
    app: &AppHandle,
    bin_name: &str,
    args: &[&str],
    mut on_stderr_line: F,
    cancel: Option<&CancellationToken>,
) -> AppResult<String>
where
    F: FnMut(&str),
{
    let mut cmd = app
        .shell()
        .sidecar(bin_name)
        .map_err(|e| AppError::Subprocess(format!("sidecar {bin_name}: {e}")))?
        .args(args);

    // Windows-only: bundle.resources puts our companion DLLs (whisper.dll,
    // ggml*.dll) at <install>/resources/binaries/, NOT next to the sidecar
    // exe at <install>/. Default Windows DLL search order would miss them
    // and whisper-cli would exit with -1073741515 (STATUS_DLL_NOT_FOUND).
    // Prepend the resource binaries dir to PATH for the child process so
    // it falls through to it after the standard search locations.
    #[cfg(target_os = "windows")]
    {
        if let Ok(res_dir) = app.path().resource_dir() {
            let dll_dir = res_dir.join("binaries");
            if dll_dir.exists() {
                let cur = std::env::var("PATH").unwrap_or_default();
                let new_path = format!("{};{}", dll_dir.display(), cur);
                cmd = cmd.env("PATH", new_path);
            }
        }
    }

    let (mut rx, mut child) = cmd
        .spawn()
        .map_err(|e| AppError::Subprocess(format!("spawn {bin_name}: {e}")))?;

    let mut stdout = String::new();
    let mut stderr_tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    const TAIL_LINES: usize = 20;
    let mut exit_code: Option<i32> = None;
    let mut cancelled = false;

    // Main event loop. Watch both child output AND the cancel token so a
    // ✕ click in the UI kills the child immediately rather than waiting
    // for the next stdio chunk to come through.
    loop {
        if let Some(token) = cancel {
            tokio::select! {
                biased;
                _ = token.cancelled() => {
                    // Best-effort kill — the child may already have exited.
                    let _ = child.kill();
                    cancelled = true;
                    break;
                }
                ev = rx.recv() => {
                    match ev {
                        Some(event) => {
                            if handle_event(event, &mut stdout, &mut stderr_tail, TAIL_LINES, &mut on_stderr_line, &mut exit_code) {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
        } else {
            match rx.recv().await {
                Some(event) => {
                    if handle_event(event, &mut stdout, &mut stderr_tail, TAIL_LINES, &mut on_stderr_line, &mut exit_code) {
                        break;
                    }
                }
                None => break,
            }
        }
    }

    if cancelled {
        return Err(AppError::Cancelled);
    }

    match exit_code {
        Some(0) => Ok(stdout),
        Some(c) => {
            let tail = stderr_tail
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            let detail = if tail.is_empty() {
                String::new()
            } else {
                format!("\n--- {bin_name} stderr (last {} lines) ---\n{}", stderr_tail.len(), tail)
            };
            Err(AppError::Subprocess(format!("{bin_name} exit {c}{detail}")))
        }
        None => {
            // No Terminated event arrived — usually means dyld/exec failed before
            // the child could even run. Include any stderr we did capture, plus
            // a Mac-specific hint, so the user can diagnose.
            let tail = stderr_tail
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            let detail = if tail.is_empty() {
                String::new()
            } else {
                format!("\n--- {bin_name} stderr (last {} lines) ---\n{}", stderr_tail.len(), tail)
            };
            #[cfg(target_os = "macos")]
            let hint = "\n（macOS 提示：可能是 Gatekeeper 隔离或动态库未签名。在终端里手动执行该 sidecar 可以看到 dyld 错误。）";
            #[cfg(not(target_os = "macos"))]
            let hint = "";
            Err(AppError::Subprocess(format!(
                "{bin_name} terminated abnormally{detail}{hint}"
            )))
        }
    }
}

/// Returns true when the event loop should exit (Terminated arrived).
fn handle_event<F: FnMut(&str)>(
    event: CommandEvent,
    stdout: &mut String,
    stderr_tail: &mut std::collections::VecDeque<String>,
    tail_lines: usize,
    on_stderr_line: &mut F,
    exit_code: &mut Option<i32>,
) -> bool {
    match event {
        CommandEvent::Stdout(bytes) => {
            stdout.push_str(&String::from_utf8_lossy(&bytes));
            false
        }
        CommandEvent::Stderr(bytes) => {
            let chunk = String::from_utf8_lossy(&bytes).to_string();
            on_stderr_line(&chunk);
            for line in chunk.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if stderr_tail.len() >= tail_lines {
                    stderr_tail.pop_front();
                }
                stderr_tail.push_back(trimmed.to_string());
            }
            false
        }
        CommandEvent::Terminated(payload) => {
            *exit_code = payload.code;
            true
        }
        _ => false,
    }
}
