# Started Download Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once yt-dlp has emitted real progress or entered merging, keep resuming transient failures until success, deterministic failure, or explicit cancellation.

**Architecture:** Preserve the existing stage-aware `StallWatch`, merge-output liveness, `--continue`, and partial-file protection. Add a pure error/retry policy, sticky download-session state across process attempts, stage-specific cleanup, cancellation-aware backoff, and a typed retry progress event.

**Tech Stack:** Rust 2021, Tokio, `CancellationToken`, Tauri events, React 19, Zustand 5, TypeScript 5.8, Vitest 4.

## Global Constraints

- Foreground downloads with zero real progress retain the current short failure behavior.
- After progress or merge start, transient network and watchdog-stall recovery has no fixed retry-count limit.
- Retry delays are 3s, 5s, 10s, 20s, then 30s for every later retry.
- Authentication, Cookie, bot-check, private/deleted/restricted video, unavailable format, local dependency, cancellation, and unknown errors stop immediately.
- Download-stage recovery preserves all files; merge-stage recovery removes only `source.temp.mp4` and defensive `source.mp4`.
- Cancellation must interrupt child execution, retry backoff, and the next-spawn boundary.
- Existing MP4-compatible format selection and stage-aware watchdog behavior must remain covered.
- Do not change dependency manifests, release configuration, or CI.
- Run `pnpm install --frozen-lockfile` before frontend tests in this worktree.

---

### Task 1: Define pure error classification and retry policy

**Files:**
- Modify: `client/src-tauri/src/pipeline/spawn.rs:20-90`
- Modify: `client/src-tauri/src/pipeline/ytdlp.rs:720-940`

**Interfaces:**
- Makes `StallPhase` and `StallWatch::phase()` available inside the crate.
- Produces private `DownloadErrorKind`, `RetryLane`, `RetryCleanup`, `RetryCounters`, `RetryDecisionInput`, `RetryDecision`.

- [ ] **Step 1: Add failing pure-policy tests**

Add tests named:

```rust
foreground_zero_progress_transient_stops
background_zero_progress_uses_two_base_retries
cookie_error_stops_even_after_download_started
removed_video_stops_even_after_download_started
requested_format_is_deterministic
started_connection_reset_uses_network_resume
started_stall_uses_stall_resume
network_and_stall_counters_are_independent
resume_backoff_is_3_5_10_20_then_30
resume_has_no_fixed_retry_limit
cancellation_precedes_every_other_decision
```

Representative assertions:

```rust
assert_eq!(
    classify_yt_dlp_error(&AppError::Subprocess(
        "Sign in to confirm you're not a bot; unable to download webpage".into(),
    )),
    DownloadErrorKind::Deterministic,
);

assert_eq!(
    classify_yt_dlp_error(&AppError::Subprocess(
        "HTTP Error 503: Service Unavailable".into(),
    )),
    DownloadErrorKind::TransientNetwork,
);

assert!(matches!(
    decide_retry(RetryDecisionInput {
        mode: DownloadMode::Foreground,
        ever_started: true,
        stage: StallPhase::Downloading,
        error: DownloadErrorKind::TransientNetwork,
        cancellation_requested: false,
        counters: RetryCounters {
            network_resumes: 50_000,
            ..RetryCounters::default()
        },
    }),
    RetryDecision::Retry { retry_number: 50_001, .. }
));
```

- [ ] **Step 2: Run and verify RED**

```powershell
Set-Location client/src-tauri
cargo test pipeline::ytdlp::tests --lib
```

Expected: compilation failures because the policy types/functions do not exist.

- [ ] **Step 3: Expose the current watchdog phase**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StallPhase {
    Preparing,
    Downloading,
    Merging,
}

impl StallWatch {
    pub(crate) fn phase(&self) -> StallPhase {
        self.snapshot().phase
    }
}
```

Do not change either process-runner signature.

- [ ] **Step 4: Add the policy types and functions**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadMode { Foreground, Background }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadErrorKind { Stall, TransientNetwork, Deterministic, LocalDependency, Unknown }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryLane { Base, NetworkResume, StallResume }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryCleanup { PreserveAll, RemoveMergeOutputs }

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct RetryCounters { base_retries: u32, network_resumes: u32, stall_resumes: u32 }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RetryDecisionInput {
    mode: DownloadMode,
    ever_started: bool,
    stage: StallPhase,
    error: DownloadErrorKind,
    cancellation_requested: bool,
    counters: RetryCounters,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryDecision {
    Stop,
    Retry { lane: RetryLane, retry_number: u32, delay: Duration, cleanup: RetryCleanup },
}
```

Evaluate fatal fragments before transient fragments. Do not classify HTTP 403, `requested format is not available`, `unable to extract`, `no video formats`, or bot/Cookie errors as transient. Before progress, foreground stops and background allows two base retries. After progress, only `TransientNetwork` and `Stall` retry without a maximum.

- [ ] **Step 5: Run policy tests and commit**

```powershell
cargo test pipeline::ytdlp::tests --lib
cargo test pipeline::spawn::tests --lib
git add src/pipeline/spawn.rs src/pipeline/ytdlp.rs
git diff --cached --check
git commit -m "test(ytdlp): define started-download retry policy"
```

### Task 2: Track sticky session state and stage-specific cleanup

**Files:**
- Modify: `client/src-tauri/src/pipeline/ytdlp.rs:349-620`
- Modify tests: `client/src-tauri/src/pipeline/ytdlp.rs:850+`

**Interfaces:**
- Produces private `DownloadSession` and `apply_retry_cleanup()`.
- Consumes `StallPhase` and pure policy types.

- [ ] **Step 1: Add failing sticky-state and cleanup tests**

```rust
progress_makes_ever_started_sticky
merging_makes_ever_started_sticky
later_preparing_attempt_does_not_clear_ever_started
download_retry_preserves_all_partial_files
merge_retry_removes_only_merge_outputs
```

The cleanup fixture must create `source.mp4`, `source.temp.mp4`, `source.f137.mp4`, `source.f140.m4a`, `source.f137.mp4.part`, `source.ytdl`, and a simulated fragment. For merge cleanup only the first two may disappear.

- [ ] **Step 2: Run and verify RED**

```powershell
cargo test pipeline::ytdlp::tests --lib
```

- [ ] **Step 3: Implement sticky state**

```rust
#[derive(Debug)]
struct DownloadSession {
    ever_started: bool,
    last_stage: StallPhase,
    retries: RetryCounters,
    process_attempt: u32,
}

impl Default for DownloadSession {
    fn default() -> Self {
        Self {
            ever_started: false,
            last_stage: StallPhase::Preparing,
            retries: RetryCounters::default(),
            process_attempt: 0,
        }
    }
}

impl DownloadSession {
    fn observe_attempt(&mut self, stage: StallPhase) {
        self.last_stage = stage;
        if stage != StallPhase::Preparing {
            self.ever_started = true;
        }
    }

    fn record_retry(&mut self, lane: RetryLane) {
        match lane {
            RetryLane::Base => self.retries.base_retries += 1,
            RetryLane::NetworkResume => self.retries.network_resumes += 1,
            RetryLane::StallResume => self.retries.stall_resumes += 1,
        }
    }
}
```

Once `ever_started` is true, a later `Preparing` attempt must not clear it.

- [ ] **Step 4: Replace broad stall cleanup with stage-specific cleanup**

```rust
fn apply_retry_cleanup(cleanup: RetryCleanup, output: &Path) {
    if cleanup == RetryCleanup::RemoveMergeOutputs {
        let _ = std::fs::remove_file(merge_temp_path(output));
        let _ = std::fs::remove_file(output);
    }
}
```

Delete `prepare_stall_retry()` only after its existing partial-preservation assertions are represented by the new tests.

- [ ] **Step 5: Verify and commit**

```powershell
cargo test pipeline::spawn::tests --lib
cargo test pipeline::ytdlp::tests --lib
git add src/pipeline/spawn.rs src/pipeline/ytdlp.rs
git diff --cached --check
git commit -m "fix(ytdlp): track sticky download stage"
```

### Task 3: Wire unlimited resume and cancellable backoff

**Files:**
- Modify: `client/src-tauri/src/pipeline/ytdlp.rs:349-620`
- Preserve unchanged: `client/src-tauri/src/commands/import.rs` cancellation cleanup

**Interfaces:**
- Produces private `ensure_not_cancelled()` and `wait_retry_delay()`.
- Replaces shared `attempt/base_attempts/stall_retries` policy with `DownloadSession` counters.

- [ ] **Step 1: Add a failing cancellation-during-backoff test**

```rust
#[tokio::test]
async fn cancellation_interrupts_thirty_second_backoff() {
    let token = CancellationToken::new();
    token.cancel();
    let result = tokio::time::timeout(
        Duration::from_millis(100),
        wait_retry_delay(Duration::from_secs(30), Some(&token)),
    )
    .await
    .expect("cancelled backoff must return immediately");
    assert!(matches!(result, Err(AppError::Cancelled)));
}
```

- [ ] **Step 2: Run and verify RED**

```powershell
cargo test pipeline::ytdlp::tests::cancellation_interrupts_thirty_second_backoff --lib
```

- [ ] **Step 3: Implement cancellation-aware wait**

```rust
fn ensure_not_cancelled(cancel: Option<&CancellationToken>) -> AppResult<()> {
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        Err(AppError::Cancelled)
    } else {
        Ok(())
    }
}

async fn wait_retry_delay(delay: Duration, cancel: Option<&CancellationToken>) -> AppResult<()> {
    match cancel {
        Some(token) => tokio::select! {
            biased;
            _ = token.cancelled() => Err(AppError::Cancelled),
            _ = tokio::time::sleep(delay) => Ok(()),
        },
        None => { tokio::time::sleep(delay).await; Ok(()) }
    }
}
```

- [ ] **Step 4: Refactor the process loop to use the policy**

Keep one clone of `StallWatch` for the runner and one for post-exit phase inspection:

```rust
let stall_watch = StallWatch::with_merge_output(
    progress_count.clone(),
    merge_temp_path(Path::new(&video_path)),
);
let runner_watch = stall_watch.clone();
let result = if let Some(appdata_path) = appdata {
    run_external_with_callback(
        &appdata_path,
        &arg_refs,
        Some(runner_watch),
        true,
        callback,
        cancel,
    ).await
} else {
    run_sidecar_env(
        app,
        "yt-dlp",
        &arg_refs,
        &[],
        Some(runner_watch),
        true,
        callback,
        cancel,
    ).await
};
session.observe_attempt(stall_watch.phase());
```

For each error, build `RetryDecisionInput`, return deterministic errors unchanged, otherwise record the selected lane, apply cleanup, emit a log, await cancellable delay, and continue. `process_attempt` is diagnostic only and never limits eligibility.

Delete `STALL_MAX_RETRIES`, `stall_retries`, the old `attempt < base_attempts` decision, and `is_transient_yt_dlp_error()` after the classifier replaces it.

- [ ] **Step 5: Run all Rust regression tests and commit**

```powershell
cargo fmt -- --check
cargo test pipeline::ytdlp::tests --lib
cargo test pipeline::spawn::tests --lib
cargo test --lib
git add src/pipeline/ytdlp.rs
git diff --cached --check
git commit -m "fix(ytdlp): resume started downloads until cancelled"
```

### Task 4: Expose retry state to foreground and queue UI

**Files:**
- Modify: `client/src-tauri/src/core/progress.rs`
- Modify: `client/src-tauri/src/pipeline/ytdlp.rs`
- Modify: `client/src/components/ImportModal.tsx`
- Modify: `client/src/components/ImportModal.test.tsx`
- Modify: `client/src/store/downloadQueue.ts`
- Modify: `client/src/store/downloadQueue.test.ts`
- Modify: `client/src/components/DownloadQueueWidget.tsx`

**Interfaces:**
- Produces `PipelineEvent::Retrying { video_id, attempt, delay_sec, message }`.
- Adds a TypeScript `Retrying` event with snake_case `video_id` and `delay_sec`.

- [ ] **Step 1: Add failing event/UI tests**

Rust serialization assertion:

```rust
let value = serde_json::to_value(PipelineEvent::Retrying {
    video_id: "v1".into(),
    attempt: 2,
    delay_sec: 5,
    message: "网络波动，正在断点续传（第 2 次，5 秒后重试）".into(),
})?;
assert_eq!(value["stage"], "Retrying");
assert_eq!(value["delay_sec"], 5);
```

Frontend tests must assert that a retry event preserves the prior percent, clears stale speed/ETA, displays the exact message, and retains the cancel button. A later `Downloading` event clears the retry note.

- [ ] **Step 2: Run and verify RED**

```powershell
Set-Location client
pnpm exec vitest run src/components/ImportModal.test.tsx src/store/downloadQueue.test.ts

Set-Location src-tauri
cargo test core::progress --lib
```

- [ ] **Step 3: Add and emit the typed event**

```rust
Retrying {
    video_id: String,
    attempt: u32,
    delay_sec: u64,
    message: String,
},
```

For `NetworkResume` and `StallResume` emit both a Log and Retrying event:

```rust
let message = format!(
    "网络波动，正在断点续传（第 {} 次，{} 秒后重试）",
    retry_number,
    delay.as_secs(),
);
```

Do not emit `Retrying` for pre-start background base retries.

- [ ] **Step 4: Handle the event in both frontends**

In `ImportModal`, retain percent and set `retryMessage`; clear speed/ETA. Clear the message on `Downloading`, `ExtractingAudio`, reset, completion, or failure.

In `downloadQueue.ts`:

```ts
type Retrying = {
  stage: "Retrying";
  video_id: string;
  attempt: number;
  delay_sec: number;
  message: string;
};

case "Retrying":
  store.update(ev.video_id, {
    phase: "downloading",
    note: ev.message,
    speed: null,
    eta: null,
  });
  break;
```

The next `Downloading` update must set `note: null`. `DownloadQueueWidget` displays `item.note` before ordinary phase text.

- [ ] **Step 5: Verify and commit**

```powershell
Set-Location client
pnpm exec vitest run src/components/ImportModal.test.tsx src/store/downloadQueue.test.ts src/components/DownloadQueueWidget.test.tsx
pnpm typecheck

Set-Location src-tauri
cargo test core::progress --lib
cargo test pipeline::ytdlp::tests --lib

Set-Location ../..
git add client/src-tauri/src/core/progress.rs client/src-tauri/src/pipeline/ytdlp.rs client/src/components/ImportModal.tsx client/src/components/ImportModal.test.tsx client/src/store/downloadQueue.ts client/src/store/downloadQueue.test.ts client/src/components/DownloadQueueWidget.tsx
git diff --cached --check
git commit -m "feat(import): show download resume status"
```

### Task 5: Document and run the complete gate

**Files:**
- Modify: `client/CLAUDE.md`

**Interfaces:**
- Documents sticky start state, retry lanes, backoff, cleanup, and cancellation.

- [ ] **Step 1: Update yt-dlp architecture notes**

Document `PipelineEvent::Retrying`, pre-start fast failure, sticky `ever_started`, independent base/network/stall counters, unlimited started-download retries, `3/5/10/20/30…` cancellable backoff, and stage-specific cleanup.

- [ ] **Step 2: Run the complete verification gate**

```powershell
Set-Location client/src-tauri
cargo fmt -- --check
cargo test pipeline::spawn::tests --lib
cargo test pipeline::ytdlp::tests --lib
cargo test --lib
cargo build

Set-Location ..
pnpm test
pnpm typecheck
pnpm build

Set-Location ..
git diff --check
git status --short
```

Expected: all tests/builds pass; `Cargo.toml`, `Cargo.lock`, and `pnpm-lock.yaml` remain unchanged; no CI/release command is invoked.

- [ ] **Step 3: Commit documentation**

```powershell
git add client/CLAUDE.md
git diff --cached --check
git commit -m "docs(ytdlp): document persistent resume"
```
