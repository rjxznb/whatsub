# Analysis Session Lease Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the durable generation sidecar state machine with producer-bound runtime leases, exact checkpoint continuation, and cancellation that does not return before old-job cleanup finishes.

**Architecture:** Rust owns a process-local lease coordinator and one atomically replaced `analysis.json`; TypeScript opens a lease once per producer and never rediscovers identity during save. Checkpoint revision/fingerprint validation protects batch ordering, while the import registry uses job identities plus completion notification to serialize same-video cancellation and replacement.

**Tech Stack:** TypeScript 5.8, React 19, Zustand 5, Vitest 4, Tauri 2, Rust 2021, Tokio, serde_json.

## Global Constraints

- One DeepSeek input batch is transactional; a failed or killed batch publishes zero output.
- A hard process kill loses at most the current uncommitted DeepSeek batch.
- Completed batches resume by `nextCueOffset`, never by `subtitles.length`.
- A valid existing transcript must not cause Whisper to run again during continuation.
- Lease tokens are process-local and are captured at producer start.
- Delete, reset, cancellation cleanup, and replacement import revoke prior leases in Rust.
- `cancel_import` returns success only after the known job exits and cleanup finishes.
- Persisted analysis is strictly validated before continuation.
- Existing legacy `analysis.json` files remain readable and migrate once.
- The steady-state save path must not write `analysis.generation.json`, `.bak`, or a pending-write journal.
- Do not trigger release or CI.

---

## File structure

- `client/src-tauri/src/commands/analysis_store.rs`: lease coordinator, checkpoint metadata validation, atomic JSON replacement, and one-time legacy sidecar recovery.
- `client/src-tauri/src/commands/analysis.rs`: transcript/ffmpeg commands plus thin Tauri analysis-session commands that delegate to `analysis_store`.
- `client/src-tauri/src/commands/import.rs`: uniquely identified import registrations and completion-aware cancellation.
- `client/src/llm/analysisCheckpoint.ts`: strict persisted-analysis validation and transcript preparation.
- `client/src/llm/analysisSession.ts`: immutable frontend lease handle and persisted `runAnalysis()` orchestration.
- `client/src/pages/Player.tsx`: foreground ownership and continuation UI.
- `client/src/store/backgroundAnalyses.ts`: background ownership, handoff, and continuation.
- Existing delete/import/materialization callers: use backend-confirmed lease revocation and cleanup.

---

### Task 1: Strengthen persisted-analysis validation

**Files:**
- Modify: `client/src/llm/analysisCheckpoint.ts`
- Modify: `client/src/llm/analysisCheckpoint.test.ts`
- Modify: `client/src/llm/types.ts`

**Interfaces:**
- Produces: `parsePersistedAnalysis(value: unknown): AnalysisResult | null`.
- Preserves: `prepareAnalysis(cues, cached)` and legacy checkpoint migration.

- [ ] **Step 1: Add failing semantic-validation tests**

Add table tests proving that matching metadata is insufficient when a subtitle,
phrase, checkpoint phase, offset, or revision is malformed:

```ts
expect(parsePersistedAnalysis({
  subtitles: [{ index: 1, startTime: "bad" }],
  keyPhrases: [],
  checkpoint: validCheckpoint,
})).toBeNull();

expect(parsePersistedAnalysis({
  subtitles: validSubtitles,
  keyPhrases: [{ phrase: 42 }],
  checkpoint: validCheckpoint,
})).toBeNull();
```

Also assert a valid legacy value is accepted and a checkpointed value with an
unknown extra key remains forward-compatible.

- [ ] **Step 2: Verify RED**

Run:

```powershell
Set-Location client
pnpm exec vitest run src/llm/analysisCheckpoint.test.ts
```

Expected: FAIL because `parsePersistedAnalysis` is not exported and malformed
domain objects are not rejected by a public parser.

- [ ] **Step 3: Implement the strict parser**

Validate every field consumed by the player/session. Keep unknown object keys,
but reject wrong required-field types. `prepareAnalysis()` must call the parser
before fingerprint/offset decisions:

```ts
export function parsePersistedAnalysis(value: unknown): AnalysisResult | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.subtitles) || !value.subtitles.every(isSubtitle)) return null;
  if (!Array.isArray(value.keyPhrases) || !value.keyPhrases.every(isKeyPhrase)) return null;
  if (hasOwn(value, "checkpoint") && !isCheckpointShape(value.checkpoint)) return null;
  return value as unknown as AnalysisResult;
}
```

Keep cue-count-dependent checks inside `prepareAnalysis()` because only it owns
the current transcript.

- [ ] **Step 4: Verify GREEN and typecheck**

```powershell
pnpm exec vitest run src/llm/analysisCheckpoint.test.ts
pnpm typecheck
```

- [ ] **Step 5: Commit**

```powershell
git add client/src/llm/analysisCheckpoint.ts client/src/llm/analysisCheckpoint.test.ts client/src/llm/types.ts
git diff --cached --check
git commit -m "fix(analysis): validate persisted checkpoint semantics"
```

### Task 2: Add the Rust lease-backed atomic analysis store

**Files:**
- Create: `client/src-tauri/src/commands/analysis_store.rs`
- Modify: `client/src-tauri/src/commands/mod.rs`
- Modify: `client/src-tauri/src/commands/analysis.rs`
- Modify: `client/src-tauri/src/lib.rs`
- Test: unit tests inside `analysis_store.rs`

**Interfaces:**
- Produces Tauri commands:
  - `begin_analysis_session(video_id: String, reset: bool) -> AnalysisSessionStart`
  - `save_analysis_session(video_id: String, lease: String, analysis: Value) -> SaveAnalysisOutcome`
  - `end_analysis_session(video_id: String, lease: String) -> AppResult<()>`
- Produces internal helpers:
  - `revoke_analysis_sessions(video_id: &str)`
  - `replace_analysis_snapshot(video_id: &str, analysis: Value)`
  - `remove_analysis_snapshot(video_id: &str)`

- [ ] **Step 1: Write failing lease and atomicity tests**

Use a test-local store/path and cover:

```rust
let old = store.begin("v1", &path, false)?;
store.revoke("v1");
let fresh = store.begin("v1", &path, true)?;

assert_eq!(store.save("v1", &old.lease, checkpointed(1))?.status,
           SaveAnalysisStatus::Rejected);
assert_eq!(store.save("v1", &fresh.lease, checkpointed(1))?.status,
           SaveAnalysisStatus::Applied);
```

Add tests for: first-ever save; higher revision; equal identical idempotence;
equal different rejection; lower revision rejection; fingerprint mutation
rejection; reset accepting revision zero; replacement failure preserving the
old file; a second non-reset begin being rejected while a lease is active; an
explicit reset begin revoking that lease; and lease state disappearing
naturally in a new store instance while the valid file remains resumable.

- [ ] **Step 2: Verify RED**

```powershell
Set-Location client/src-tauri
cargo test commands::analysis_store::tests --lib
```

Expected: FAIL because `analysis_store` and the lease API do not exist.

- [ ] **Step 3: Implement the coordinator and file contract**

Use a monotonically increasing process-local token and a mutex-protected active
lease map:

```rust
#[derive(Default)]
struct LeaseCoordinator {
    next_lease: u64,
    active: HashMap<String, String>,
}

impl LeaseCoordinator {
    fn issue(&mut self, video_id: &str) -> String {
        self.next_lease = self.next_lease.checked_add(1).expect("lease counter exhausted");
        let lease = format!("analysis-lease-{}", self.next_lease);
        self.active.insert(video_id.to_owned(), lease.clone());
        lease
    }
}
```

The save path must validate `checkpoint.version`, fingerprint, revision, and
same-fingerprint monotonicity before using the existing temp-file + flush +
atomic replacement primitive. Do not write a steady-state sidecar.

`begin(reset: false)` rejects when another lease for the video is active;
callers must transfer the existing lease or close it. `begin(reset: true)` is
the only begin mode allowed to revoke an active lease and start revision zero.

- [ ] **Step 4: Isolate one-time old-artifact migration**

On begin/load only, inspect the visible JSON first. If it is valid, retain it
and remove obsolete generation/tmp/backup artifacts. If visible JSON is absent
or malformed, recover exactly one valid unambiguous temp/backup candidate.
Contradictory candidates return an error rather than guessing. The normal save
function must not call the migration routine.

- [ ] **Step 5: Register commands and verify GREEN**

```powershell
rustfmt --edition 2021 --check src/commands/analysis_store.rs src/commands/analysis.rs src/commands/mod.rs src/lib.rs
cargo test commands::analysis_store::tests --lib
cargo build
```

- [ ] **Step 6: Commit**

```powershell
git add client/src-tauri/src/commands/analysis_store.rs client/src-tauri/src/commands/analysis.rs client/src-tauri/src/commands/mod.rs client/src-tauri/src/lib.rs
git diff --cached --check
git commit -m "feat(analysis): persist through runtime session leases"
```

### Task 3: Make import cancellation completion-aware

**Files:**
- Modify: `client/src-tauri/src/commands/import.rs`
- Test: unit tests inside `client/src-tauri/src/commands/import.rs`

**Interfaces:**
- Produces: uniquely identified `ActiveImport` records.
- Changes: `cancel_import` waits for the exact job's completion notification.
- Consumes: `analysis_store::revoke_analysis_sessions(video_id)` during cleanup.

- [ ] **Step 1: Add failing registry race tests**

Test these event sequences without launching sidecars:

```rust
let first = state.register("v1")?;
assert!(state.register("v1").is_err());
let waiter = state.cancel_and_waiter("v1").unwrap();
assert!(!waiter.is_complete());
state.finish("v1", first.job_id);
waiter.wait().await;
```

Also prove `finish(v1, old_job_id)` cannot remove a newer entry, cancellation
does not report complete before cleanup, and cancelling an absent job succeeds.

- [ ] **Step 2: Verify RED**

```powershell
cargo test commands::import::tests --lib
```

Expected: FAIL because registrations have no job identity/completion handle and
same-video registration silently replaces the active token.

- [ ] **Step 3: Implement job identity and completion**

Store this shape under the existing mutex:

```rust
struct ActiveImport {
    job_id: u64,
    token: CancellationToken,
    done: tokio::sync::watch::Receiver<bool>,
}
```

The outer `import_video` owns the matching sender. It performs cancellation
cleanup, revokes analysis leases, conditionally unregisters by `job_id`, then
sends completion. `cancel_import` clones the exact receiver, cancels the token,
and awaits completion. A bounded timeout returns an error and must not claim
cleanup succeeded.

- [ ] **Step 4: Verify GREEN and cancellation integration**

```powershell
rustfmt --edition 2021 --check src/commands/import.rs
cargo test commands::import::tests --lib
cargo test commands::analysis_store::tests --lib
cargo build
```

- [ ] **Step 5: Commit**

```powershell
git add client/src-tauri/src/commands/import.rs
git diff --cached --check
git commit -m "fix(import): await cancelled job cleanup"
```

### Task 4: Create one immutable frontend analysis session

**Files:**
- Create: `client/src/llm/analysisSession.ts`
- Create: `client/src/llm/analysisSession.test.ts`
- Modify: `client/src/llm/analysisPersistence.ts`

**Interfaces:**
- Produces:

```ts
export interface PersistedAnalysisSession {
  readonly videoId: string;
  readonly lease: string;
  readonly analysis: CheckpointedAnalysis;
  save(next: CheckpointedAnalysis): Promise<CheckpointedAnalysis>;
  close(): Promise<void>;
}

export async function openAnalysisSession(
  videoId: string,
  cues: readonly SrtCue[],
): Promise<PersistedAnalysisSession>;

export async function resetAnalysisSession(
  videoId: string,
  cues: readonly SrtCue[],
): Promise<PersistedAnalysisSession>;
```

- [ ] **Step 1: Add failing producer-binding tests**

Assert that the lease returned by begin is present in every save and never
reloaded/rebound after rejection:

```ts
const session = await openAnalysisSession("v1", cues);
await session.save(next);
expect(invoke).toHaveBeenCalledWith("save_analysis_session", {
  videoId: "v1",
  lease: "lease-old",
  analysis: next,
});
```

Then revoke/replace the backend outcome and prove a subsequent old-session save
throws `StaleAnalysisSessionError` without calling begin again. Add migration,
fingerprint mismatch reset, failed-save-no-publish, and close-idempotence cases.

- [ ] **Step 2: Verify RED**

```powershell
Set-Location client
pnpm exec vitest run src/llm/analysisSession.test.ts
```

- [ ] **Step 3: Implement immutable lease ownership**

The session captures `lease` in its closure. `save()` first validates the next
analysis, invokes Rust, throws on rejected status, and updates its private
current state only after confirmation. It must never fetch a replacement lease
inside `save()`.

For legacy migration, persist the prepared revision before returning. For a
fingerprint mismatch, close the continuation lease, call begin with
`reset: true`, persist the revision-zero analysis, and return only the reset
session.

- [ ] **Step 4: Add shared transactional execution**

Expose:

```ts
export async function executeAnalysisSession(options: {
  session: PersistedAnalysisSession;
  provider: Provider;
  cues: readonly SrtCue[];
  style: TranslationStyle;
  signal?: AbortSignal;
  onCommitted?: (analysis: CheckpointedAnalysis, commit: AnalysisCommit) => void;
  onRetry?: (event: AnalysisRetryEvent) => void;
}): Promise<CheckpointedAnalysis>;
```

Apply each `runAnalysis()` commit to a candidate snapshot, await
`session.save(candidate)`, and only then call `onCommitted`.

- [ ] **Step 5: Verify GREEN and commit**

```powershell
pnpm exec vitest run src/llm/analysisSession.test.ts src/llm/analysisCheckpoint.test.ts src/llm/analyze.test.ts
pnpm typecheck
git add client/src/llm/analysisSession.ts client/src/llm/analysisSession.test.ts client/src/llm/analysisPersistence.ts
git diff --cached --check
git commit -m "feat(analysis): bind producers to persisted sessions"
```

### Task 5: Move the foreground player to exact continuation

**Files:**
- Modify: `client/src/store/analysis.ts`
- Modify: `client/src/pages/Player.tsx`
- Create: `client/src/pages/Player.analysisResume.test.tsx`
- Modify: `client/src/components/ProgressBanner.tsx`
- Create: `client/src/components/ProgressBanner.test.tsx`

**Interfaces:**
- Consumes: `openAnalysisSession()`, `resetAnalysisSession()`, and `executeAnalysisSession()`.
- Produces: foreground `errorStage`, `retryMessage`, and lease-preserving continue action.

- [ ] **Step 1: Add failing resume UI tests**

Use a fixture with 47 output subtitles but `nextCueOffset: 50`. Assert the
submitted inputs begin at cue 50, and continuation never invokes
`retranscribe_video`, `delete_analysis`, or a reset session. Add summary-only,
save-failure, transient-retry-message, and explicit-retranscription tests.

- [ ] **Step 2: Verify RED**

```powershell
pnpm exec vitest run src/pages/Player.analysisResume.test.tsx src/components/ProgressBanner.test.tsx
```

- [ ] **Step 3: Replace timer saves and output-count resume**

Remove `startAnalysisFrom(subtitles.length)`, cue-level 800 ms save timers, and
implicit deletion from continue. Keep one session ref for the producer, derive
progress from `checkpoint.nextCueOffset / cues.length`, and update Zustand only
from `onCommitted`.

Analysis errors show `继续解析`; transcription failures alone show
`重新转录`. Closing or unmounting aborts the current batch and closes the lease
unless ownership is transferred to background.

- [ ] **Step 4: Verify GREEN and commit**

```powershell
pnpm exec vitest run src/pages/Player.analysisResume.test.tsx src/components/ProgressBanner.test.tsx src/llm/analysisSession.test.ts
pnpm typecheck
git add client/src/store/analysis.ts client/src/pages/Player.tsx client/src/pages/Player.analysisResume.test.tsx client/src/components/ProgressBanner.tsx client/src/components/ProgressBanner.test.tsx
git diff --cached --check
git commit -m "feat(player): continue analysis from committed offsets"
```

### Task 6: Move background analysis and handoff to the same lease

**Files:**
- Modify: `client/src/store/backgroundAnalyses.ts`
- Create: `client/src/store/backgroundAnalyses.test.ts`
- Modify: `client/src/components/DownloadQueueWidget.tsx`
- Modify: `client/src/components/DownloadQueueWidget.test.tsx`

**Interfaces:**
- Consumes: the same `PersistedAnalysisSession` instance during foreground to
  background ownership transfer.
- Produces: `resumeBackgroundAnalysis(videoId)` and committed-offset progress.

- [ ] **Step 1: Add failing background race tests**

Cover offset 50 with 47 outputs, summary-only resume, cancellation during a
batch publishing nothing, save before store publication, retry copy, stale lease
rejection, and foreground/background handoff retaining exactly one lease.

- [ ] **Step 2: Verify RED**

```powershell
pnpm exec vitest run src/store/backgroundAnalyses.test.ts src/components/DownloadQueueWidget.test.tsx
```

- [ ] **Step 3: Implement single-owner handoff**

Store the session handle in the background job. Foreground transfer aborts only
the foreground request, hands the same session to the background runner, and
does not close/reopen it. Taking over performs the reverse. Progress and UI
snapshots update only after confirmed session saves.

- [ ] **Step 4: Verify GREEN and commit**

```powershell
pnpm exec vitest run src/store/backgroundAnalyses.test.ts src/components/DownloadQueueWidget.test.tsx src/pages/Player.analysisResume.test.tsx
pnpm typecheck
git add client/src/store/backgroundAnalyses.ts client/src/store/backgroundAnalyses.test.ts client/src/components/DownloadQueueWidget.tsx client/src/components/DownloadQueueWidget.test.tsx
git diff --cached --check
git commit -m "feat(analysis): preserve leases across background handoff"
```

### Task 7: Enforce backend-confirmed destructive boundaries and remove the old state machine

**Files:**
- Modify: `client/src-tauri/src/commands/library.rs`
- Modify: `client/src-tauri/src/commands/library_sync.rs`
- Modify: `client/src-tauri/src/commands/analysis.rs`
- Modify: `client/src-tauri/src/commands/analysis_store.rs`
- Modify: `client/src/llm/analysisPersistence.ts`
- Modify: `client/src/components/ImportModal.tsx`
- Modify: `client/src/store/downloadQueue.ts`
- Modify: `client/src/store/library.ts`
- Modify: `client/src/store/materializing.ts`
- Modify: `client/src/agent/tools/delete_video.ts`

**Interfaces:**
- Consumes: Rust `revoke_analysis_sessions`, `replace_analysis_snapshot`, and
  completion-aware `cancel_import`.
- Removes: generation/expectedGeneration compatibility saves and frontend
  lifecycle caches.

- [ ] **Step 1: Add failing delete/reimport integration tests**

Prove that Rust revokes before directory removal even when later index cleanup
fails; a stale lease cannot save after failed delete; cancellation cleanup is
complete before a new import registration; cloud materialization explicitly
replaces the snapshot; and every frontend deletion path awaits its backend
command before refreshing UI caches.

- [ ] **Step 2: Verify RED**

```powershell
Set-Location client
pnpm exec vitest run src/store/downloadQueue.test.ts src/llm/analysisSession.test.ts
Set-Location src-tauri
cargo test commands::analysis_store::tests --lib
cargo test commands::import::tests --lib
```

- [ ] **Step 3: Wire destructive Rust operations**

Call `revoke_analysis_sessions(&id)` before `library_delete` removes files.
`delete_analysis` revokes then removes the snapshot. Cancellation cleanup
revokes before removing the work directory. Cloud materialization calls
`replace_analysis_snapshot` rather than the session save command.

- [ ] **Step 4: Remove old generation machinery**

Delete `AnalysisGenerationState`, `PendingAnalysisWrite`, content-hash sidecar
reconciliation, expected-generation CAS, frontend `states/saveTails/
lifecycleVersions`, and their compatibility tests. Keep only the isolated
one-time artifact migration tests and the lease/revision tests.

- [ ] **Step 5: Verify GREEN and commit**

```powershell
Set-Location client
pnpm exec vitest run src/llm/analysisSession.test.ts src/store/downloadQueue.test.ts src/store/backgroundAnalyses.test.ts src/pages/Player.analysisResume.test.tsx
pnpm typecheck
Set-Location src-tauri
rustfmt --edition 2021 --check src/commands/analysis.rs src/commands/analysis_store.rs src/commands/import.rs src/commands/library.rs src/commands/library_sync.rs
cargo test commands::analysis_store::tests --lib
cargo test commands::import::tests --lib
cargo build
Set-Location ../..
git add client/src-tauri/src/commands/analysis.rs client/src-tauri/src/commands/analysis_store.rs client/src-tauri/src/commands/import.rs client/src-tauri/src/commands/library.rs client/src-tauri/src/commands/library_sync.rs client/src/llm/analysisPersistence.ts client/src/components/ImportModal.tsx client/src/store/downloadQueue.ts client/src/store/library.ts client/src/store/materializing.ts client/src/agent/tools/delete_video.ts
git diff --cached --check
git commit -m "refactor(analysis): remove generation sidecar state"
```

### Task 8: Documentation and complete regression gate

**Files:**
- Modify: `client/CLAUDE.md`
- Modify: `client/CLAUDE-FEATURES.md`

**Interfaces:**
- Documents: lease ownership, checkpoint restart behavior, cancellation
  completion, legacy migration, and the remote-queue limitation.

- [ ] **Step 1: Update architecture documentation**

Document these exact operational rules:

- A killed process repeats at most the current uncommitted DeepSeek batch.
- Existing valid transcript skips Whisper during continuation.
- Foreground/background transfer one lease instead of opening a replacement.
- Delete/reset/cancel revoke leases in Rust before filesystem cleanup.
- `cancel_import` success means cleanup finished.
- Remote import queue restart persistence is still outside the desktop-only
  contract.

- [ ] **Step 2: Run focused acceptance tests**

```powershell
Set-Location client
pnpm exec vitest run src/llm/analysisCheckpoint.test.ts src/llm/analysisSession.test.ts src/llm/analyze.test.ts src/pages/Player.analysisResume.test.tsx src/store/backgroundAnalyses.test.ts src/store/downloadQueue.test.ts src/components/ProgressBanner.test.tsx src/components/DownloadQueueWidget.test.tsx
```

- [ ] **Step 3: Run complete frontend and Rust gates**

```powershell
pnpm typecheck
pnpm test
pnpm build
Set-Location src-tauri
cargo test --lib
cargo build
Set-Location ../..
git diff --check
git status --short
```

If Cargo updates only the package version in `Cargo.lock`, restore that generated
drift before the final status check. Do not reformat unrelated pre-existing Rust
files.

- [ ] **Step 4: Run Tauri startup smoke without external actions**

Start `pnpm tauri dev`, confirm Vite is ready and the worktree executable opens,
then stop only the smoke-run processes. Do not submit OTPs, send emails, import
real videos, push, release, or run CI.

- [ ] **Step 5: Commit documentation**

```powershell
git add client/CLAUDE.md client/CLAUDE-FEATURES.md
git diff --cached --check
git commit -m "docs(analysis): document lease-based recovery"
```

- [ ] **Step 6: Independent whole-branch review**

Review from the branch fork point through `HEAD`, including the earlier pricing,
cookie-login, download-resume, yt-dlp watchdog, DeepSeek retry, checkpoint, and
lease commits. Reject any hidden release/CI change or any continuation path that
calls Whisper implicitly.
