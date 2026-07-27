# yt-dlp Stage-Aware Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent valid long ffmpeg merges from being killed as stalled, retain detection of genuinely frozen downloads/merges, and guarantee MP4-compatible separate audio selection.

**Architecture:** Extend the shared spawn watchdog input from a bare progress counter to a cloneable `StallWatch` that produces phase-aware activity snapshots. yt-dlp marks the transition to merging from its machine-stable stdout merger log and supplies the actual `source.temp.mp4` ffmpeg output as the merge liveness probe; Whisper receives a progress-only watch so its behavior is unchanged. Keep retry cleanup and format selection in yt-dlp as small testable helpers.

**Tech Stack:** Rust, Tokio, Tauri shell sidecars, yt-dlp, ffmpeg, built-in Rust unit tests.

## Global Constraints

- Preserve the existing 15-second sampling interval and 8 stale samples (approximately 120 seconds).
- Preserve the current five stall retries and all network retry/error-classification behavior.
- Do not add settings or user-visible controls.
- Do not change ordinary ffmpeg or Whisper watchdog semantics.
- Do not trigger CI or publish a release during implementation.
- Do not touch user-owned untracked `.agents/skills/` or `AGENTS.md`.

---

### Task 1: Phase-aware watchdog state machine

**Files:**
- Modify: `client/src-tauri/src/pipeline/spawn.rs`
- Modify: `client/src-tauri/src/pipeline/whisper.rs`
- Test: inline `#[cfg(test)]` module in `client/src-tauri/src/pipeline/spawn.rs`

**Interfaces:**
- Consumes: existing `StallCounter = Arc<AtomicU64>` used by Whisper and yt-dlp callbacks.
- Produces: `StallWatch::progress_only(counter)`, `StallWatch::with_merge_output(counter, path)`, `StallWatch::mark_merging()`, and internal `StallTracker::observe(snapshot) -> bool`.

- [ ] **Step 1: Add failing pure state-machine tests**

Add tests that construct `StallTracker` and feed explicit `StallSnapshot` values:

```rust
#[test]
fn preparing_never_stalls() { /* eight zero progress observations stay false */ }

#[test]
fn downloading_stalls_after_eight_unchanged_samples() { /* progress=1 then 8 unchanged */ }

#[test]
fn merge_growth_resets_stale_samples() { /* merge sizes 10,10,20 then fewer than 8 static */ }

#[test]
fn merge_stalls_after_eight_unchanged_sizes() { /* merge size stays constant */ }

#[test]
fn phase_change_resets_the_baseline() { /* stale download samples do not carry into merge */ }
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cargo test pipeline::spawn::tests --lib`

Expected: compilation failure because `StallTracker`, `StallSnapshot`, and phase-aware observation do not exist.

- [ ] **Step 3: Implement the minimal state machine and `StallWatch`**

Use a cloneable shared inner object:

```rust
#[derive(Clone)]
pub struct StallWatch {
    counter: StallCounter,
    merge_output: Option<Arc<PathBuf>>,
    merging: Arc<AtomicBool>,
}

impl StallWatch {
    pub fn progress_only(counter: StallCounter) -> Self;
    pub fn with_merge_output(counter: StallCounter, path: PathBuf) -> Self;
    pub fn mark_merging(&self);
    fn snapshot(&self) -> StallSnapshot;
}
```

`snapshot()` returns progress activity while not merging and `fs::metadata(path).len()` while merging. `StallTracker::observe` arms only after nonzero download progress, arms immediately on the merge phase, resets on phase changes/activity growth, and returns `true` on the eighth unchanged armed sample.

Change both spawn runners from `Option<StallCounter>` to `Option<StallWatch>` and replace duplicated local `last_count`/`stale_ticks` logic with `StallTracker`.

Wrap Whisper's existing counter with `StallWatch::progress_only(progress_count.clone())` at its single `run_sidecar_env` call.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `cargo test pipeline::spawn::tests --lib`

Expected: all new state-machine tests pass.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- client/src-tauri/src/pipeline/spawn.rs client/src-tauri/src/pipeline/whisper.rs
git commit -m "fix(spawn): make stall watchdog phase-aware"
```

### Task 2: Wire yt-dlp merge liveness and retry cleanup

**Files:**
- Modify: `client/src-tauri/src/pipeline/ytdlp.rs`
- Test: inline existing `tests` module in `client/src-tauri/src/pipeline/ytdlp.rs`

**Interfaces:**
- Consumes: `StallWatch::with_merge_output` and `StallWatch::mark_merging` from Task 1.
- Produces: private `is_merge_start_line(line: &str) -> bool` and `prepare_stall_retry(message: &str, retries: u32, max_retries: u32, output: &Path) -> bool`.

- [ ] **Step 1: Add failing merger-detection and cleanup tests**

```rust
#[test]
fn detects_yt_dlp_merger_start() {
    assert!(is_merge_start_line("[Merger] Merging formats into \"source.mp4\""));
    assert!(!is_merge_start_line("[download] 100% of 42MiB"));
}

#[test]
fn stall_retry_removes_only_final_output() {
    // Create source.mp4, source.temp.mp4, and source.f137.mp4.part.
    // Assert helper removes both merge outputs and preserves the part.
}

#[test]
fn non_stall_does_not_remove_output() {
    // Assert helper returns false and source.mp4 still exists.
}
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cargo test pipeline::ytdlp::tests --lib`

Expected: compilation failure because the two helpers do not exist.

- [ ] **Step 3: Implement helpers and connect `StallWatch`**

Create one `StallWatch::with_merge_output(progress_count.clone(), PathBuf::from(&video_path))` per process attempt. Clone it into the output callback. For every output line, call `mark_merging()` when `is_merge_start_line` matches. Pass the original watch into both `run_external_with_callback` and `run_sidecar_env`.

Replace the inline stall retry condition/deletion with `prepare_stall_retry`. The helper returns true only when the error contains `stalled` and the retry budget remains; it best-effort removes only the supplied final output path.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `cargo test pipeline::ytdlp::tests --lib`

Expected: merger detection, cleanup, and existing progress parser tests all pass.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- client/src-tauri/src/pipeline/ytdlp.rs
git commit -m "fix(ytdlp): monitor merge output growth"
```

### Task 3: Harden format selection and run full verification

**Files:**
- Modify: `client/src-tauri/src/pipeline/ytdlp.rs`
- Test: inline existing `tests` module in `client/src-tauri/src/pipeline/ytdlp.rs`
- Generated consistency fix if Cargo rewrites it: `client/src-tauri/Cargo.lock`

**Interfaces:**
- Consumes: existing private `yt_dlp_format(quality: &str) -> &'static str`.
- Produces: format strings whose separate audio terms contain `ext=m4a` or `acodec^=mp4a` only.

- [ ] **Step 1: Add failing format-contract tests**

```rust
#[test]
fn all_quality_formats_require_mp4_compatible_separate_audio() {
    for quality in ["low", "standard", "high", "best"] {
        let format = yt_dlp_format(quality);
        assert!(!format.contains("ext!=webm"));
        for term in format.split('/') {
            if term.contains("+ba") {
                assert!(term.contains("ba[ext=m4a]") || term.contains("ba[acodec^=mp4a]"));
            }
        }
    }
}
```

- [ ] **Step 2: Run test and verify RED**

Run: `cargo test all_quality_formats_require_mp4_compatible_separate_audio --lib`

Expected: failure because the current third tier contains `ba[ext!=webm]`.

- [ ] **Step 3: Make the minimal format change**

Replace every third-tier `ba[ext!=webm]` with `ba[acodec^=mp4a]`. Update the adjacent comment to explain direct codec compatibility rather than container exclusion. Preserve heights, tier order, and pre-merged fallbacks.

- [ ] **Step 4: Run targeted and full verification**

Run, in order:

```powershell
cargo test pipeline::spawn::tests --lib
cargo test pipeline::ytdlp::tests --lib
cargo test --lib
cargo build
git diff --check
git status --short
```

Expected: all tests and build exit 0; diff check has no errors; only task files plus the pre-existing user-owned untracked paths appear.

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- client/src-tauri/src/pipeline/ytdlp.rs client/src-tauri/Cargo.lock
git commit -m "test(ytdlp): lock compatible audio and stall recovery"
```
