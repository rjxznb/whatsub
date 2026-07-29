# DeepSeek Analysis Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retry transient DeepSeek failures inside the current input batch and resume durable analysis from an exact transcript offset without re-running Whisper.

**Architecture:** Make one input batch the transaction boundary: buffer its streamed output, retry transient failures against the same input range, and publish only after a successful stream and durable checkpoint save. TypeScript owns provider classification, retry, checkpoint migration, and orchestration; Rust serializes revision-aware atomic `analysis.json` writes.

**Tech Stack:** TypeScript 5.8, React 19, Zustand 5, Vitest 4, Tauri 2, Rust 2021, Tokio.

## Global Constraints

- One initial DeepSeek request may be followed by at most 3 retries: 4 total attempts.
- Retry delays are 500ms, 1500ms, and 3500ms; a valid `Retry-After` may increase them.
- Retry transport/send/read failures and HTTP 408, 429, 500, 502, 503, 504 only.
- Never retry abort, HTTP 400/401/403, license/quota errors, or protocol/schema errors.
- A failed batch must publish zero output and must not advance `nextCueOffset`.
- Completed batches are never re-sent; resume uses input offset, never `subtitles.length`.
- Only an explicit destructive action may call `retranscribe_video` and `delete_analysis`.
- Existing `analysis.json` files without checkpoints must remain readable.
- The current repository cannot make the remote import queue restart-safe because its backend contract has no `videoId`, phase, or checkpoint fields. This plan fixes foreground and local background analysis; backend queue persistence requires a separate backend plan.
- Do not trigger release or CI. Run `pnpm install --frozen-lockfile` before frontend tests in this worktree.

---

### Task 1: Add versioned checkpoints and legacy migration

**Files:**
- Modify: `client/src/llm/types.ts`
- Create: `client/src/llm/analysisCheckpoint.ts`
- Create: `client/src/llm/analysisCheckpoint.test.ts`

**Interfaces:**
- Produces: `AnalysisCheckpoint`, `CheckpointedAnalysis`, `fingerprintTranscript()`, `prepareAnalysis()`.

- [ ] **Step 1: Write failing checkpoint tests**

Create tests for stable fingerprints, matching resume, mismatch reset, legacy migration, and invalid offsets. Use this contract:

```ts
const prepared = await prepareAnalysis(cues, cached);
expect(prepared.analysis.checkpoint).toEqual({
  version: 1,
  transcriptFingerprint: expect.stringMatching(/^sha256:/),
  nextCueOffset: expectedOffset,
  phase: expectedPhase,
  revision: expectedRevision,
});
```

Include a legacy case where two cached subtitles over three cues yields `reason: "legacy-migration"`, retains those two subtitles, and uses offset `2` once. Include a fingerprint mismatch case that resets subtitles, phrases, and offset to zero.

- [ ] **Step 2: Run and verify RED**

```powershell
pnpm exec vitest run src/llm/analysisCheckpoint.test.ts
```

Expected: FAIL because the checkpoint module and types do not exist.

- [ ] **Step 3: Add the checkpoint types**

```ts
export type AnalysisCheckpointPhase = "cues" | "summary" | "complete";

export interface AnalysisCheckpoint {
  version: 1;
  transcriptFingerprint: string;
  nextCueOffset: number;
  phase: AnalysisCheckpointPhase;
  revision: number;
}

export interface AnalysisResult {
  subtitles: Subtitle[];
  keyPhrases: KeyPhrase[];
  checkpoint?: AnalysisCheckpoint;
}

export type CheckpointedAnalysis = AnalysisResult & {
  checkpoint: AnalysisCheckpoint;
};
```

- [ ] **Step 4: Implement fingerprinting and preparation**

```ts
export interface PreparedAnalysis {
  analysis: CheckpointedAnalysis;
  needsSave: boolean;
  reason: "fresh" | "resume" | "legacy-migration" | "fingerprint-mismatch";
}

export async function fingerprintTranscript(cues: readonly SrtCue[]): Promise<string> {
  const payload = JSON.stringify(cues.map((c) => [c.index, c.time, c.endTime, c.text]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
```

`prepareAnalysis()` must validate version, fingerprint, offset range, phase, and revision. For legacy files, retain outputs and use `Math.min(cached.subtitles.length, cues.length)` once; all subsequent resumes use the new checkpoint.

- [ ] **Step 5: Run tests and commit**

```powershell
pnpm exec vitest run src/llm/analysisCheckpoint.test.ts src/llm/types.test.ts
pnpm typecheck
git add client/src/llm/types.ts client/src/llm/analysisCheckpoint.ts client/src/llm/analysisCheckpoint.test.ts
git diff --cached --check
git commit -m "feat(analysis): add versioned checkpoints"
```

### Task 2: Add typed provider failures and abortable retry

**Files:**
- Create: `client/src/llm/providers/errors.ts`
- Create: `client/src/llm/retry.ts`
- Create: `client/src/llm/retry.test.ts`
- Modify: `client/src/llm/providers/types.ts`
- Modify: `client/src/llm/providers/openaiCompatible.ts`
- Modify: `client/src/llm/providers/openaiCompatible.test.ts`
- Modify: `client/src/llm/providers/relayErrors.ts`
- Modify: `client/src/llm/providers/relayErrors.test.ts`

**Interfaces:**
- Produces: typed HTTP/transport/protocol errors and `retryOperation()`.
- Adds optional `Provider.retryProfile?: "deepseek-analysis"`.

- [ ] **Step 1: Write failing retry-policy tests**

```ts
const result = await retryOperation(operation, {
  policy: { maxAttempts: 4, backoffMs: [500, 1500, 3500] },
  isRetryable,
  retryAfterMs,
  sleep,
});
expect(operation).toHaveBeenCalledTimes(4);
expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1500, 3500]);
```

Add cases for: success on attempt 3, no fifth attempt, 429 `Retry-After`, 401 single attempt, license/quota single attempt, and abort during backoff.

- [ ] **Step 2: Run and verify RED**

```powershell
pnpm exec vitest run src/llm/retry.test.ts src/llm/providers/openaiCompatible.test.ts src/llm/providers/relayErrors.test.ts
```

Expected: retry module/types are missing and existing provider errors are untyped.

- [ ] **Step 3: Add typed errors**

```ts
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs: number | null,
  ) { super(message); }
}

export class ProviderTransportError extends Error {
  constructor(
    message: string,
    readonly stage: "send" | "read",
    options?: ErrorOptions,
  ) { super(message, options); }
}

export class ProviderProtocolError extends Error {}
```

Wrap the initial `fetch()` failure as stage `send`, body-reader failure as stage `read`, and non-2xx responses as `ProviderHttpError`. Preserve `AbortError` unchanged.

- [ ] **Step 4: Implement abortable retry**

```ts
export async function retryOperation<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  for (let attempt = 1; attempt <= options.policy.maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (options.signal?.aborted || !options.isRetryable(error) || attempt === options.policy.maxAttempts) throw error;
      const base = options.policy.backoffMs[attempt - 1] ?? options.policy.backoffMs.at(-1) ?? 0;
      const delayMs = Math.max(base, options.retryAfterMs(error) ?? 0);
      options.onRetry?.({ failedAttempt: attempt, nextAttempt: attempt + 1, maxAttempts: options.policy.maxAttempts, delayMs, error });
      await (options.sleep ?? abortableDelay)(delayMs, options.signal);
    }
  }
  throw new Error("unreachable retry state");
}
```

Set `retryProfile: "deepseek-analysis"` only when `inferVendorId(...)` resolves to `deepseek` or `whatsub-managed`.

- [ ] **Step 5: Verify and commit**

```powershell
pnpm exec vitest run src/llm/retry.test.ts src/llm/providers/openaiCompatible.test.ts src/llm/providers/relayErrors.test.ts
pnpm typecheck
git add client/src/llm/providers client/src/llm/retry.ts client/src/llm/retry.test.ts
git diff --cached --check
git commit -m "feat(deepseek): retry transient provider failures"
```

### Task 3: Make `runAnalysis()` batch-transactional

**Files:**
- Modify: `client/src/llm/analyze.ts`
- Modify: `client/src/llm/analyze.test.ts`
- Modify: `client/src/llm/streamingJson.ts`
- Modify: `client/src/llm/streamingJson.test.ts`

**Interfaces:**
- Consumes: checkpoint, retry helper, provider retry profile.
- Produces: `AnalysisCommit`, `AnalysisRetryEvent`, checkpoint-returning `runAnalysis()`.

- [ ] **Step 1: Add failing transaction tests**

Cover these exact behaviors:

```ts
expect(commits).toEqual([
  expect.objectContaining({
    kind: "cues",
    startCueOffset: 0,
    endCueOffset: 50,
    checkpoint: expect.objectContaining({ nextCueOffset: 50 }),
  }),
]);
```

- A read failure after one parsed cue publishes no partial commit; retry success commits once.
- Four failures publish no commit and leave the original checkpoint unchanged.
- Missing model outputs still advance to the batch input end.
- `phase: "summary"` skips cue requests; `phase: "complete"` makes no request.
- Summary retry exhaustion leaves the cue checkpoint at `phase: "summary"`.
- Cancellation during stream or backoff publishes nothing.

- [ ] **Step 2: Run and verify RED**

```powershell
pnpm exec vitest run src/llm/analyze.test.ts src/llm/streamingJson.test.ts
```

Expected: current code calls `onCue` before the stream completes and has no checkpoint contract.

- [ ] **Step 3: Change the analysis contract**

```ts
export type AnalysisCommit =
  | { kind: "cues"; startCueOffset: number; endCueOffset: number; subtitles: Subtitle[]; checkpoint: AnalysisCheckpoint }
  | { kind: "summary"; keyPhrases: KeyPhrase[]; checkpoint: AnalysisCheckpoint };

export interface RunAnalysisOptions {
  provider: Provider;
  cues: readonly SrtCue[];
  previouslyAnalyzed: readonly Subtitle[];
  checkpoint: AnalysisCheckpoint;
  onCommit: (commit: AnalysisCommit) => Promise<void>;
  onRetry?: (event: AnalysisRetryEvent) => void;
  batchSize?: number;
  style?: TranslationStyle;
  signal?: AbortSignal;
}
```

- [ ] **Step 4: Buffer and commit each batch once**

For each `[startCueOffset, endCueOffset)` range, recreate parser and local array inside `retryOperation()`. Call `onCommit()` only after normal stream completion and parser flush. Increase revision and `nextCueOffset` only in that commit. Before summary, persist a `phase: "summary"` checkpoint; summary success commits `phase: "complete"`.

Extend `JsonLineParser.feed/flush` with an optional `onInvalid(line)` callback. Any non-empty malformed line throws `ProviderProtocolError`; a clean empty batch is valid and advances its input offset.

- [ ] **Step 5: Verify and commit**

```powershell
pnpm exec vitest run src/llm/analyze.test.ts src/llm/streamingJson.test.ts
pnpm typecheck
git add client/src/llm/analyze.ts client/src/llm/analyze.test.ts client/src/llm/streamingJson.ts client/src/llm/streamingJson.test.ts
git diff --cached --check
git commit -m "refactor(analysis): commit completed input batches"
```

### Task 4: Save checkpoint revisions atomically in Rust

**Files:**
- Modify: `client/src-tauri/src/commands/analysis.rs:1-35`
- Modify: `client/src-tauri/src/commands/library_sync.rs:858`
- Modify: `client/src-tauri/Cargo.toml`
- Modify: `client/src-tauri/Cargo.lock` through Cargo only

**Interfaces:**
- Produces: process-wide serialized `SaveAnalysisOutcome` and async `save_analysis`.
- Preserves: cloud materialization can still write its downloaded `analysis.json` by awaiting the same command/helper.

- [ ] **Step 1: Add failing Rust save tests**

Add unit-testable helpers around path-based saving and assert:

```rust
assert_eq!(save_revision(&path, json_with_revision(2))?.applied, true);
assert_eq!(save_revision(&path, json_with_revision(1))?.applied, false);
assert_eq!(read_revision(&path), Some(2));
assert!(!path.with_extension("json.tmp").exists());
```

Also test equal revisions, legacy-to-checkpoint migration, concurrent revisions ending at the maximum, and replacement failure preserving the original JSON.

- [ ] **Step 2: Run and verify RED**

```powershell
Set-Location client/src-tauri
cargo test commands::analysis::tests --lib
```

Expected: save outcome/state helpers do not exist and direct writes do not reject stale revisions.

- [ ] **Step 3: Add a process-wide serialized async command**

```rust
static ANALYSIS_SAVE_GATE: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAnalysisOutcome {
    applied: bool,
    revision: Option<u64>,
}

#[tauri::command]
pub async fn save_analysis(
    video_id: String,
    analysis: Value,
) -> AppResult<SaveAnalysisOutcome> {
    let _guard = ANALYSIS_SAVE_GATE.lock().await;
    save_analysis_value(&paths::video_dir(&video_id)?.join("analysis.json"), analysis)
}
```

Change the internal cloud-materialization call to await the new command/helper:

```rust
crate::commands::analysis::save_analysis(id.clone(), analysis)
    .await
    .map_err(|e| e.to_string())?;
```

- [ ] **Step 4: Implement revision-aware atomic replacement**

Write `analysis.json.tmp`, flush it, and replace only when incoming revision is newer. Add direct `windows-sys = { version = "0.61", features = ["Win32_Storage_FileSystem"] }` for `ReplaceFileW` on Windows; use rename-over-destination on Unix. On failure, remove the temp file and retain the old JSON.

- [ ] **Step 5: Verify and commit**

```powershell
cargo fmt -- --check
cargo test commands::analysis::tests --lib
cargo build
git add src/commands/analysis.rs src/commands/library_sync.rs Cargo.toml Cargo.lock
git diff --cached --check
git commit -m "fix(analysis): save checkpoints atomically by revision"
```

### Task 5: Add one shared persisted analysis session

**Files:**
- Create: `client/src/llm/analysisSession.ts`
- Create: `client/src/llm/analysisSession.test.ts`

**Interfaces:**
- Produces: `loadPreparedAnalysis()`, `applyAnalysisCommit()`, `executeAnalysisSession()`.

- [ ] **Step 1: Write failing session tests**

Assert that save finishes before caller state is published:

```ts
await executeAnalysisSession({
  videoId: "v1",
  provider,
  cues,
  initialAnalysis,
  style: "neutral",
  onCommitted: (analysis) => published.push(analysis),
});
expect(order).toEqual(["save", "publish"]);
```

Add cases for failed save publishing nothing, `applied: false` throwing `StaleAnalysisRevisionError`, legacy migration saved before the first request, fingerprint reset saved before cue zero, and summary-only resume retaining all cue subtitles.

- [ ] **Step 2: Run and verify RED**

```powershell
pnpm exec vitest run src/llm/analysisSession.test.ts
```

- [ ] **Step 3: Define and implement the session**

```ts
export interface SaveAnalysisOutcome {
  applied: boolean;
  revision: number | null;
}

export interface ExecuteAnalysisSessionOptions {
  videoId: string;
  provider: Provider;
  cues: readonly SrtCue[];
  initialAnalysis: CheckpointedAnalysis;
  style: TranslationStyle;
  signal?: AbortSignal;
  onCommitted?: (analysis: CheckpointedAnalysis, commit: AnalysisCommit) => void;
  onRetry?: (event: AnalysisRetryEvent) => void;
}

export class StaleAnalysisRevisionError extends Error {
  constructor() {
    super("analysis checkpoint was superseded by a newer save");
  }
}

export function applyAnalysisCommit(
  current: CheckpointedAnalysis,
  commit: AnalysisCommit,
): CheckpointedAnalysis {
  return commit.kind === "cues"
    ? {
        ...current,
        subtitles: [...current.subtitles, ...commit.subtitles],
        checkpoint: commit.checkpoint,
      }
    : {
        ...current,
        keyPhrases: commit.keyPhrases,
        checkpoint: commit.checkpoint,
      };
}
```

Then implement the persisted runner:

```ts
export async function executeAnalysisSession(options: ExecuteAnalysisSessionOptions) {
  let current = options.initialAnalysis;
  await runAnalysis({
    provider: options.provider,
    cues: options.cues,
    previouslyAnalyzed: current.subtitles,
    checkpoint: current.checkpoint,
    style: options.style,
    signal: options.signal,
    onRetry: options.onRetry,
    onCommit: async (commit) => {
      const next = applyAnalysisCommit(current, commit);
      const outcome = await invoke<SaveAnalysisOutcome>("save_analysis", {
        videoId: options.videoId,
        analysis: next,
      });
      if (!outcome.applied) throw new StaleAnalysisRevisionError();
      current = next;
      options.onCommitted?.(current, commit);
    },
  });
  return current;
}
```

- [ ] **Step 4: Verify and commit**

```powershell
pnpm exec vitest run src/llm/analysisSession.test.ts
pnpm typecheck
git add client/src/llm/analysisSession.ts client/src/llm/analysisSession.test.ts
git diff --cached --check
git commit -m "feat(analysis): share checkpointed sessions"
```

### Task 6: Replace foreground retranscription recovery with continuation

**Files:**
- Modify: `client/src/store/analysis.ts`
- Modify: `client/src/pages/Player.tsx:200-430`
- Modify: `client/src/components/ProgressBanner.tsx`
- Create: `client/src/components/ProgressBanner.test.tsx`
- Create: `client/src/pages/Player.analysisResume.test.tsx`

**Interfaces:**
- Adds foreground `checkpoint`, `retryMessage`, and `errorStage` state.
- Consumes: shared analysis session.

- [ ] **Step 1: Add failing UI/resume tests**

Cover:

```ts
expect(submittedCueIndexes).toEqual(cues.slice(50).map((c) => c.index));
expect(retranscribeInvoke).not.toHaveBeenCalled();
expect(deleteAnalysisInvoke).not.toHaveBeenCalled();
```

Use a fixture with `nextCueOffset: 50` but only 47 output subtitles. Add a summary-phase fixture that sends only the summary request. Assert analysis error button text is `继续解析`, while transcription error shows `重新转录`.

- [ ] **Step 2: Run and verify RED**

```powershell
pnpm exec vitest run src/components/ProgressBanner.test.tsx src/pages/Player.analysisResume.test.tsx
```

- [ ] **Step 3: Wire Player to the shared session**

Remove `startAnalysisFrom(startIdx)` and cue-level 800ms save timers. Load/prepare the checkpoint once, pass committed states into `useAnalysis`, and derive progress from `checkpoint.nextCueOffset / cues.length`. Set retry text from `onRetry`:

```ts
setRetryMessage(`网络波动，正在重试 DeepSeek（${event.nextAttempt}/${event.maxAttempts}）`);
```

Map analysis failures to `errorStage: "cues" | "summary" | "save"`; only transcription failures retain `onRetranscribe`. Analysis failures use the existing continue path without deleting files.

- [ ] **Step 4: Verify and commit**

```powershell
pnpm exec vitest run src/components/ProgressBanner.test.tsx src/pages/Player.analysisResume.test.tsx src/llm/analysisSession.test.ts
pnpm typecheck
git add client/src/store/analysis.ts client/src/pages/Player.tsx client/src/pages/Player.analysisResume.test.tsx client/src/components/ProgressBanner.tsx client/src/components/ProgressBanner.test.tsx
git diff --cached --check
git commit -m "feat(player): continue analysis from checkpoints"
```

### Task 7: Move background analysis to the same checkpoint semantics

**Files:**
- Modify: `client/src/store/backgroundAnalyses.ts`
- Create: `client/src/store/backgroundAnalyses.test.ts`
- Modify: `client/src/components/DownloadQueueWidget.tsx`
- Modify: `client/src/components/DownloadQueueWidget.test.tsx`

**Interfaces:**
- Produces: `resumeBackgroundAnalysis(videoId): Promise<void>`.
- Changes progress source from output count to checkpoint input offset.

- [ ] **Step 1: Add failing background tests**

Test offset 50 with 47 outputs, summary-only resume, committed progress surviving cancellation, current failed batch publishing nothing, retry message visibility, and continuation never calling `retranscribe_video`/`delete_analysis`.

- [ ] **Step 2: Run and verify RED**

```powershell
pnpm exec vitest run src/store/backgroundAnalyses.test.ts src/components/DownloadQueueWidget.test.tsx
```

- [ ] **Step 3: Store checkpointed analysis in each job**

```ts
export interface BgAnalysisJob {
  videoId: string;
  label: string;
  phase: "cues" | "summary" | "done" | "error";
  analysis: CheckpointedAnalysis | null;
  totalCues: number;
  retryMessage: string | null;
  errorMessage: string | null;
  errorStage: "cues" | "summary" | "save" | null;
  startedAt: number;
}
```

Run the shared session, update jobs only in `onCommitted`, and calculate percentage from `nextCueOffset`. On exhausted transient errors, expose `继续解析`; do not enqueue retranscription.

- [ ] **Step 4: Verify and commit**

```powershell
pnpm exec vitest run src/store/backgroundAnalyses.test.ts src/components/DownloadQueueWidget.test.tsx
pnpm typecheck
git add client/src/store/backgroundAnalyses.ts client/src/store/backgroundAnalyses.test.ts client/src/components/DownloadQueueWidget.tsx client/src/components/DownloadQueueWidget.test.tsx
git diff --cached --check
git commit -m "feat(analysis): resume background jobs by checkpoint"
```

### Task 8: Document and run the complete regression gate

**Files:**
- Modify: `client/CLAUDE.md`

**Interfaces:**
- Documents: checkpoint schema, transactional batch commits, retry classification, and destructive retranscription boundary.

- [ ] **Step 1: Update architecture documentation**

Document that completed batches save exact input offsets, DeepSeek gets at most three retries, old files migrate once, foreground/background use shared sessions, and remote import-queue restart persistence still requires backend fields.

- [ ] **Step 2: Run all frontend and Rust verification**

```powershell
Set-Location client
pnpm exec vitest run
pnpm typecheck
pnpm build

Set-Location src-tauri
cargo fmt -- --check
cargo test commands::analysis::tests --lib
cargo test --lib
cargo build

Set-Location ../..
git diff --check
git status --short
```

Expected: all tests/builds pass and only planned files are changed.

- [ ] **Step 3: Commit documentation**

```powershell
git add client/CLAUDE.md
git diff --cached --check
git commit -m "docs(analysis): document checkpointed recovery"
```
