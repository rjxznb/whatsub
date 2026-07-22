# Whisper Vulkan Crash Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically recover Windows Whisper transcription from Vulkan access-violation crashes by restarting once in a true CPU-only mode, then keep the current App session on CPU.

**Architecture:** Add a small execution-mode boundary in `pipeline/whisper.rs` that owns argument and environment construction. A process-global atomic records that Vulkan crashed during this App session. The existing transcription retry loop switches from GPU to CPU exactly once on exit `-1073741819`; the CPU process receives both `GGML_DISABLE_VULKAN=1` and `-ng`. Frontend diagnosis recognizes the combined GPU/CPU failure marker and suppresses the misleading local-file checklist.

**Tech Stack:** Rust, Tauri 2, whisper.cpp v1.8.4 sidecar, React 19, TypeScript, Vitest.

## Global Constraints

- Do not delete, rename, validate, or download Whisper model files.
- Preserve the selected model tier: tiny, base, small, medium, or large-v3.
- GPU-to-CPU recovery occurs at most once per transcription.
- `GGML_DISABLE_VULKAN=1` and `-ng` are both required for CPU mode.
- Vulkan safe mode is process-local and resets when the App restarts.
- Do not trigger CI.

---

### Task 1: Pure Whisper execution-mode helpers

**Files:**
- Modify: `src-tauri/src/pipeline/whisper.rs:79-102`
- Test: `src-tauri/src/pipeline/whisper.rs:778-end`

**Interfaces:**
- Produces: `WhisperRunMode::{Gpu, Cpu}`, `build_whisper_args(..., mode)`, `build_whisper_env(mode, pinned)`, and `should_fallback_to_cpu(error, mode)`.
- Consumes: existing VAD argument construction and `AppError::Subprocess`.

- [ ] **Step 1: Write failing tests for CPU args, environment, and exit-code classification**

Add tests that express the desired API:

```rust
#[test]
fn cpu_mode_disables_gpu_in_args_and_environment() {
    let args = build_whisper_args("m.bin", "a.wav", "out", None, WhisperRunMode::Cpu);
    assert!(args.contains(&"-ng"));

    let env = build_whisper_env(WhisperRunMode::Cpu, Some("1"));
    assert_eq!(env, vec![("GGML_DISABLE_VULKAN", "1")]);
}

#[test]
fn gpu_mode_preserves_device_pinning_without_cpu_flags() {
    let args = build_whisper_args("m.bin", "a.wav", "out", None, WhisperRunMode::Gpu);
    assert!(!args.contains(&"-ng"));
    assert_eq!(
        build_whisper_env(WhisperRunMode::Gpu, Some("1")),
        vec![("GGML_VK_VISIBLE_DEVICES", "1")],
    );
}

#[test]
fn only_gpu_access_violation_uses_cpu_recovery() {
    let access = AppError::Subprocess(
        "whisper-cli exit -1073741819\n--- whisper-cli stderr ---\nggml_vulkan: Found 2 Vulkan devices".into(),
    );
    let other = AppError::Subprocess("whisper-cli exit 3".into());
    assert!(should_fallback_to_cpu(&access, WhisperRunMode::Gpu));
    assert!(!should_fallback_to_cpu(&access, WhisperRunMode::Cpu));
    assert!(!should_fallback_to_cpu(&other, WhisperRunMode::Gpu));
    assert!(!should_fallback_to_cpu(&AppError::Cancelled, WhisperRunMode::Gpu));
}
```

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run:

```powershell
Set-Location src-tauri
cargo test pipeline::whisper::tests::cpu_mode_disables_gpu_in_args_and_environment
```

Expected: compilation fails because `WhisperRunMode`, the new parameter, and helper functions do not exist.

- [ ] **Step 3: Implement the minimal pure helpers**

Add the enum and adapt argument construction:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WhisperRunMode {
    Gpu,
    Cpu,
}

fn build_whisper_args<'a>(
    model: &'a str,
    audio: &'a str,
    out_base: &'a str,
    vad_model: Option<&'a str>,
    mode: WhisperRunMode,
) -> Vec<&'a str> {
    let mut args = vec![
        "-m", model, "-f", audio, "-l", "en", "-mc", "0", "-osrt", "-of",
        out_base, "--print-progress",
    ];
    if mode == WhisperRunMode::Cpu {
        args.push("-ng");
    }
    if let Some(vm) = vad_model {
        args.extend(["--vad", "--vad-model", vm]);
    }
    args
}

fn build_whisper_env<'a>(
    mode: WhisperRunMode,
    pinned: Option<&'a str>,
) -> Vec<(&'static str, &'a str)> {
    match mode {
        WhisperRunMode::Cpu => vec![("GGML_DISABLE_VULKAN", "1")],
        WhisperRunMode::Gpu => pinned
            .map(|value| vec![("GGML_VK_VISIBLE_DEVICES", value)])
            .unwrap_or_default(),
    }
}

fn should_fallback_to_cpu(error: &AppError, mode: WhisperRunMode) -> bool {
    mode == WhisperRunMode::Gpu
        && matches!(
            error,
            AppError::Subprocess(message)
                if message.starts_with("whisper-cli exit -1073741819")
        )
}
```

Update the two existing VAD argument tests to pass `WhisperRunMode::Gpu`.

- [ ] **Step 4: Run all Whisper unit tests and verify GREEN**

Run:

```powershell
Set-Location src-tauri
cargo test pipeline::whisper::tests
```

Expected: every Whisper test passes.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src-tauri/src/pipeline/whisper.rs
git commit -m "test(whisper): define Vulkan CPU recovery mode"
```

---

### Task 2: Runtime GPU-to-CPU recovery state machine

**Files:**
- Modify: `src-tauri/src/pipeline/whisper.rs:369-627`
- Test: `src-tauri/src/pipeline/whisper.rs:778-end`

**Interfaces:**
- Consumes: `WhisperRunMode`, `build_whisper_env`, `should_fallback_to_cpu` from Task 1.
- Produces: session-level `VULKAN_DISABLED_FOR_SESSION`, one-time CPU retry, and combined failure marker `whisper_gpu_cpu_fallback_failed`.

- [ ] **Step 1: Write failing state-transition and combined-error tests**

Add pure helpers to the wished-for API and tests:

```rust
#[test]
fn session_safe_mode_starts_new_runs_on_cpu() {
    assert_eq!(initial_run_mode(false), WhisperRunMode::Gpu);
    assert_eq!(initial_run_mode(true), WhisperRunMode::Cpu);
}

#[test]
fn combined_fallback_error_keeps_both_failures() {
    let combined = combine_gpu_cpu_errors(
        "whisper-cli exit -1073741819",
        "whisper-cli exit 3",
    );
    let text = combined.to_string();
    assert!(text.contains("whisper_gpu_cpu_fallback_failed"));
    assert!(text.contains("GPU: whisper-cli exit -1073741819"));
    assert!(text.contains("CPU: whisper-cli exit 3"));
}
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
Set-Location src-tauri
cargo test pipeline::whisper::tests::session_safe_mode_starts_new_runs_on_cpu
```

Expected: compilation fails because the state helpers do not exist.

- [ ] **Step 3: Add process-local safe mode and pure state helpers**

At module scope:

```rust
static VULKAN_DISABLED_FOR_SESSION: AtomicBool = AtomicBool::new(false);

fn initial_run_mode(vulkan_disabled: bool) -> WhisperRunMode {
    if vulkan_disabled {
        WhisperRunMode::Cpu
    } else {
        WhisperRunMode::Gpu
    }
}

fn combine_gpu_cpu_errors(gpu: &str, cpu: &str) -> AppError {
    AppError::Subprocess(format!(
        "whisper_gpu_cpu_fallback_failed\nGPU: {gpu}\nCPU: {cpu}"
    ))
}
```

- [ ] **Step 4: Thread the execution mode through one Whisper attempt**

Add `mode: WhisperRunMode` to `run_whisper_once`, construct args with that mode, and emit the backend label based on mode:

```rust
let whisper_args = build_whisper_args(
    model_str,
    audio_str,
    out_base,
    vad_model,
    mode,
);

if !backend_emitted.load(std::sync::atomic::Ordering::Relaxed) {
    let name = if mode == WhisperRunMode::Cpu {
        "CPU（GPU 异常，已自动降级）"
    } else {
        "CPU"
    };
    emit(app, PipelineEvent::BackendDetected { name: name.into() });
}
```

Only persist Vulkan inventory when `mode == WhisperRunMode::Gpu`.

- [ ] **Step 5: Replace the fixed environment with the bounded recovery loop**

Initialize mode from the process atomic, build the environment for every attempt, preserve stall retries, and switch once:

```rust
let mut mode = initial_run_mode(
    VULKAN_DISABLED_FOR_SESSION.load(Ordering::Relaxed),
);
let mut gpu_error: Option<String> = None;
let mut stall_retries = 0u32;

loop {
    let env = build_whisper_env(mode, pin_str.as_deref());
    match run_whisper_once(
        app,
        &audio_str,
        &model_str,
        &out_base,
        &env,
        prefer_discrete,
        pinned,
        vad_arg.as_deref(),
        mode,
        video_id,
        cancel,
    )
    .await
    {
        Ok(()) => return Ok(out_dir.join("transcript.srt")),
        Err(AppError::Cancelled) => return Err(AppError::Cancelled),
        Err(error) if should_fallback_to_cpu(&error, mode) => {
            let original = error.to_string();
            VULKAN_DISABLED_FOR_SESSION.store(true, Ordering::Relaxed);
            gpu_error = Some(original);
            mode = WhisperRunMode::Cpu;
            stall_retries = 0;
            emit(app, PipelineEvent::Log {
                video_id: video_id.to_string(),
                source: "whatsub".into(),
                line: "显卡加速启动异常，已自动切换 CPU 继续识别".into(),
            });
            emit(app, PipelineEvent::Transcribing {
                video_id: video_id.to_string(),
                percent: 0,
            });
        }
        Err(error)
            if error.to_string().contains("stalled")
                && stall_retries < WHISPER_STALL_RETRIES =>
        {
            stall_retries += 1;
            // Keep the existing stall log and progress-reset emissions.
        }
        Err(error) => {
            return match gpu_error {
                Some(ref gpu) => Err(combine_gpu_cpu_errors(gpu, &error.to_string())),
                None => Err(error),
            };
        }
    }
}
```

The actual implementation must retain the existing stall log text and events rather than duplicating them.

- [ ] **Step 6: Run focused tests and Rust build**

Run:

```powershell
Set-Location src-tauri
cargo test pipeline::whisper::tests
cargo build
```

Expected: tests pass and build exits 0 without warnings from the modified code.

- [ ] **Step 7: Commit Task 2**

```powershell
git add src-tauri/src/pipeline/whisper.rs
git commit -m "fix(whisper): recover Vulkan crashes on CPU"
```

---

### Task 3: Accurate local-import failure diagnosis

**Files:**
- Modify: `src/utils/friendlyError.ts:411-466`
- Test: `src/utils/friendlyError.test.ts`
- Modify: `src/components/ImportModal.tsx:583-773`
- Test: `src/components/ImportModal.test.tsx`

**Interfaces:**
- Consumes: Rust marker `whisper_gpu_cpu_fallback_failed`.
- Produces: focused local diagnosis title `显卡加速和 CPU 兜底均失败` and suppression of the generic local-file checklist for diagnosed errors.

- [ ] **Step 1: Write failing friendly-error test**

```ts
it("explains when Vulkan crashed and the automatic CPU fallback also failed", () => {
  const result = friendlyError(
    "whisper_gpu_cpu_fallback_failed\nGPU: whisper-cli exit -1073741819\nCPU: whisper-cli exit 3",
    "transcribing",
  );
  expect(result.title).toBe("显卡加速和 CPU 兜底均失败");
  expect(result.suggestion).toContain("已经自动切换到 CPU");
  expect(result.generic).not.toBe(true);
});
```

- [ ] **Step 2: Run the target test and verify RED**

Run:

```powershell
pnpm test -- src/utils/friendlyError.test.ts
```

Expected: title is the generic Whisper failure rather than the new diagnosis.

- [ ] **Step 3: Add the marker-specific classification before generic Whisper rules**

```ts
if (txt.includes("whisper_gpu_cpu_fallback_failed")) {
  return {
    title: "显卡加速和 CPU 兜底均失败",
    suggestion:
      "显卡驱动导致 Vulkan 启动崩溃，whatsub 已经自动切换到 CPU，但 CPU 识别仍未完成。建议更新 Intel/NVIDIA 显卡驱动；如果仍失败，请复制下方详细日志联系支持。",
    details: raw,
  };
}
```

- [ ] **Step 4: Write failing ImportModal regression test**

Drive a local import into the `Failed` event with the combined marker, open the failure dialog, then assert:

```ts
expect(screen.getByText("显卡加速和 CPU 兜底均失败")).toBeInTheDocument();
expect(screen.queryByText("视频文件本身有问题")).toBeNull();
expect(screen.getByText(/已经自动切换到 CPU/)).toBeInTheDocument();
```

- [ ] **Step 5: Run the ImportModal test and verify RED**

Run:

```powershell
pnpm test -- src/components/ImportModal.test.tsx
```

Expected: the dialog still renders `解析失败 — 排查清单` and `视频文件本身有问题`.

- [ ] **Step 6: Let diagnosed local errors use `friendlyError`**

Introduce:

```ts
const isLocal = tab === "local";
const isDiagnosedLocal = isLocal && !fe.generic;
const isDiagnosedDownload = !isLocal && !fe.generic;
const isDiagnosed = isDiagnosedLocal || isDiagnosedDownload;
```

Use `fe.title` and `fe.suggestion` when `isDiagnosed`, render the existing focused diagnosis card for both local and URL errors, and render the three-item local checklist only when `isLocal && !isDiagnosedLocal`.

- [ ] **Step 7: Run frontend target tests and typecheck**

Run:

```powershell
pnpm test -- src/utils/friendlyError.test.ts src/components/ImportModal.test.tsx
pnpm typecheck
```

Expected: both test files pass and TypeScript exits 0.

- [ ] **Step 8: Commit Task 3**

```powershell
git add src/utils/friendlyError.ts src/utils/friendlyError.test.ts src/components/ImportModal.tsx src/components/ImportModal.test.tsx
git commit -m "fix(import): explain Whisper GPU recovery failures"
```

---

### Task 4: Documentation and full verification

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: final runtime behavior from Tasks 1-3.
- Produces: maintainer note explaining why `-ng` alone is insufficient for Vulkan startup crashes.

- [ ] **Step 1: Document the Windows Vulkan startup pitfall**

Add a concise note under the Whisper/GPU section:

```markdown
- Windows Vulkan access violation (`whisper-cli exit -1073741819`): `whisper-cli`
  loads backends before parsing `-ng`, so CPU recovery must set
  `GGML_DISABLE_VULKAN=1` and pass `-ng`. After one crash, the current App
  session remains CPU-only; restart permits GPU probing again.
```

- [ ] **Step 2: Run the complete verification gate**

Run:

```powershell
Set-Location src-tauri
cargo fmt -- --check
cargo test
cargo build
Set-Location ..
pnpm test
pnpm typecheck
git diff --check
```

Expected: every command exits 0; no modified-code warnings; full Rust and Vitest suites pass.

- [ ] **Step 3: Commit documentation**

```powershell
git add CLAUDE.md
git commit -m "docs: record Whisper Vulkan CPU fallback"
```

- [ ] **Step 4: Confirm repository scope**

Run:

```powershell
git status --short
git log -5 --oneline
```

Expected: only pre-existing user-owned untracked paths remain; no CI workflow or release-version file changed.
