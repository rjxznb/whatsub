use crate::error::{AppError, AppResult};
use std::path::Path;
use std::process::Stdio;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::io::AsyncReadExt;
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
    on_stderr_line: F,
    cancel: Option<&CancellationToken>,
) -> AppResult<String>
where
    F: FnMut(&str),
{
    run_sidecar_env(app, bin_name, args, &[], on_stderr_line, cancel).await
}

/// Like [`run_sidecar`] but injects extra environment variables into the child
/// process. Used by whisper.rs to pin the Vulkan device via
/// `GGML_VK_VISIBLE_DEVICES`. Kept as a separate entry point so the ~9 other
/// sidecar callers don't all have to pass an empty env slice.
pub async fn run_sidecar_env<F>(
    app: &AppHandle,
    bin_name: &str,
    args: &[&str],
    extra_env: &[(&str, &str)],
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
    for (k, v) in extra_env {
        cmd = cmd.env(k, v);
    }

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

/// Same contract as `run_sidecar` but spawns an arbitrary path on disk
/// instead of going through Tauri's shell plugin. Used by yt-dlp when
/// the user has updated it via Settings → 更新 yt-dlp (lives in AppData,
/// not in the sidecar allowlist).
///
/// Captures stdout into the returned String, streams stderr chunks to
/// `on_stderr_line`, honours a `CancellationToken` (kills the child on
/// fire), and returns the last 20 lines of stderr in the error message
/// on non-zero exit.
pub async fn run_external_with_callback<F>(
    exe: &Path,
    args: &[&str],
    mut on_stderr_line: F,
    cancel: Option<&CancellationToken>,
) -> AppResult<String>
where
    F: FnMut(&str),
{
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Windows: don't flash a console window for the external (AppData) yt-dlp.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd
        .spawn()
        .map_err(|e| {
            AppError::Subprocess(format!("spawn {}: {e}", exe.display()))
        })?;

    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");

    let mut stdout_buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut stderr_tail: std::collections::VecDeque<String> =
        std::collections::VecDeque::new();
    const TAIL_LINES: usize = 20;

    let mut buf_out = vec![0u8; 4096];
    let mut buf_err = vec![0u8; 4096];
    let mut stdout_done = false;
    let mut stderr_done = false;

    // Read both pipes concurrently, watch for cancellation, until both
    // are EOF (which happens when the child exits). Then child.wait()
    // gives us the exit code.
    loop {
        if stdout_done && stderr_done {
            break;
        }
        let cancel_fut = async {
            match cancel {
                Some(t) => t.cancelled().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            _ = cancel_fut => {
                let _ = child.kill().await;
                return Err(AppError::Cancelled);
            }
            r = stdout.read(&mut buf_out), if !stdout_done => {
                match r {
                    Ok(0) => stdout_done = true,
                    Ok(n) => stdout_buf.extend_from_slice(&buf_out[..n]),
                    Err(_) => stdout_done = true,
                }
            }
            r = stderr.read(&mut buf_err), if !stderr_done => {
                match r {
                    Ok(0) => stderr_done = true,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf_err[..n]).to_string();
                        on_stderr_line(&chunk);
                        for line in chunk.lines() {
                            let t = line.trim();
                            if t.is_empty() { continue; }
                            if stderr_tail.len() >= TAIL_LINES { stderr_tail.pop_front(); }
                            stderr_tail.push_back(t.to_string());
                        }
                    }
                    Err(_) => stderr_done = true,
                }
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| AppError::Subprocess(format!("wait: {e}")))?;
    let stdout_str = String::from_utf8_lossy(&stdout_buf).to_string();

    match status.code() {
        Some(0) => Ok(stdout_str),
        Some(c) => {
            let tail = stderr_tail
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            let detail = if tail.is_empty() {
                String::new()
            } else {
                format!(
                    "\n--- {} stderr (last {} lines) ---\n{}",
                    exe.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("child"),
                    stderr_tail.len(),
                    tail
                )
            };
            Err(AppError::Subprocess(format!("exit {c}{detail}")))
        }
        None => Err(AppError::Subprocess(
            "child terminated abnormally (no exit code)".into(),
        )),
    }
}
