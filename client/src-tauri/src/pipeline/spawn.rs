use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

/// Shared progress counter for the stall watchdog. The caller's output callback
/// bumps it once per progress line (yt-dlp download % / whisper transcribe %);
/// the spawn loop kills the child if it stops advancing. `None` = watchdog
/// disabled (the default for ffmpeg + other sidecars).
pub type StallCounter = std::sync::Arc<std::sync::atomic::AtomicU64>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StallPhase {
    Preparing,
    Downloading,
    Merging,
}

#[derive(Debug, Clone, Copy)]
struct StallSnapshot {
    phase: StallPhase,
    activity: u64,
}

/// Cloneable liveness probe consumed by the generic spawn loops.
/// Whisper uses progress-only mode; yt-dlp can switch to observing merge
/// output growth after its download phase completes.
#[derive(Clone)]
pub struct StallWatch {
    progress: StallCounter,
    merge_output: Option<PathBuf>,
    merging: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl StallWatch {
    pub fn progress_only(progress: StallCounter) -> Self {
        Self {
            progress,
            merge_output: None,
            merging: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub fn with_merge_output(progress: StallCounter, merge_output: PathBuf) -> Self {
        Self {
            progress,
            merge_output: Some(merge_output),
            merging: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub fn mark_merging(&self) {
        self.merging
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    fn snapshot(&self) -> StallSnapshot {
        if self.merging.load(std::sync::atomic::Ordering::Relaxed) {
            let activity = self
                .merge_output
                .as_ref()
                .and_then(|path| std::fs::metadata(path).ok())
                .map(|meta| meta.len())
                .unwrap_or(0);
            StallSnapshot {
                phase: StallPhase::Merging,
                activity,
            }
        } else {
            let activity = self.progress.load(std::sync::atomic::Ordering::Relaxed);
            StallSnapshot {
                phase: if activity == 0 {
                    StallPhase::Preparing
                } else {
                    StallPhase::Downloading
                },
                activity,
            }
        }
    }
}

#[derive(Default)]
struct StallTracker {
    last_phase: Option<StallPhase>,
    last_activity: u64,
    stale_ticks: u32,
}

impl StallTracker {
    fn observe(&mut self, snapshot: StallSnapshot) -> bool {
        if snapshot.phase == StallPhase::Preparing {
            self.last_phase = None;
            self.last_activity = 0;
            self.stale_ticks = 0;
            return false;
        }

        if self.last_phase != Some(snapshot.phase) {
            self.last_phase = Some(snapshot.phase);
            self.last_activity = snapshot.activity;
            self.stale_ticks = 0;
            return false;
        }

        if snapshot.activity != self.last_activity {
            self.last_activity = snapshot.activity;
            self.stale_ticks = 0;
            return false;
        }

        self.stale_ticks += 1;
        self.stale_ticks >= STALL_MAX_TICKS
    }
}

// Stall watchdog tuning. The watchdog ARMS only after the counter first moves
// (download actually started), so the legitimately-silent, sometimes
// minutes-long sigsolver / 准备中 phase is never killed. Once armed, if the
// counter doesn't advance for STALL_TICK_SECS × STALL_MAX_TICKS seconds the
// child is killed and a "stalled" error returned, so the caller can re-spawn
// and resume from the .part (yt-dlp --continue).
const STALL_TICK_SECS: u64 = 15;
const STALL_MAX_TICKS: u32 = 8; // 8 × 15s = 120s of zero progress → stalled

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
    run_sidecar_env(
        app,
        bin_name,
        args,
        &[],
        None,
        false,
        on_stderr_line,
        cancel,
    )
    .await
}

/// Like [`run_sidecar`] but injects extra environment variables into the child
/// process. `stream_stdout` additionally sends stdout chunks to the same callback
/// while still retaining them in the returned string. Used by yt-dlp because its
/// normal extraction/progress messages are stdout, while warnings/errors are
/// stderr. Whisper keeps this disabled because its callback contract is stderr.
/// The extra environment is used by whisper.rs to pin the Vulkan device via
/// `GGML_VK_VISIBLE_DEVICES` without forcing other sidecar callers to pass an
/// environment slice.
pub async fn run_sidecar_env<F>(
    app: &AppHandle,
    bin_name: &str,
    args: &[&str],
    extra_env: &[(&str, &str)],
    stall: Option<StallWatch>,
    stream_stdout: bool,
    mut on_output: F,
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
    let mut stalled = false;

    // Stall watchdog state (no-op unless `stall` is Some).
    let stall_enabled = stall.is_some();
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(STALL_TICK_SECS));
    ticker.tick().await; // consume the immediate first tick
    let mut stall_tracker = StallTracker::default();

    // Main event loop. Watch child output, the cancel token (so a ✕ click kills
    // the child immediately), AND the stall watchdog tick.
    loop {
        let cancel_fut = async {
            match cancel {
                Some(t) => t.cancelled().await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            biased;
            _ = cancel_fut => {
                // Best-effort kill — the child may already have exited.
                let _ = child.kill();
                cancelled = true;
                break;
            }
            _ = ticker.tick(), if stall_enabled => {
                if stall_tracker.observe(stall.as_ref().unwrap().snapshot()) {
                    let _ = child.kill();
                    stalled = true;
                    break;
                }
            }
            ev = rx.recv() => {
                match ev {
                    Some(event) => {
                        if handle_event(
                            event,
                            &mut stdout,
                            &mut stderr_tail,
                            TAIL_LINES,
                            stream_stdout,
                            &mut on_output,
                            &mut exit_code,
                        ) {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    if cancelled {
        return Err(AppError::Cancelled);
    }
    if stalled {
        return Err(AppError::Subprocess(format!(
            "{bin_name} stalled — no progress for ~{}s",
            STALL_TICK_SECS * STALL_MAX_TICKS as u64
        )));
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
    stream_stdout: bool,
    on_output: &mut F,
    exit_code: &mut Option<i32>,
) -> bool {
    match event {
        CommandEvent::Stdout(bytes) => {
            let chunk = String::from_utf8_lossy(&bytes).to_string();
            stdout.push_str(&chunk);
            if stream_stdout {
                on_output(&chunk);
            }
            false
        }
        CommandEvent::Stderr(bytes) => {
            let chunk = String::from_utf8_lossy(&bytes).to_string();
            on_output(&chunk);
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
/// Captures stdout into the returned String, streams stderr chunks (and,
/// optionally, stdout chunks) to `on_output`, honours a `CancellationToken`
/// (kills the child on fire), and returns the last 20 lines of stderr in the
/// error message on non-zero exit.
pub async fn run_external_with_callback<F>(
    exe: &Path,
    args: &[&str],
    stall: Option<StallWatch>,
    stream_stdout: bool,
    mut on_output: F,
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

    // Stall watchdog state (no-op unless `stall` is Some). See STALL_* above.
    let stall_enabled = stall.is_some();
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(STALL_TICK_SECS));
    ticker.tick().await; // consume the immediate first tick
    let mut stall_tracker = StallTracker::default();

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
            _ = ticker.tick(), if stall_enabled => {
                if stall_tracker.observe(stall.as_ref().unwrap().snapshot()) {
                    let _ = child.kill().await;
                    return Err(AppError::Subprocess(format!(
                        "{} stalled — no progress for ~{}s",
                        exe.display(),
                        STALL_TICK_SECS * STALL_MAX_TICKS as u64
                    )));
                }
            }
            r = stdout.read(&mut buf_out), if !stdout_done => {
                match r {
                    Ok(0) => stdout_done = true,
                    Ok(n) => {
                        stdout_buf.extend_from_slice(&buf_out[..n]);
                        if stream_stdout {
                            let chunk = String::from_utf8_lossy(&buf_out[..n]).to_string();
                            on_output(&chunk);
                        }
                    },
                    Err(_) => stdout_done = true,
                }
            }
            r = stderr.read(&mut buf_err), if !stderr_done => {
                match r {
                    Ok(0) => stderr_done = true,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf_err[..n]).to_string();
                        on_output(&chunk);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(phase: StallPhase, activity: u64) -> StallSnapshot {
        StallSnapshot { phase, activity }
    }

    #[test]
    fn preparing_never_stalls() {
        let mut tracker = StallTracker::default();

        for _ in 0..(STALL_MAX_TICKS * 2) {
            assert!(!tracker.observe(snapshot(StallPhase::Preparing, 0)));
        }
    }

    #[test]
    fn downloading_stalls_after_eight_unchanged_samples() {
        let mut tracker = StallTracker::default();
        assert!(!tracker.observe(snapshot(StallPhase::Downloading, 1)));

        for _ in 0..(STALL_MAX_TICKS - 1) {
            assert!(!tracker.observe(snapshot(StallPhase::Downloading, 1)));
        }
        assert!(tracker.observe(snapshot(StallPhase::Downloading, 1)));
    }

    #[test]
    fn merge_growth_resets_stale_samples() {
        let mut tracker = StallTracker::default();
        assert!(!tracker.observe(snapshot(StallPhase::Merging, 10)));
        for _ in 0..(STALL_MAX_TICKS - 1) {
            assert!(!tracker.observe(snapshot(StallPhase::Merging, 10)));
        }

        assert!(!tracker.observe(snapshot(StallPhase::Merging, 20)));
        for _ in 0..(STALL_MAX_TICKS - 1) {
            assert!(!tracker.observe(snapshot(StallPhase::Merging, 20)));
        }
    }

    #[test]
    fn merge_stalls_after_eight_unchanged_sizes() {
        let mut tracker = StallTracker::default();
        assert!(!tracker.observe(snapshot(StallPhase::Merging, 10)));

        for _ in 0..(STALL_MAX_TICKS - 1) {
            assert!(!tracker.observe(snapshot(StallPhase::Merging, 10)));
        }
        assert!(tracker.observe(snapshot(StallPhase::Merging, 10)));
    }

    #[test]
    fn phase_change_resets_the_baseline() {
        let mut tracker = StallTracker::default();
        assert!(!tracker.observe(snapshot(StallPhase::Downloading, 1)));
        for _ in 0..(STALL_MAX_TICKS - 1) {
            assert!(!tracker.observe(snapshot(StallPhase::Downloading, 1)));
        }

        assert!(!tracker.observe(snapshot(StallPhase::Merging, 0)));
        for _ in 0..(STALL_MAX_TICKS - 1) {
            assert!(!tracker.observe(snapshot(StallPhase::Merging, 0)));
        }
        assert!(tracker.observe(snapshot(StallPhase::Merging, 0)));
    }

    #[test]
    fn stdout_is_retained_and_streamed_when_enabled() {
        let mut stdout = String::new();
        let mut stderr_tail = std::collections::VecDeque::new();
        let mut streamed = Vec::<String>::new();
        let mut exit_code = None;

        let terminated = handle_event(
            CommandEvent::Stdout(b"[youtube] Downloading webpage\n".to_vec()),
            &mut stdout,
            &mut stderr_tail,
            20,
            true,
            &mut |chunk| streamed.push(chunk.to_string()),
            &mut exit_code,
        );

        assert!(!terminated);
        assert_eq!(stdout, "[youtube] Downloading webpage\n");
        assert_eq!(streamed, vec!["[youtube] Downloading webpage\n"]);
        assert!(stderr_tail.is_empty());
    }

    #[test]
    fn stdout_is_only_retained_when_streaming_is_disabled() {
        let mut stdout = String::new();
        let mut stderr_tail = std::collections::VecDeque::new();
        let mut streamed = Vec::<String>::new();
        let mut exit_code = None;

        handle_event(
            CommandEvent::Stdout(b"probe result\n".to_vec()),
            &mut stdout,
            &mut stderr_tail,
            20,
            false,
            &mut |chunk| streamed.push(chunk.to_string()),
            &mut exit_code,
        );

        assert_eq!(stdout, "probe result\n");
        assert!(streamed.is_empty());
    }
}
