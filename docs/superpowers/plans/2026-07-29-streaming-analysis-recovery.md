# Streaming Analysis Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore cue-by-cue analysis previews while keeping 50-cue atomic checkpoints and repairing only malformed, missing, or invalid LLM cue outputs.

**Architecture:** Separate model-output validation from orchestration. `runAnalysis` maintains an in-memory map for the current contiguous checkpoint range, previews each validated cue, and re-requests only unresolved indexes; `executeAnalysisSession` remains the persistence boundary and forwards previews alongside the last committed snapshot. Foreground and background stores render committed plus ephemeral preview data, while only Rust-confirmed saves advance `nextCueOffset`.

**Tech Stack:** React 19, TypeScript 5.8, Zustand 5, Vitest 4, Tauri 2, existing OpenAI-compatible streaming providers.

## Global Constraints

- Keep the normal request batch size at exactly 50 cues.
- Keep `AnalysisCheckpoint` version 1 and the current Rust lease/atomic-save protocol unchanged.
- Source text, start time, and end time always come from the local `SrtCue`.
- Do not silently advance `nextCueOffset` past an unresolved translation.
- Do not persist individual preview cues or add a partial-analysis sidecar.
- DeepSeek and managed DeepSeek retain four total analysis attempts with cancellable 500ms, 1500ms, and 3500ms backoff.
- Authentication, license, quota, cancellation, stale-lease, and persistence failures must not enter model-content repair retries.
- No new runtime dependency is required; malformed model text is regenerated rather than heuristically rewritten.
- Do not change Whisper execution or trigger release/CI.
- Preserve user-owned untracked `.agents/skills/` and `AGENTS.md`.

## File Structure

- Create `client/src/llm/cueOutput.ts`: compact cue-output types and deterministic per-cue validation.
- Create `client/src/llm/cueOutput.test.ts`: validator behavior and authoritative-source tests.
- Create `client/src/llm/prompts.test.ts`: observable compact-response prompt contract.
- Modify `client/src/llm/prompts.ts`: compact cue schema and unresolved-cue repair prompt.
- Modify `client/src/llm/streamingJson.ts`: preserve the JSON parse cause for bounded diagnostics.
- Modify `client/src/llm/streamingJson.test.ts`: invalid-line cause coverage.
- Modify `client/src/llm/analyze.ts`: preview events, unresolved-index repair loop, retry classification, and concise terminal errors.
- Modify `client/src/llm/analyze.test.ts`: stream, repair, transport, rollback, and summary retry tests.
- Modify `client/src/llm/analysisSession.ts`: forward previews with the current durable snapshot.
- Modify `client/src/llm/analysisSession.test.ts`: persistence/preview ordering tests.
- Create `client/src/llm/analysisRetryMessage.ts`: shared foreground/background retry copy.
- Create `client/src/llm/analysisRetryMessage.test.ts`: transport/content-repair copy tests.
- Modify `client/src/store/analysis.ts`: render durable plus preview subtitles without moving the checkpoint.
- Modify `client/src/pages/Player.tsx`: connect foreground preview and content-repair status.
- Modify `client/src/pages/Player.analysisResume.test.tsx`: foreground preview/rollback tests.
- Modify `client/src/store/backgroundAnalyses.ts`: publish fenced background previews with a durable offset.
- Modify `client/src/store/backgroundAnalyses.test.ts`: background preview, commit, rollback, and retry-copy tests.
- Modify `client/CLAUDE.md`: document the preview-versus-checkpoint invariant and targeted repair behavior.

---

### Task 1: Compact Cue Contract and Deterministic Validation

**Files:**
- Create: `client/src/llm/cueOutput.ts`
- Create: `client/src/llm/cueOutput.test.ts`
- Create: `client/src/llm/prompts.test.ts`
- Modify: `client/src/llm/prompts.ts:73-160`

**Interfaces:**
- Consumes: `SrtCue` and `Subtitle` from `client/src/llm/types.ts`.
- Produces:

```ts
export type CueOutputValidation =
  | { status: "resolved"; index: number; subtitle: Subtitle }
  | { status: "unresolved"; index: number | null; reason: string };

export function validateCueOutput(
  value: unknown,
  requested: ReadonlyMap<number, SrtCue>,
): CueOutputValidation;

export function buildRepairPrompt(cues: readonly SrtCue[]): string;
```

- [ ] **Step 1: Write failing validator tests**

Add literal fixtures to `cueOutput.test.ts` that prove the application, not the model, owns source fields:

```ts
it("assembles source identity locally and keeps only valid highlights", () => {
  const source = { index: 54, time: 157.46, endTime: 162.5, text: "actual stack questions" };
  const result = validateCueOutput({
    index: 54,
    translation: "真实的堆栈问题",
    isKeyPoint: true,
    highlights: [
      { source: "stack questions", translation: "堆栈问题", note: "表示一组连续相关的问题" },
      { source: "not in source", translation: "堆栈问题", note: "invalid" },
    ],
    text: "model must not win",
    time: 999,
  }, new Map([[54, source]]));

  expect(result).toEqual({
    status: "resolved",
    index: 54,
    subtitle: {
      time: 157.46,
      endTime: 162.5,
      text: "actual stack questions",
      translation: "真实的堆栈问题",
      isKeyPoint: true,
      highlightWords: ["stack questions"],
      keyNotes: { "stack questions": "表示一组连续相关的问题" },
      highlightTranslations: { "stack questions": "堆栈问题" },
    },
  });
});

it.each([
  ["unknown index", { index: 99, translation: "译文" }, null],
  ["empty translation", { index: 54, translation: "  " }, 54],
  ["non-string translation", { index: 54, translation: 123 }, 54],
])("leaves %s unresolved", (_name, output, index) => {
  const requested = new Map([[54, { index: 54, time: 1, endTime: 2, text: "source" }]]);
  expect(validateCueOutput(output, requested)).toMatchObject({ status: "unresolved", index });
});
```

Add a separate test proving malformed highlight fields reduce to empty maps while a valid translation remains resolved. The mutation caught by these tests is any code path that trusts model `text/time`, accepts an empty translation, or allows non-substring highlights.

- [ ] **Step 2: Run the focused validator test and verify RED**

Run:

```powershell
cd client
pnpm test -- src/llm/cueOutput.test.ts
```

Expected: FAIL because `cueOutput.ts` and `validateCueOutput` do not exist.

- [ ] **Step 3: Implement the minimal validator**

Implement exact-string checks and derive the three persisted highlight structures from one compact array:

```ts
const source = requested.get(index);
if (!source) return { status: "unresolved", index: null, reason: "index-not-requested" };
if (typeof output.translation !== "string" || !output.translation.trim()) {
  return { status: "unresolved", index, reason: "translation-missing" };
}

const highlightWords: string[] = [];
const keyNotes: Record<string, string> = {};
const highlightTranslations: Record<string, string> = {};
for (const candidate of Array.isArray(output.highlights) ? output.highlights : []) {
  if (!isPlainObject(candidate)) continue;
  const phrase = typeof candidate.source === "string" ? candidate.source.trim() : "";
  const translated = typeof candidate.translation === "string" ? candidate.translation.trim() : "";
  const note = typeof candidate.note === "string" ? candidate.note.trim() : "";
  if (!phrase || !translated || !note) continue;
  if (!source.text.includes(phrase) || !translation.includes(translated)) continue;
  if (keyNotes[phrase] !== undefined) continue;
  highlightWords.push(phrase);
  keyNotes[phrase] = note;
  highlightTranslations[phrase] = translated;
}
```

Use `output.isKeyPoint === true`; do not coerce strings such as `"false"` to true.

- [ ] **Step 4: Run the validator tests and verify GREEN**

Run `pnpm test -- src/llm/cueOutput.test.ts` from `client`.

Expected: all validator tests PASS.

- [ ] **Step 5: Write failing prompt-contract tests**

Create `prompts.test.ts` and assert behavior rather than private constants:

```ts
it("asks providers for compact generated fields and not source echoes", () => {
  const prompt = buildSystemPrompt("colloquial");
  expect(prompt).toContain('"highlights"');
  expect(prompt).toContain('"index"');
  expect(prompt).not.toContain('"endTime": number');
  expect(prompt).not.toContain('"highlightWords": string[]');
});

it("builds a repair request containing only unresolved cues", () => {
  const prompt = buildRepairPrompt([
    { index: 17, time: 1, endTime: 2, text: "missing seventeen" },
    { index: 38, time: 3, endTime: 4, text: "missing thirty eight" },
  ]);
  expect(prompt).toContain("missing seventeen");
  expect(prompt).toContain("missing thirty eight");
  expect(prompt).toContain("17\t1.00\t2.00");
  expect(prompt).not.toContain("source-0");
});
```

- [ ] **Step 6: Run prompt tests and verify RED**

Run `pnpm test -- src/llm/prompts.test.ts`.

Expected: FAIL because the current schema echoes source fields and `buildRepairPrompt` is absent.

- [ ] **Step 7: Replace the per-cue output schema and add the repair prompt**

Keep tab-separated source input unchanged, but change the requested output example to:

```json
{"index":12,"translation":"我得把邮件处理一下","isKeyPoint":true,"highlights":[{"source":"catch up","translation":"处理一下","note":"动词短语，表示赶上或补做落下的事情"}]}
```

`buildRepairPrompt` must use the same tab-separated serializer as the initial and continuation prompts and explicitly require exactly one object for every supplied index.

- [ ] **Step 8: Run Task 1 tests and commit**

Run:

```powershell
pnpm test -- src/llm/cueOutput.test.ts src/llm/prompts.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```powershell
git add client/src/llm/cueOutput.ts client/src/llm/cueOutput.test.ts client/src/llm/prompts.ts client/src/llm/prompts.test.ts
git commit -m "feat(analysis): validate compact cue output"
```

---

### Task 2: Streaming Batch Resolver and Targeted Repair

**Files:**
- Modify: `client/src/llm/streamingJson.ts:1-46`
- Modify: `client/src/llm/streamingJson.test.ts:1-58`
- Modify: `client/src/llm/analyze.ts:1-364`
- Modify: `client/src/llm/analyze.test.ts:1-540`

**Interfaces:**
- Consumes: `validateCueOutput`, `buildRepairPrompt`, existing `Provider`, `RetryPolicy`, and `AnalysisCommit`.
- Produces:

```ts
export interface AnalysisPreview {
  startCueOffset: number;
  endCueOffset: number;
  subtitles: Subtitle[];
}

export type AnalysisRetryEvent = RetryEvent & {
  kind: "transport" | "content-repair";
  unresolvedCueIndexes: number[];
};

// Added to RunAnalysisOptions and the legacy adapter:
onPreview?: (preview: AnalysisPreview | null) => void;
```

- [ ] **Step 1: Write a failing malformed-line diagnostic test**

Change the invalid-line callback to receive both the line and parse cause:

```ts
it("reports the JSON parse cause without swallowing later valid lines", () => {
  const invalid: InvalidJsonLine[] = [];
  const valid: unknown[] = [];
  const parser = new JsonLineParser();
  parser.feed('{"index":1,"translation":"broken\n{"index":2,"translation":"ok"}\n',
    (value) => valid.push(value),
    (failure) => invalid.push(failure));
  expect(invalid).toHaveLength(1);
  expect(invalid[0].line).toContain('"index":1');
  expect(invalid[0].error).toBeInstanceOf(SyntaxError);
  expect(valid).toEqual([{ index: 2, translation: "ok" }]);
});
```

- [ ] **Step 2: Run parser tests and verify RED**

Run `pnpm test -- src/llm/streamingJson.test.ts`.

Expected: FAIL because invalid callbacks currently receive only a string.

- [ ] **Step 3: Add `InvalidJsonLine` without changing normal parsing**

```ts
export interface InvalidJsonLine {
  line: string;
  error: SyntaxError;
}
```

Convert only `JSON.parse` failures to this event. Continue swallowing consumer callback exceptions as before so parser and schema responsibilities remain separate.

- [ ] **Step 4: Run parser tests and verify GREEN**

Run `pnpm test -- src/llm/streamingJson.test.ts`.

Expected: PASS.

- [ ] **Step 5: Replace old batch assumptions with failing resolver tests**

Update the test `cueLine` helper to emit the compact schema. Replace the old “one output advances 50 inputs” and “discard successful partial stream output” expectations with these behaviors:

```ts
it("previews valid cues and repairs only the unresolved index before one commit", async () => {
  const provider = scriptedProvider([
    { chunks: [cueLine(0), '{"index":1,"translation":"broken\n', cueLine(2)] },
    { chunks: [cueLine(1)] },
  ]);
  const previews: Array<AnalysisPreview | null> = [];
  const commits: AnalysisCommit[] = [];
  const controller = new AbortController();

  await runWithTimers(runAnalysis({
    provider,
    cues: cues(3),
    previouslyAnalyzed: [],
    checkpoint: checkpoint(),
    batchSize: 3,
    signal: controller.signal,
    onPreview: (preview) => previews.push(preview),
    onCommit: async (commit) => { commits.push(commit); controller.abort(); },
  }));

  expect(previews.filter(Boolean).map((p) => p!.subtitles.length)).toEqual([1, 2, 3]);
  expect(provider.requests).toHaveLength(2);
  expect(provider.requests[1].userPrompt).toContain("source-1");
  expect(provider.requests[1].userPrompt).not.toContain("source-0");
  expect(provider.requests[1].userPrompt).not.toContain("source-2");
  expect(commits[0]).toMatchObject({
    kind: "cues",
    endCueOffset: 3,
    subtitles: [
      { text: "source-0" },
      { text: "source-1" },
      { text: "source-2" },
    ],
  });
});
```

Add independent tests proving:

- an empty translation remains unresolved and is the only cue in the repair prompt;
- a transport error after cue 0 retains cue 0 and requests only cue 1;
- duplicate and out-of-range indexes never replace a requested cue;
- four exhausted DeepSeek attempts produce no commit, emit a final `null` preview, and leave the input checkpoint unchanged;
- a provider without `retryProfile` makes one attempt and rolls back;
- cancellation clears preview and does not commit;
- malformed summary output retries summary only and never sends another cue prompt;
- authentication/quota `ProviderHttpError` is not converted into content repair.

Each test must assert real commits, preview snapshots, and request contents. Provider request counting is allowed because the retry unit and input subset are part of this module's public contract.

- [ ] **Step 6: Run analysis tests and verify RED**

Run `pnpm test -- src/llm/analyze.test.ts`.

Expected: failures show the current code buffers until completion, throws on the first malformed line, discards validated partial output, and advances batches with missing results.

- [ ] **Step 7: Implement the unresolved-index repair loop**

Extract a private `resolveCueBatch` inside `analyze.ts` with this state:

```ts
const resolved = new Map<number, Subtitle>();
let unresolved = batch.map((cue) => cue.index);
const maxAttempts = opts.provider.retryProfile === "deepseek-analysis" ? 4 : 1;
```

For each attempt:

1. Build `requestedCues` by filtering the original batch to `unresolved`.
2. Use the initial/continuation prompt only on attempt 1; use `buildRepairPrompt` thereafter.
3. Parse every valid line with `validateCueOutput` against a map containing only `requestedCues`.
4. Ignore duplicates already present in `resolved`.
5. Emit a sorted `AnalysisPreview` immediately after each new resolution.
6. Recompute `unresolved` in original cue order after stream completion or retryable transport failure.
7. If unresolved is empty, return subtitles in original batch order.
8. If attempts remain, emit an `AnalysisRetryEvent` with `kind`, unresolved indexes, and cancellable backoff.
9. If attempts are exhausted, throw a concise `ProviderProtocolError` such as `模型返回格式异常，3 条字幕仍未完成（索引：17、38、42）`.

Do not pass malformed lines to `ProviderProtocolError` directly. Log only a bounded escaped excerpt plus `SyntaxError.message` for diagnostics.

- [ ] **Step 8: Preserve the transaction boundary and clear previews deterministically**

After `resolveCueBatch` returns all results, retain the existing order:

```ts
await opts.onCommit(commit); // Rust-confirmed save occurs in the session adapter
opts.onPreview?.(null);      // caller now renders the newly committed snapshot
```

Wrap each cue transaction so abort, terminal content failure, transport exhaustion, and commit failure call `onPreview(null)` before propagating/returning. Never advance `currentCheckpoint` before `onCommit` resolves.

- [ ] **Step 9: Make summary content retryable without resubmitting cues**

Use the existing DeepSeek retry policy around the summary request, but classify malformed/missing summary output as a retryable analysis-content failure for that phase. Preserve immediate exits for abort, auth, license, and quota errors. Emit `kind: "content-repair"` with an empty cue-index list for summary retries.

- [ ] **Step 10: Run Task 2 tests and commit**

Run:

```powershell
pnpm test -- src/llm/streamingJson.test.ts src/llm/analyze.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```powershell
git add client/src/llm/streamingJson.ts client/src/llm/streamingJson.test.ts client/src/llm/analyze.ts client/src/llm/analyze.test.ts
git commit -m "feat(analysis): repair unresolved streamed cues"
```

---

### Task 3: Session Adapter and Foreground Preview

**Files:**
- Modify: `client/src/llm/analysisSession.ts:325-350`
- Modify: `client/src/llm/analysisSession.test.ts:199-292`
- Create: `client/src/llm/analysisRetryMessage.ts`
- Create: `client/src/llm/analysisRetryMessage.test.ts`
- Modify: `client/src/store/analysis.ts:20-160`
- Modify: `client/src/pages/Player.tsx:232-330`
- Modify: `client/src/pages/Player.analysisResume.test.tsx:1-75`

**Interfaces:**
- Consumes: `AnalysisPreview`, `CheckpointedAnalysis`, and the existing session lease.
- Produces:

```ts
// executeAnalysisSession option
onPreview?: (
  committed: CheckpointedAnalysis,
  preview: AnalysisPreview | null,
) => void;

// Zustand action
setAnalysisPreview(
  committed: CheckpointedAnalysis,
  preview: AnalysisPreview | null,
  totalCues: number,
): void;

export function analysisRetryMessage(event: AnalysisRetryEvent): string;
```

- [ ] **Step 1: Write failing session-ordering tests**

Use a provider that yields one compact cue and then waits on a gate. Assert:

```ts
expect(onPreview).toHaveBeenCalledWith(
  session.analysis,
  expect.objectContaining({ subtitles: [expect.objectContaining({ text: "First" })] }),
);
expect(onCommitted).not.toHaveBeenCalled();
expect(saveAnalysisSessionInvoke).not.toHaveBeenCalled();
```

Then release the stream and hold the session `save` promise. The preview remains visible while save is pending, `onCommitted` remains untouched, and the checkpoint stays at its old revision. After save resolves, assert `onCommitted` receives the new revision and the final preview callback is `(newCommitted, null)`.

Add a save-rejection test proving the final callback is `(oldCommitted, null)` and no unconfirmed analysis is published.

- [ ] **Step 2: Run session tests and verify RED**

Run `pnpm test -- src/llm/analysisSession.test.ts`.

Expected: FAIL because `executeAnalysisSession` does not expose preview events.

- [ ] **Step 3: Forward previews through the session-owned durable snapshot**

Inside `executeAnalysisSession`, retain the local `committed` variable and forward:

```ts
onPreview: (preview) => options.onPreview?.(committed, preview),
```

The existing `onCommit` sequence remains `applyCommit -> await session.save -> update committed -> onCommitted`. This ensures a preview callback can never masquerade as a saved checkpoint.

- [ ] **Step 4: Run session tests and verify GREEN**

Run `pnpm test -- src/llm/analysisSession.test.ts`.

Expected: PASS.

- [ ] **Step 5: Write failing foreground-store tests**

Add tests to `Player.analysisResume.test.tsx`:

```ts
it("shows preview cues without advancing the committed checkpoint", () => {
  const committed = checkpointedWithOneCueAtOffset(50);
  const preview = { startCueOffset: 50, endCueOffset: 100, subtitles: [subtitle(51)] };
  useAnalysis.getState().setAnalysisPreview(committed, preview, 100);
  const state = useAnalysis.getState();
  expect(state.subtitles).toHaveLength(2);
  expect(state.checkpoint?.nextCueOffset).toBe(50);
  expect(state.progressPercent).toBe(50);
});

it("rolls preview back to the durable snapshot", () => {
  const committed = checkpointedWithOneCueAtOffset(50);
  useAnalysis.getState().setAnalysisPreview(committed, previewWithCue51, 100);
  useAnalysis.getState().setAnalysisPreview(committed, null, 100);
  expect(useAnalysis.getState().subtitles).toEqual(committed.subtitles);
});
```

The first test catches accidental checkpoint movement or persistence of previews; the second catches stale UI output after failure/cancellation.

Create `analysisRetryMessage.test.ts` with literal events:

```ts
it("distinguishes transport retries from cue repair", () => {
  expect(analysisRetryMessage({
    kind: "transport",
    failedAttempt: 1,
    nextAttempt: 2,
    maxAttempts: 4,
    delayMs: 500,
    error: new Error("offline"),
    unresolvedCueIndexes: [17, 38],
  })).toBe("网络波动，正在进行第 2/4 次尝试…");

  expect(analysisRetryMessage({
    kind: "content-repair",
    failedAttempt: 1,
    nextAttempt: 2,
    maxAttempts: 4,
    delayMs: 500,
    error: new Error("malformed"),
    unresolvedCueIndexes: [17, 38],
  })).toBe("模型返回格式不完整，正在补齐 2 条字幕（第 2/4 次）…");
});
```

- [ ] **Step 6: Run foreground tests and verify RED**

Run `pnpm test -- src/pages/Player.analysisResume.test.tsx src/llm/analysisRetryMessage.test.ts`.

Expected: FAIL because `setAnalysisPreview` does not exist.

- [ ] **Step 7: Implement foreground projection and retry copy**

Implement `analysisRetryMessage` as a pure exhaustive branch over `event.kind`.
`setAnalysisPreview` sets visible subtitles to:

```ts
dedupSubtitles([
  ...committed.subtitles,
  ...(preview?.subtitles ?? []),
])
```

It sets summary/checkpoint/progress from `committed`, never from preview length. Wire `Player.tsx`:

```ts
onPreview: (committed, preview) => {
  if (sessionRef.current !== session) return;
  analysis.setAnalysisPreview(committed, preview, cues.length);
},
```

Render retry copy through `analysisRetryMessage(event)`:

- transport: `网络波动，正在进行第 N/4 次尝试…`
- content repair: `模型返回格式不完整，正在补齐 N 条字幕（第 A/4 次）…`

Keep `setCommittedAnalysis` as the atomic durable projection after save.

- [ ] **Step 8: Run Task 3 tests and commit**

Run:

```powershell
pnpm test -- src/llm/analysisSession.test.ts src/llm/analysisRetryMessage.test.ts src/pages/Player.analysisResume.test.tsx
pnpm typecheck
```

Expected: PASS.

Commit:

```powershell
git add client/src/llm/analysisSession.ts client/src/llm/analysisSession.test.ts client/src/llm/analysisRetryMessage.ts client/src/llm/analysisRetryMessage.test.ts client/src/store/analysis.ts client/src/pages/Player.tsx client/src/pages/Player.analysisResume.test.tsx
git commit -m "feat(player): stream uncommitted analysis previews"
```

---

### Task 4: Background Preview Projection and Runtime Fencing

**Files:**
- Modify: `client/src/store/backgroundAnalyses.ts:175-260`
- Modify: `client/src/store/backgroundAnalyses.test.ts:90-340`

**Interfaces:**
- Consumes: session `onPreview(committed, preview)` from Task 3.
- Produces: background jobs whose `subtitles`/`subtitleCount` may include preview data while `committedCueOffset` remains durable.

- [ ] **Step 1: Change the save-gate test to require live preview**

Replace the pre-save expectation of 47 visible subtitles with:

```ts
await waitFor(() => {
  const job = useBgAnalyses.getState().jobs["video-1"];
  expect(job?.subtitleCount).toBe(48);
  expect(job?.committedCueOffset).toBe(50);
});
expect(save).toHaveBeenCalledTimes(1);
```

After releasing save, assert `committedCueOffset` becomes 51 and `subtitleCount` stays 48 rather than duplicating the preview.

- [ ] **Step 2: Add failing rollback and targeted-repair status tests**

Add tests proving:

- a terminal content failure restores `session.analysis.subtitles` and keeps its committed offset;
- `takeOverBackground` returns only `session.analysis`, not an ephemeral preview;
- a callback from a runtime removed/replaced in `runtimes` cannot republish a preview;
- a `content-repair` retry event displays the number of unresolved cues rather than the network message;
- transport retry continues displaying the existing network message.

- [ ] **Step 3: Run background tests and verify RED**

Run `pnpm test -- src/store/backgroundAnalyses.test.ts`.

Expected: preview-before-save and content-repair-copy tests FAIL against the current committed-only publisher.

- [ ] **Step 4: Implement fenced background preview publication**

Add a helper that never mutates the durable analysis:

```ts
function publishPreview(
  runtime: BgRuntime,
  committed: CheckpointedAnalysis,
  preview: AnalysisPreview | null,
): void {
  if (runtimes.get(runtime.videoId) !== runtime) return;
  publishAnalysis(runtime, {
    ...committed,
    subtitles: [
      ...committed.subtitles,
      ...(preview?.subtitles ?? []),
    ],
  }, "analyzing");
}
```

Because `publishAnalysis` derives `committedCueOffset` from the supplied checkpoint, the visible list may grow cue by cue without moving restart progress. Keep the existing runtime-identity checks on committed callbacks and use the same check for preview callbacks.

- [ ] **Step 5: Update background retry messages**

Use `analysisRetryMessage` from Task 3. Do not duplicate the Chinese strings in `backgroundAnalyses.ts`; the background tests assert the formatter's observable store output.

- [ ] **Step 6: Run Task 4 tests and commit**

Run:

```powershell
pnpm test -- src/store/backgroundAnalyses.test.ts src/components/DownloadQueueWidget.test.tsx
pnpm typecheck
```

Expected: PASS.

Commit:

```powershell
git add client/src/store/backgroundAnalyses.ts client/src/store/backgroundAnalyses.test.ts
git commit -m "feat(analysis): stream fenced background previews"
```

---

### Task 5: Regression Gate and Maintainer Documentation

**Files:**
- Modify: `client/CLAUDE.md`
- Test: all focused files from Tasks 1-4 plus the complete frontend/Rust suites.

**Interfaces:**
- Consumes: completed compact schema, repair loop, session adapter, and projections.
- Produces: documented invariants and a verified branch ready for review; no release or CI.

- [ ] **Step 1: Document the non-obvious invariants**

Add a concise section to `client/CLAUDE.md` stating:

```text
- LLM cue output is ephemeral until every input cue in the contiguous batch is resolved and the lease-backed atomic save succeeds.
- UI subtitles may equal committed subtitles plus one in-memory preview batch, but progress/restart always uses checkpoint.nextCueOffset.
- Malformed/missing cue output triggers requests for unresolved indexes only; source text/timestamps are never accepted from the model.
- Cancellation, stale lease, terminal failure, reset, and delete must clear preview state.
```

- [ ] **Step 2: Run all focused tests**

Run from `client`:

```powershell
pnpm test -- src/llm/cueOutput.test.ts src/llm/prompts.test.ts src/llm/streamingJson.test.ts src/llm/analyze.test.ts src/llm/analysisSession.test.ts src/llm/analysisRetryMessage.test.ts src/pages/Player.analysisResume.test.tsx src/store/backgroundAnalyses.test.ts
```

Expected: all PASS with no unhandled promise rejections.

- [ ] **Step 3: Run frontend gates**

```powershell
pnpm typecheck
pnpm build
pnpm test
```

Expected: typecheck/build PASS and the complete Vitest suite passes.

- [ ] **Step 4: Run Rust regression gates**

From `client/src-tauri`:

```powershell
cargo test
cargo build
```

Expected: existing Rust tests/build PASS; this feature does not modify Rust.

- [ ] **Step 5: Run a Tauri startup smoke**

Start `pnpm tauri dev` long enough to confirm Vite and the Tauri window initialize without a runtime import error, then terminate only the process started by this smoke test. Do not kill unrelated user processes.

- [ ] **Step 6: Audit persistence and diff invariants**

Verify with code review and tests that:

- no preview callback invokes `save_analysis_session`;
- every cue commit contains exactly one output for every cue in its contiguous input range;
- `currentCheckpoint` changes only after `onCommit` resolves;
- repair prompts contain only unresolved cues;
- foreground/background rollback restores the durable snapshot;
- no version, release workflow, updater manifest, or CI trigger changed.

- [ ] **Step 7: Commit documentation and final corrections**

```powershell
git add client/CLAUDE.md
git commit -m "docs(analysis): explain streaming repair invariants"
```

If verification required production corrections, commit each correction with its corresponding regression test before this documentation commit; do not hide code fixes inside the docs commit.

- [ ] **Step 8: Request final code review**

Use `superpowers:requesting-code-review` against the complete branch. Resolve Critical and Important findings with a failing regression test first, then rerun Steps 2-5.
