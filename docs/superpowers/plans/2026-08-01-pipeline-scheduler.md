# Pipeline Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound one whatSub process to three concurrent URL download stages and one concurrent ffmpeg/Whisper compute stage, with foreground-first queued scheduling and cancellable waiting states.

**Architecture:** Add a Tauri-managed Rust `PipelineScheduler` with two independent priority-aware pools. All import and retranscription commands acquire owned stage permits in the backend, while existing pipeline events expose waiting state to foreground and background UIs. The current same-video fence, retry behavior, subprocess cancellation, and LLM-analysis concurrency remain unchanged.

**Tech Stack:** Rust, Tokio `oneshot`, `CancellationToken`, Tauri managed state/events, React 19, TypeScript, Zustand, Vitest.

## Global Constraints

- Download capacity is exactly `3` URL stages.
- Compute capacity is exactly `1` ffmpeg/Whisper stage.
- Foreground waiters are selected before queued background waiters; running work is never preempted.
- FIFO order is preserved within each priority class.
- A job never holds download and compute permits simultaneously.
- Waiting cancellation must launch no child process and leak no capacity.
- No user-facing scheduler setting is added.
- DeepSeek and other LLM-analysis concurrency is not changed.
- Existing same-video registration, retry, resume, and cleanup semantics remain authoritative.
- Preserve unrelated dirty files; stage only files named by each task.

---

## File Structure

- Create `client/src-tauri/src/pipeline/scheduler.rs`: priority pools, owned permits, cancellation-safe admission, and scheduler unit tests.
- Modify `client/src-tauri/src/pipeline/mod.rs`: export the scheduler module.
- Modify `client/src-tauri/src/lib.rs`: register one shared `PipelineScheduler` as Tauri state.
- Modify `client/src-tauri/src/core/progress.rs`: add the stable waiting-stage event contract.
- Modify `client/src-tauri/src/commands/import.rs`: acquire and release download/compute permits at stage boundaries.
- Modify `client/src/store/downloadQueue.ts`: retain queued jobs and map waiting events to queue phases.
- Modify `client/src/store/downloadQueue.test.ts`: reducer regression coverage for both waiting resources.
- Modify `client/src/components/DownloadQueueWidget.tsx`: render the two background waiting labels.
- Modify `client/src/components/ImportModal.tsx`: show waiting labels in foreground imports.
- Modify `client/src/components/ImportModal.test.tsx`: foreground waiting-state coverage.
- Modify `client/src/store/analysis.ts`: represent scheduler waits during player retranscription.
- Modify `client/src/store/analysis.test.ts`: analysis-phase regression coverage.
- Modify `client/src/components/ProgressBanner.tsx`: render player waiting-compute state.
- Modify `client/src/components/ProgressBanner.test.tsx`: foreground retranscription waiting-label coverage.
- Modify `client/src/store/backgroundAnalyses.ts`: mark background retranscription explicitly.
- Modify `client/src/store/backgroundAnalyses.test.ts`: verify the background command argument.
- Modify `client/src/pages/Player.tsx`: mark player retranscription as foreground.
- Modify `client/src/agent/tools/retranscribe_video.ts`: mark AI-tool retranscription as background.
- Modify `client/src/agent/tools/retranscribe_video.test.ts`: verify background priority reaches Rust.
- Modify `client/CLAUDE.md`: document capacities, priority, and backend-only enforcement.

---

### Task 1: Priority-aware scheduler core

**Files:**
- Create: `client/src-tauri/src/pipeline/scheduler.rs`
- Modify: `client/src-tauri/src/pipeline/mod.rs`
- Modify: `client/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `PipelineScheduler::default()` with download capacity 3 and compute capacity 1.
- Produces: `JobPriority::{Foreground, Background}`.
- Produces: `ScheduledResource::{Download, Compute}`.
- Produces: `PipelineScheduler::acquire(resource, priority, cancel, on_wait) -> AppResult<PipelinePermit>`.
- `PipelinePermit` releases its exact pool slot on `Drop`.

- [ ] **Step 1: Write scheduler tests before the implementation**

Add a `#[cfg(test)]` module to the new file with Tokio tests that express the complete contract:

```rust
#[tokio::test]
async fn download_pool_starts_three_and_blocks_the_fourth() {
    let scheduler = PipelineScheduler::default();
    let cancel = CancellationToken::new();
    let p1 = scheduler.acquire(ScheduledResource::Download, JobPriority::Background, &cancel, || {}).await.unwrap();
    let p2 = scheduler.acquire(ScheduledResource::Download, JobPriority::Background, &cancel, || {}).await.unwrap();
    let p3 = scheduler.acquire(ScheduledResource::Download, JobPriority::Background, &cancel, || {}).await.unwrap();

    let fourth = scheduler.acquire(ScheduledResource::Download, JobPriority::Background, &cancel, || {});
    tokio::pin!(fourth);
    assert!(tokio::time::timeout(Duration::from_millis(25), &mut fourth).await.is_err());
    drop(p1);
    let p4 = tokio::time::timeout(Duration::from_millis(250), &mut fourth).await.unwrap().unwrap();
    drop((p2, p3, p4));
}

#[tokio::test]
async fn compute_pool_allows_only_one() {
    let scheduler = PipelineScheduler::default();
    let cancel = CancellationToken::new();
    let first = scheduler.acquire(ScheduledResource::Compute, JobPriority::Background, &cancel, || {}).await.unwrap();
    let second = scheduler.acquire(ScheduledResource::Compute, JobPriority::Background, &cancel, || {});
    tokio::pin!(second);
    assert!(tokio::time::timeout(Duration::from_millis(25), &mut second).await.is_err());
    drop(first);
    assert!(tokio::time::timeout(Duration::from_millis(250), &mut second).await.unwrap().is_ok());
}
```

Also add tests named:

```rust
foreground_waiter_overtakes_queued_background_waiter
fifo_is_preserved_within_one_priority
cancelling_a_waiter_starts_nothing_and_leaks_no_slot
download_and_compute_pools_are_independent
wait_hook_runs_only_when_capacity_is_unavailable
```

The priority test must hold all capacity, enqueue one background waiter, enqueue one foreground waiter, release one permit, and assert the foreground receiver completes first. The cancellation test must cancel a queued token, assert `AppError::Cancelled`, release the held permit, and immediately acquire a fresh permit.

- [ ] **Step 2: Run the scheduler tests and verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml pipeline::scheduler::tests -- --nocapture
```

Expected: compilation fails because `PipelineScheduler`, resources, priorities, and acquisition do not exist.

- [ ] **Step 3: Implement the minimal priority pool**

Create these public types and constants:

```rust
pub const DOWNLOAD_CAPACITY: usize = 3;
pub const COMPUTE_CAPACITY: usize = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JobPriority { Foreground, Background }

impl JobPriority {
    pub fn from_background(background: bool) -> Self {
        if background { Self::Background } else { Self::Foreground }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScheduledResource { Download, Compute }

#[derive(Clone)]
pub struct PipelineScheduler {
    download: Arc<PriorityPool>,
    compute: Arc<PriorityPool>,
}
```

Use a synchronous `Mutex<PoolState>` because all queue mutations are short and
must also work from `PipelinePermit::drop`. `PoolState` contains `available`, a
monotonic waiter ID, and separate `VecDeque<Waiter>` collections for foreground
and background. Each `Waiter` owns a `oneshot::Sender<PipelinePermit>`.

Implement acquisition with this race contract:

```rust
pub async fn acquire<F>(
    &self,
    resource: ScheduledResource,
    priority: JobPriority,
    cancel: &CancellationToken,
    on_wait: F,
) -> AppResult<PipelinePermit>
where
    F: FnOnce(),
```

If capacity is immediately available, decrement it and return a permit without
calling `on_wait`. Otherwise enqueue a waiter, call `on_wait`, and use
`tokio::select!` between its one-shot receiver and `cancel.cancelled()`.

On cancellation, remove the waiter by ID. If dispatch already removed it,
await the receiver, immediately drop the delivered permit, and then return
`AppError::Cancelled`. On release, pop the oldest foreground sender first,
then background. If sending fails because a receiver disappeared, reclaim that
permit and continue dispatching; increment `available` only when no live waiter
accepts the slot.

If the one-shot channel closes without cancellation or a delivered permit,
return `AppError::Other("pipeline scheduler unavailable")`; never fall back to
running unscheduled work.

Export the module:

```rust
// pipeline/mod.rs
pub mod scheduler;
```

Register one process-wide scheduler after `ImportState`:

```rust
.manage(commands::import::ImportState::default())
.manage(pipeline::scheduler::PipelineScheduler::default())
```

- [ ] **Step 4: Run focused scheduler tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml pipeline::scheduler::tests -- --nocapture
cargo build --manifest-path src-tauri/Cargo.toml
```

Expected: every scheduler test passes and the application builds.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src-tauri/src/pipeline/scheduler.rs src-tauri/src/pipeline/mod.rs src-tauri/src/lib.rs
git commit -m "feat(pipeline): add bounded priority scheduler"
```

---

### Task 2: Waiting event contract and UI states

**Files:**
- Modify: `client/src-tauri/src/core/progress.rs`
- Modify: `client/src/store/downloadQueue.ts`
- Modify: `client/src/store/downloadQueue.test.ts`
- Modify: `client/src/components/DownloadQueueWidget.tsx`
- Modify: `client/src/components/ImportModal.tsx`
- Modify: `client/src/components/ImportModal.test.tsx`
- Modify: `client/src/store/analysis.ts`
- Modify: `client/src/store/analysis.test.ts`
- Modify: `client/src/components/ProgressBanner.tsx`
- Modify: `client/src/components/ProgressBanner.test.tsx`
- Modify: `client/src/pages/Player.tsx`

**Interfaces:**
- Consumes: `ScheduledResource::{Download, Compute}` from Task 1.
- Produces: `PipelineEvent::Waiting { video_id, resource }` serialized with resource values `download` and `compute`.
- Produces: queue phases `waiting_download` and `waiting_compute`.
- Produces: matching foreground `AnalysisPhase` values for the player progress banner.

- [ ] **Step 1: Add failing reducer and modal tests**

In `downloadQueue.test.ts`, emit a background `Started`, then each waiting event:

```ts
applyPipelineEvent({ stage: "Started", video_id: "v1", background: true });
applyPipelineEvent({ stage: "Waiting", video_id: "v1", resource: "download" });
expect(useDownloadQueue.getState().entries.v1.phase).toBe("waiting_download");

applyPipelineEvent({ stage: "Waiting", video_id: "v1", resource: "compute" });
expect(useDownloadQueue.getState().entries.v1.phase).toBe("waiting_compute");

applyPipelineEvent({ stage: "Transcribing", video_id: "v1", percent: 4 });
expect(useDownloadQueue.getState().entries.v1.phase).toBe("transcribing");
```

Add `ImportModal` tests that capture the mocked Tauri event listener, submit a
foreground URL, and deliver the events:

```ts
listener({ payload: { stage: "Waiting", video_id: "v1", resource: "download" } });
expect(screen.getByText("等待下载…")).toBeInTheDocument();

listener({ payload: { stage: "Waiting", video_id: "v1", resource: "compute" } });
expect(screen.getByText("等待转录…")).toBeInTheDocument();
```

Add `ProgressBanner` tests with `useAnalysis` set to `waiting_compute` and
`waiting_download` respectively:

```ts
useAnalysis.setState({ videoId: "v1", phase: "waiting_compute", progressPercent: 0 });
render(<ProgressBanner />);
expect(screen.getByText("等待转录…")).toBeInTheDocument();

useAnalysis.setState({ videoId: "v1", phase: "waiting_download", progressPercent: 0 });
render(<ProgressBanner />);
expect(screen.getByText("等待下载…")).toBeInTheDocument();
```

- [ ] **Step 2: Run tests and verify the new expectations fail**

Run:

```powershell
pnpm vitest run src/store/downloadQueue.test.ts src/components/ImportModal.test.tsx src/components/ProgressBanner.test.tsx src/store/analysis.test.ts
```

Expected: failures because `Waiting` and the two queue phases are unknown.

- [ ] **Step 3: Implement the event and render mappings**

In Rust, add a serialized resource enum and event:

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WaitingResource { Download, Compute }

Waiting {
    video_id: String,
    resource: WaitingResource,
},
```

In `downloadQueue.ts`:

```ts
export type QueuePhase =
  | "started"
  | "waiting_download"
  | "waiting_compute"
  | "downloading"
  // existing phases continue unchanged

type Waiting = {
  stage: "Waiting";
  video_id: string;
  resource: "download" | "compute";
};
```

Map the event to the two phases. Update `DownloadQueueWidget`'s existing
`phaseText` path through the queue type so it displays `等待下载…` and
`等待转录…` without showing a percentage spinner as determinate progress.

Extend `ImportModal`'s `Phase` union with `waiting_download` and
`waiting_compute`, handle `Waiting` in its event switch, and map those phases
to the same two labels. Treat both as active work for close/cancel and progress
layout decisions.

Extend `AnalysisPhase` with the same values. Update the Player's existing
`pipeline-event` listener so a matching `Waiting` event sets the corresponding
analysis phase. Map those phases in `ProgressBanner` to the same labels; they
are active indeterminate phases and must not display a fabricated percentage.

- [ ] **Step 4: Run focused frontend and Rust tests**

Run:

```powershell
pnpm vitest run src/store/downloadQueue.test.ts src/components/ImportModal.test.tsx src/components/ProgressBanner.test.tsx src/store/analysis.test.ts
cargo test --manifest-path src-tauri/Cargo.toml core::progress -- --nocapture
pnpm typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 5: Commit Task 2**

```powershell
git add src-tauri/src/core/progress.rs src/store/downloadQueue.ts src/store/downloadQueue.test.ts src/components/DownloadQueueWidget.tsx src/components/ImportModal.tsx src/components/ImportModal.test.tsx src/store/analysis.ts src/store/analysis.test.ts src/components/ProgressBanner.tsx src/components/ProgressBanner.test.tsx src/pages/Player.tsx
git commit -m "feat(import): show scheduler waiting stages"
```

---

### Task 3: Schedule URL and local import stages

**Files:**
- Modify: `client/src-tauri/src/commands/import.rs`
- Modify: `client/src-tauri/src/pipeline/scheduler.rs`

**Interfaces:**
- Consumes: Tauri `State<'_, PipelineScheduler>` and `PipelineScheduler::acquire`.
- Consumes: `PipelineEvent::Waiting` and `WaitingResource` from Task 2.
- Produces: URL stage order `Download permit -> release -> Compute permit`.
- Produces: local stage order `Compute permit only`.

- [ ] **Step 1: Add failing priority and wait-hook integration tests**

Add pure helpers beside `run_import`:

```rust
fn import_priority(background: bool) -> JobPriority {
    JobPriority::from_background(background)
}

fn waiting_resource(resource: ScheduledResource) -> WaitingResource {
    match resource {
        ScheduledResource::Download => WaitingResource::Download,
        ScheduledResource::Compute => WaitingResource::Compute,
    }
}
```

Write tests before defining the helpers:

```rust
#[test]
fn foreground_and_background_imports_map_to_scheduler_priority() {
    assert_eq!(import_priority(false), JobPriority::Foreground);
    assert_eq!(import_priority(true), JobPriority::Background);
}

#[test]
fn scheduler_resources_map_to_stable_waiting_events() {
    assert!(matches!(waiting_resource(ScheduledResource::Download), WaitingResource::Download));
    assert!(matches!(waiting_resource(ScheduledResource::Compute), WaitingResource::Compute));
}
```

Add a scheduler regression test proving a download permit can be dropped before
the same job waits for compute: hold the compute permit, acquire and drop a
download permit, then assert a fourth independent download acquisition remains
immediate while the first job's compute request waits.

- [ ] **Step 2: Run focused Rust tests and verify failure**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands::import::tests pipeline::scheduler::tests -- --nocapture
```

Expected: the new helper and stage-order tests fail to compile before integration.

- [ ] **Step 3: Thread the shared scheduler through `import_video`**

Change the command signature and inner call:

```rust
pub async fn import_video(
    app: AppHandle,
    state: State<'_, ImportState>,
    scheduler: State<'_, PipelineScheduler>,
    req: ImportRequest,
) -> AppResult<ImportResult>
```

Pass `&scheduler` into `run_import`. Build one reusable waiting emitter:

```rust
let wait_event = |resource| {
    emit(app, PipelineEvent::Waiting {
        video_id: video_id.to_string(),
        resource: waiting_resource(resource),
    });
};
```

For URL imports, acquire `ScheduledResource::Download` immediately before
`ytdlp::download`, keep the permit through yt-dlp's thumbnail/merge completion,
then explicitly `drop(download_permit)` before requesting compute.

For local imports, acquire compute before `ensure_web_playable_mp4` and retain
it through thumbnail generation. For URL imports, acquire compute after the
download permit is gone. Retain the compute permit through shared audio
extraction and `whisper::transcribe`, then drop it before emitting
`Transcribed`.

Use `registration.token` for every scheduler wait so an existing cancel request
can abort queued acquisition.

- [ ] **Step 4: Verify imports compile and scheduler tests pass**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands::import::tests pipeline::scheduler::tests -- --nocapture
cargo build --manifest-path src-tauri/Cargo.toml
```

Expected: tests pass; no command argument or borrow-lifetime errors.

- [ ] **Step 5: Commit Task 3**

```powershell
git add src-tauri/src/commands/import.rs src-tauri/src/pipeline/scheduler.rs
git commit -m "feat(import): schedule download and compute stages"
```

---

### Task 4: Schedule every retranscription entry point

**Files:**
- Modify: `client/src-tauri/src/commands/import.rs`
- Modify: `client/src/store/backgroundAnalyses.ts`
- Modify: `client/src/store/backgroundAnalyses.test.ts`
- Modify: `client/src/pages/Player.tsx`
- Modify: `client/src/agent/tools/retranscribe_video.ts`
- Modify: `client/src/agent/tools/retranscribe_video.test.ts`

**Interfaces:**
- Changes Rust command arguments to `{ videoId, whisperModel, background }`.
- Player uses `background: false`.
- Background analysis and AI tool use `background: true`.
- Retranscription consumes only a compute permit.

- [ ] **Step 1: Change tests first to require explicit priority**

Update the agent-tool expectation:

```ts
expect(mockInvoke).toHaveBeenCalledWith("retranscribe_video", {
  videoId: "test-video-2",
  whisperModel: "base",
  background: true,
});
```

In `backgroundAnalyses.test.ts`, add an assertion after starting background
retranscription:

```ts
expect(vi.mocked(invoke)).toHaveBeenCalledWith("retranscribe_video", {
  videoId: "video-1",
  whisperModel: "small",
  background: true,
});
```

- [ ] **Step 2: Run the affected frontend tests and verify failure**

Run:

```powershell
pnpm vitest run src/agent/tools/retranscribe_video.test.ts src/store/backgroundAnalyses.test.ts
```

Expected: argument-shape assertions fail because `background` is absent.

- [ ] **Step 3: Update the command and all callers**

Change the Rust signature:

```rust
pub async fn retranscribe_video(
    app: AppHandle,
    state: State<'_, ImportState>,
    scheduler: State<'_, PipelineScheduler>,
    video_id: String,
    whisper_model: String,
    background: bool,
) -> AppResult<ImportResult>
```

After registering the same-video fence, acquire one compute permit using
`JobPriority::from_background(background)`. Emit `WaitingResource::Compute`
when queued. Hold the permit through `run_retranscribe`, then release it before
returning. Reuse the existing token so queued cancellation works.

Update callers exactly:

```ts
// Player.tsx
background: false

// backgroundAnalyses.ts and agent/tools/retranscribe_video.ts
background: true
```

- [ ] **Step 4: Run affected tests, typecheck, and Rust tests**

Run:

```powershell
pnpm vitest run src/agent/tools/retranscribe_video.test.ts src/store/backgroundAnalyses.test.ts src/components/ProgressBanner.test.tsx
pnpm typecheck
cargo test --manifest-path src-tauri/Cargo.toml commands::import::tests pipeline::scheduler::tests -- --nocapture
```

Expected: every updated argument assertion and scheduler test passes.

- [ ] **Step 5: Commit Task 4**

```powershell
git add src-tauri/src/commands/import.rs src/store/backgroundAnalyses.ts src/store/backgroundAnalyses.test.ts src/pages/Player.tsx src/agent/tools/retranscribe_video.ts src/agent/tools/retranscribe_video.test.ts
git commit -m "feat(transcribe): route retries through compute scheduler"
```

---

### Task 5: Documentation and full regression gate

**Files:**
- Modify: `client/CLAUDE.md`
- Test: all frontend and Rust suites.

**Interfaces:**
- Documents fixed automatic limits and foreground-first behavior.
- Produces no new runtime behavior.

- [ ] **Step 1: Document the operational contract**

Add a concise section to `CLAUDE.md` stating:

```markdown
### Import resource scheduler

- Backend-enforced across every import/retranscribe entry point.
- At most 3 URL yt-dlp stages and 1 ffmpeg/Whisper compute stage run at once.
- Foreground waiters outrank queued background waiters; running jobs are not preempted.
- URL jobs release download capacity before waiting for compute.
- Waiting acquisition is cancellation-aware. Do not bypass the scheduler by spawning sidecars directly from a command.
- Limits are automatic and intentionally have no Settings toggle.
```

- [ ] **Step 2: Run formatting and focused checks**

Run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
pnpm typecheck
```

Expected: both commands exit 0. If formatting fails, run
`cargo fmt --manifest-path src-tauri/Cargo.toml`, inspect the diff, and rerun
the check.

- [ ] **Step 3: Run the complete frontend suite**

Run:

```powershell
pnpm test
```

Expected: all Vitest files and tests pass.

- [ ] **Step 4: Run the complete Rust suite and build**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml
```

Expected: all non-live Rust tests pass; the intentionally ignored online TTS
test remains ignored; build exits 0.

- [ ] **Step 5: Review scheduler invariants in the final diff**

Confirm from the diff:

```text
download capacity == 3
compute capacity == 1
foreground queue checked before background queue
no URL code path holds download while awaiting compute
all retranscribe_video callers pass background explicitly
queued cancellation races the existing CancellationToken
no Settings field or UI control was added
```

- [ ] **Step 6: Commit Task 5**

```powershell
git add CLAUDE.md
git commit -m "docs(pipeline): document import scheduler limits"
```

- [ ] **Step 7: Request final code review**

Review the complete branch against
`docs/superpowers/specs/2026-08-01-pipeline-scheduler-design.md`, resolve only
findings within scheduler scope, rerun the affected focused tests, and then use
`superpowers:verification-before-completion` before reporting completion.
