# Analysis Inflight Journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every validated streaming subtitle before displaying it so pause, quota failure, network failure, or process termination resumes only the missing cues.

**Architecture:** Keep `analysis.json` as the authoritative 50-cue checkpoint and add a bounded `analysis.inflight.json` owned by the Rust lease store. The frontend validates journal semantics against parsed cues, seeds the current batch from durable entries, and awaits an atomic journal save before publishing each preview. Canonical commit advances first; stale journal cleanup is best-effort and idempotent.

**Tech Stack:** Tauri 2, Rust/serde/serde_json, React 19, TypeScript, Zustand, Vitest.

## Global Constraints

- `analysis.json` remains the only snapshot consumed by library, sync, export, and Agent tools.
- Production batch size remains exactly 50 cues; summary is never journaled partially.
- Journal limits are 8 MiB per file, at most 50 entries, and at most 256 KiB serialized per entry.
- A preview is visible only after its cumulative journal save succeeds.
- Canonical `analysis.json` is committed before journal cleanup; cleanup failure cannot roll back or report the canonical commit as failed.
- Journal entries are keyed by transcript array `cueOffset`, never by SRT `index`.
- Reset, retranscribe, delete, and successful materialized replacement invalidate the old journal through the Rust destructive boundary.
- Preserve all unrelated user changes. Execute this plan in an isolated worktree created from commit `abe49c3` or later.

## File Structure

- Create `src/llm/analysisJournal.ts`: TypeScript journal schema, parser, session compatibility checks, monotonic merge, and preview conversion.
- Create `src/llm/analysisJournal.test.ts`: pure journal contract tests.
- Modify `src-tauri/src/commands/analysis_store.rs`: Rust journal schema, file limits, atomic persistence, lease ownership, recovery, and cleanup.
- Modify `src-tauri/src/commands/analysis.rs`: Tauri begin/save/discard journal command arguments.
- Modify `src-tauri/src/lib.rs`: register journal commands.
- Modify `src/llm/analysisCheckpoint.ts`: export the existing `isSubtitle` validator for journal parsing.
- Modify `src/llm/analysisSession.ts`: expose durable inflight state and serialize canonical/journal saves through one session tail.
- Modify `src/llm/analyze.ts`: seed current batch by cue offset and await durable preview callbacks.
- Modify `src/store/analysis.ts`: track canonical and inflight counts separately.
- Modify `src/pages/Player.tsx`: pass analysis style when opening sessions and preserve durable previews on pause/navigation.
- Modify `src/store/backgroundAnalyses.ts`: pass style when reopening and publish durable inflight counts.
- Modify `src/store/importQueue.ts`: open imported analysis with `neutral` style.
- Modify `src/components/ProgressBanner.tsx`: use “暂停解析” and show canonical/inflight saved counts.
- Modify `src/components/DownloadQueueWidget.tsx`: calculate background progress from canonical plus durable inflight entries.
- Modify the corresponding existing test files and `CLAUDE.md`.

---

### Task 1: TypeScript Journal Domain

**Files:**
- Create: `src/llm/analysisJournal.ts`
- Create: `src/llm/analysisJournal.test.ts`
- Modify: `src/llm/analysisCheckpoint.ts`

**Interfaces:**
- Consumes: `Subtitle`, `CheckpointedAnalysis`, `TranslationStyle`, and the existing subtitle shape validator.
- Produces:
  - `AnalysisInflightEntry`
  - `AnalysisInflightJournal`
  - `parseAnalysisInflightJournal(value: unknown): AnalysisInflightJournal | null`
  - `journalMatchesSession(journal, context): boolean`
  - `mergeInflightEntries(journal, entries): AnalysisInflightJournal`
  - `journalSubtitles(journal): Subtitle[]`

- [ ] **Step 1: Write the failing pure-domain tests**

Create tests that prove malformed values are rejected, duplicate cue offsets are rejected, duplicate SRT indexes remain distinct, session identity is exact, and merges are monotonic:

```ts
it("keeps duplicate SRT indexes distinct by cue offset", () => {
  const journal = parseAnalysisInflightJournal({
    version: 1,
    journalId: "j1",
    transcriptGeneration: "sha256:raw",
    transcriptFingerprint: "sha256:semantic",
    analysisStyle: "neutral",
    baseRevision: 2,
    startCueOffset: 50,
    endCueOffset: 100,
    entries: [
      { cueOffset: 50, subtitle: subtitle("first") },
      { cueOffset: 51, subtitle: subtitle("second") },
    ],
  });

  expect(journal?.entries.map((entry) => entry.cueOffset)).toEqual([50, 51]);
  expect(journalSubtitles(journal!)).toHaveLength(2);
});

it("rejects a journal for another canonical revision or style", () => {
  expect(journalMatchesSession(validJournal(), {
    transcriptGeneration: "sha256:raw",
    transcriptFingerprint: "sha256:semantic",
    analysisStyle: "formal",
    baseRevision: 2,
    nextCueOffset: 50,
    cueCount: 100,
  })).toBe(false);
});

it("refuses to remove or rewrite an already saved entry", () => {
  const journal = validJournal();
  expect(() => mergeInflightEntries(journal, [
    { cueOffset: 50, subtitle: subtitle("changed") },
  ])).toThrow(/rewrite/i);
});
```

- [ ] **Step 2: Run the tests and confirm the missing-module failure**

Run: `pnpm vitest run src/llm/analysisJournal.test.ts`

Expected: FAIL because `analysisJournal.ts` and its exports do not exist.

- [ ] **Step 3: Export the existing subtitle validator and implement the journal module**

Change `isSubtitle` in `analysisCheckpoint.ts` from private to exported without altering its predicate. Implement these exact shapes:

```ts
export interface AnalysisInflightEntry {
  cueOffset: number;
  subtitle: Subtitle;
}

export interface AnalysisInflightJournal {
  version: 1;
  journalId: string;
  transcriptGeneration: string;
  transcriptFingerprint: string;
  analysisStyle: TranslationStyle;
  baseRevision: number;
  startCueOffset: number;
  endCueOffset: number;
  entries: AnalysisInflightEntry[];
}

export interface JournalSessionContext {
  transcriptGeneration: string;
  transcriptFingerprint: string;
  analysisStyle: TranslationStyle;
  baseRevision: number;
  nextCueOffset: number;
  cueCount: number;
}
```

The parser must require `version === 1`, non-empty identity strings, a known `TranslationStyle`, non-negative integer offsets/revision, `start < end <= cueCount` when checked against a session, no more than 50 entries, unique offsets inside the batch, and every `subtitle` passing `isSubtitle`.

`mergeInflightEntries` must return entries sorted by `cueOffset`; an identical duplicate is idempotent, while a changed subtitle for an existing offset throws `TypeError("analysis inflight entry rewrite rejected")`.

- [ ] **Step 4: Run journal and checkpoint tests**

Run: `pnpm vitest run src/llm/analysisJournal.test.ts src/llm/analysisCheckpoint.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the domain contract**

```bash
git add src/llm/analysisJournal.ts src/llm/analysisJournal.test.ts src/llm/analysisCheckpoint.ts
git commit -m "feat(analysis): define inflight journal contract"
```

---

### Task 2: Rust Journal Files and Validation

**Files:**
- Modify: `src-tauri/src/commands/analysis_store.rs`

**Interfaces:**
- Consumes: the existing `write_json_atomically_with_replacer` and `replace_analysis_file` helpers.
- Produces:
  - `AnalysisInflightJournal` and `AnalysisInflightEntry` serialized in camelCase.
  - `inflight_path(analysis_path: &Path) -> PathBuf`
  - best-effort journal loading and cleanup helpers.

- [ ] **Step 1: Write failing Rust file-contract tests**

Add `TestDir::inflight_path()` and tests for a valid round trip, duplicate/out-of-range offsets, file-size rejection, entry-size rejection, and atomic replacement failure preserving the previous journal:

```rust
#[test]
fn inflight_replacement_failure_preserves_previous_file() {
    let dir = TestDir::new("inflight-replace-failure");
    let path = dir.inflight_path();
    let old = journal("j1", 0, vec![entry(0, "old")]);
    write_inflight_at_with_replacer(&path, &old, replace_analysis_file).unwrap();

    let result = write_inflight_at_with_replacer(
        &path,
        &journal("j1", 0, vec![entry(0, "old"), entry(1, "new")]),
        |_temporary, _destination| Err(std::io::Error::other("replace failed")),
    );

    assert!(result.is_err());
    assert_eq!(read_inflight_strict(&path).unwrap(), old);
}
```

- [ ] **Step 2: Run the focused Rust tests and confirm failure**

Run from `src-tauri`: `cargo test commands::analysis_store::tests::inflight -- --nocapture`

Expected: FAIL because journal structs and helpers are not defined.

- [ ] **Step 3: Implement bounded journal storage**

Add these constants and serde types near the existing session structs:

```rust
const INFLIGHT_VERSION: u8 = 1;
const MAX_INFLIGHT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_INFLIGHT_ENTRIES: usize = 50;
const MAX_INFLIGHT_ENTRY_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisInflightEntry {
    pub cue_offset: usize,
    pub subtitle: Value,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisInflightJournal {
    pub version: u8,
    pub journal_id: String,
    pub transcript_generation: String,
    pub transcript_fingerprint: String,
    pub analysis_style: String,
    pub base_revision: u64,
    pub start_cue_offset: usize,
    pub end_cue_offset: usize,
    pub entries: Vec<AnalysisInflightEntry>,
}
```

Validate non-empty identity fields, known styles (`formal`, `neutral`, `colloquial`, `playful`, `cinematic`, `literary`), `start < end`, batch span and entries no greater than 50, unique in-range offsets, object subtitles, and serialized entry size. `load_inflight_best_effort` must check metadata length before reading; malformed/oversized journals are logged with `eprintln!`, ignored, and removed best-effort.

Use `analysis.inflight.json`, `analysis.inflight.json.tmp`, and `analysis.inflight.json.bak`. Reuse the existing atomic writer so Windows `ReplaceFileW` behavior remains identical to `analysis.json`.

`load_inflight_best_effort` reads only the published main file. Temporary and backup files are cleanup artifacts, not independently published entries: if the process died before replacement returned, the latest write was never acknowledged as durable. Invalid main files trigger best-effort removal of all three journal artifacts.

- [ ] **Step 4: Run all analysis-store tests**

Run from `src-tauri`: `cargo test commands::analysis_store -- --nocapture`

Expected: PASS, including the new file-contract cases.

- [ ] **Step 5: Commit bounded storage**

```bash
git add src-tauri/src/commands/analysis_store.rs
git commit -m "feat(analysis): persist bounded inflight journals"
```

---

### Task 3: Rust Lease Ownership and Tauri Commands

**Files:**
- Modify: `src-tauri/src/commands/analysis_store.rs`
- Modify: `src-tauri/src/commands/analysis.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `AnalysisInflightJournal` from Task 2.
- Produces:
  - `save_analysis_inflight(video_id, lease, journal) -> SessionSaveOutcome`
  - `discard_analysis_inflight(video_id, lease, journal_id) -> SessionSaveOutcome`
  - `AnalysisSessionStart.inflight`
  - begin commands accepting `analysisStyle`; generic begin also accepts caller-generated `transcriptGeneration`.

- [ ] **Step 1: Add failing lease and crash-window tests**

Cover all of these independently:

```rust
#[test]
fn inflight_save_requires_current_lease_and_monotonic_entries() {
    let dir = TestDir::new("inflight-lease");
    let path = dir.analysis_path();
    let mut store = AnalysisStore::default();
    let session = store
        .begin_at("v1", &path, false, "sha256:raw", false, "neutral")
        .unwrap();
    store
        .save_at("v1", &path, &session.lease, checkpointed("sha256:semantic", 0, "base"))
        .unwrap();

    let one = journal("j1", 0, vec![entry(0, "first")]);
    assert_eq!(store.save_inflight_at("v1", &path, "wrong", one.clone()).unwrap().status,
        SessionSaveStatus::Rejected);
    assert_eq!(store.save_inflight_at("v1", &path, &session.lease, one).unwrap().status,
        SessionSaveStatus::Applied);
    assert_eq!(store.save_inflight_at(
        "v1", &path, &session.lease,
        journal("j1", 0, vec![entry(0, "first"), entry(1, "second")]),
    ).unwrap().status, SessionSaveStatus::Applied);
    assert_eq!(store.save_inflight_at(
        "v1", &path, &session.lease,
        journal("j1", 0, vec![entry(0, "changed"), entry(1, "second")]),
    ).unwrap().status, SessionSaveStatus::Rejected);
}

#[test]
fn canonical_advance_makes_leftover_inflight_stale() {
    let dir = TestDir::new("inflight-after-commit");
    let path = dir.analysis_path();
    let mut store = seeded_store_with_inflight(&path, "v1", "j1");
    let lease = store.active["v1"].token.clone();
    let outcome = store.save_at_with_inflight_remover(
        "v1", &path, &lease,
        checkpointed_at("sha256:semantic", 1, 50),
        |_path| Err(std::io::Error::other("journal busy")),
    ).unwrap();
    assert_eq!(outcome.status, SessionSaveStatus::Applied);

    let mut restarted = AnalysisStore::default();
    let opened = restarted
        .begin_at("v1", &path, false, "sha256:raw", false, "neutral")
        .unwrap();
    assert!(opened.inflight.is_none());
}

#[test]
fn new_store_adopts_matching_inflight_with_a_new_lease() {
    let dir = TestDir::new("inflight-restart");
    let path = dir.analysis_path();
    let original = seed_analysis_and_inflight(&path, "j1");
    let mut restarted = AnalysisStore::default();
    let opened = restarted
        .begin_at("v1", &path, false, "sha256:raw", false, "neutral")
        .unwrap();
    assert_ne!(opened.lease, original.lease);
    assert_eq!(opened.inflight.as_ref().map(|j| j.journal_id.as_str()), Some("j1"));
}

#[test]
fn reset_removes_inflight_and_rejects_the_old_lease() {
    let dir = TestDir::new("inflight-reset");
    let path = dir.analysis_path();
    let mut store = seeded_store_with_inflight(&path, "v1", "j1");
    let old_lease = store.active["v1"].token.clone();
    let fresh = store
        .begin_at("v1", &path, true, "sha256:new", false, "neutral")
        .unwrap();
    assert!(!inflight_path(&path).exists());
    assert_eq!(store.save_inflight_at(
        "v1", &path, &old_lease, journal("late", 0, vec![entry(0, "late")]),
    ).unwrap().status, SessionSaveStatus::Rejected);
    assert_ne!(fresh.lease, old_lease);
}
```

Add the named test helpers (`checkpointed_at`, `seed_analysis_and_inflight`, and `seeded_store_with_inflight`) beside the existing `checkpointed` helper; each helper writes a valid revision-0 canonical snapshot whose fingerprint/style/generation matches `journal(...)`.

The canonical-advance test must inject a journal remover that fails after `analysis.json` succeeds and assert the canonical `SessionSaveStatus::Applied` remains unchanged.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run from `src-tauri`: `cargo test commands::analysis_store::tests::inflight_save -- --nocapture`

Expected: FAIL because leases do not own journals yet.

- [ ] **Step 3: Extend active leases and session start**

Add to `ActiveLease`:

```rust
transcript_generation: String,
verify_transcript_path: bool,
analysis_style: String,
inflight: Option<AnalysisInflightJournal>,
```

Extend `CheckpointMeta` with `next_cue_offset` and `phase`. For generic `begin_analysis_session`, the frontend supplies a semantic transcript generation and `verify_transcript_path` is false. For `begin_analysis_session_from_transcript`, Rust computes the raw-file generation and verifies it again before every canonical or journal save.

Update existing Rust tests mechanically to pass `"sha256:test"`, `false`, and `"colloquial"` to `begin_at`; pass `"colloquial"` as the new final argument to `begin_for_transcript_at`. Tests specifically exercising transcript replacement continue using the generation computed from their fixture transcript.

`AnalysisSessionStart` returns `inflight: Option<AnalysisInflightJournal>`. During begin:

1. load canonical analysis;
2. load journal best-effort;
3. discard it if style/generation/canonical fingerprint/base revision/start offset disagree;
4. treat `canonical.nextCueOffset >= journal.endCueOffset` as an already-committed stale file;
5. bind an accepted journal to the new lease.

`save_inflight_at` must require current lease, exact generation/style/fingerprint/base revision/start offset, fixed journal ID, and a monotonic superset of active entries. Identical retries return `AlreadyCurrent`.

- [ ] **Step 4: Add and register Tauri wrappers**

Add commands with camelCase-compatible arguments:

```rust
#[tauri::command]
pub fn save_analysis_inflight(
    video_id: String,
    lease: String,
    journal: AnalysisInflightJournal,
) -> AppResult<SessionSaveOutcome> {
    crate::commands::analysis_store::save_inflight(&video_id, &lease, journal)
}

#[tauri::command]
pub fn discard_analysis_inflight(
    video_id: String,
    lease: String,
    journal_id: String,
) -> AppResult<SessionSaveOutcome> {
    crate::commands::analysis_store::discard_inflight(&video_id, &lease, &journal_id)
}
```

Register both immediately after `save_analysis_session` in `src-tauri/src/lib.rs`.

Canonical save must clear `active.inflight` after a checkpoint passes its end offset and attempt physical deletion without converting an applied canonical save into an error.

- [ ] **Step 5: Run Rust tests and build**

Run from `src-tauri`:

```bash
cargo test commands::analysis_store -- --nocapture
cargo build
```

Expected: all analysis-store tests PASS and the Tauri command registry builds.

- [ ] **Step 6: Commit lease integration**

```bash
git add src-tauri/src/commands/analysis_store.rs src-tauri/src/commands/analysis.rs src-tauri/src/lib.rs
git commit -m "feat(analysis): bind inflight journals to leases"
```

---

### Task 4: Frontend Persisted Session Transport

**Files:**
- Modify: `src/llm/analysisSession.ts`
- Modify: `src/llm/analysisSession.test.ts`
- Modify: `src/pages/Player.tsx`
- Modify: `src/store/backgroundAnalyses.ts`
- Modify: `src/store/importQueue.ts`

**Interfaces:**
- Consumes: journal domain from Task 1 and Rust commands from Task 3.
- Produces this extended session interface:

```ts
export interface PersistedAnalysisSession {
  readonly videoId: string;
  readonly lease: string;
  readonly analysis: CheckpointedAnalysis;
  readonly inflight: AnalysisInflightJournal | null;
  save(next: CheckpointedAnalysis): Promise<CheckpointedAnalysis>;
  saveInflight(next: AnalysisInflightJournal): Promise<AnalysisInflightJournal>;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write failing session transport tests**

Add tests proving:

```ts
it("adopts a matching journal and saves monotonic updates with the lease", async () => {
  const stored = await openStoredAnalysisSession("v1", { style: "neutral" });
  expect(stored?.session.inflight?.entries).toHaveLength(2);

  await stored!.session.saveInflight(nextJournal);
  expect(mockInvoke).toHaveBeenCalledWith("save_analysis_inflight", {
    videoId: "v1",
    lease: "lease-1",
    journal: nextJournal,
  });
});

it("discards a semantically mismatched journal before exposing the session", async () => {
  const stored = await openStoredAnalysisSession("v1", { style: "neutral" });
  expect(stored?.session.inflight).toBeNull();
  expect(mockInvoke).toHaveBeenCalledWith("discard_analysis_inflight", {
    videoId: "v1",
    lease: "lease-1",
    journalId: "stale-journal",
  });
});
```

Also test that `save()` and `saveInflight()` share one promise tail, `close()` waits for an inflight write already started, and a rejected outcome throws `StaleAnalysisSessionError`.

- [ ] **Step 2: Run the session tests and confirm failure**

Run: `pnpm vitest run src/llm/analysisSession.test.ts`

Expected: FAIL because session start has no journal transport.

- [ ] **Step 3: Extend open signatures and session state**

Use these exact signatures:

```ts
export interface OpenStoredAnalysisSessionOptions {
  reset?: boolean;
  style: TranslationStyle;
}

export async function openStoredAnalysisSession(
  videoId: string,
  options: OpenStoredAnalysisSessionOptions,
): Promise<StoredAnalysisSession | null>;

export async function openAnalysisSession(
  videoId: string,
  cues: readonly SrtCue[],
  style: TranslationStyle = "colloquial",
): Promise<PersistedAnalysisSession>;
```

Generic open computes `fingerprintTranscript(cues)` and sends it as its caller-generated `transcriptGeneration`. Stored open passes style to Rust and uses Rust's raw transcript generation.

After `prepareAnalysis`, parse and check `started.inflight` against generation, prepared fingerprint, style, revision, offset, and cue count. If it fails semantic validation, invoke `discard_analysis_inflight` before returning a session with `inflight: null`.

Serialize canonical and journal saves through the existing `saveTail`. When canonical `nextCueOffset >= inflight.endCueOffset`, set local `inflight` to null because Rust already regards it as committed.

- [ ] **Step 4: Update every production open call with the correct style**

Use:

```ts
openStoredAnalysisSession(videoId, { style: entry?.analysisStyle ?? "colloquial" })
openStoredAnalysisSession(runtime.videoId, { reset: true, style: runtime.style })
openStoredAnalysisSession(runtime.videoId, { style: runtime.style })
openStoredAnalysisSession(videoId, { style: "neutral" }) // importQueue
```

Do not default production calls silently; the persisted journal must be bound to the same prompt style used by analysis.

- [ ] **Step 5: Run session, player, background, and type tests**

Run:

```bash
pnpm vitest run src/llm/analysisSession.test.ts src/pages/Player.analysisResume.test.tsx src/store/backgroundAnalyses.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit session transport**

```bash
git add src/llm/analysisSession.ts src/llm/analysisSession.test.ts src/pages/Player.tsx src/store/backgroundAnalyses.ts src/store/importQueue.ts
git commit -m "feat(analysis): expose durable inflight sessions"
```

---

### Task 5: Cue-Offset Streaming and Awaited Preview Persistence

**Files:**
- Modify: `src/llm/analyze.ts`
- Modify: `src/llm/analyze.test.ts`

**Interfaces:**
- Consumes: `AnalysisInflightEntry` from Task 1.
- Produces an `AnalysisPreview` containing ordered entries and an async-capable preview callback:

```ts
export interface AnalysisPreview {
  startCueOffset: number;
  endCueOffset: number;
  entries: AnalysisInflightEntry[];
  subtitles: Subtitle[];
}

onPreview?: (preview: AnalysisPreview | null) => void | Promise<void>;
resumePreview?: AnalysisPreview | null;
```

- [ ] **Step 1: Add failing streaming-order tests**

Add tests for these exact behaviors:

```ts
it("awaits preview persistence before consuming the next provider chunk", async () => {
  const persisted = deferred<void>();
  const calls: string[] = [];
  await runAnalysis({
    ...options,
    onPreview: async (preview) => {
      if (!preview) return;
      calls.push(`save:${preview.entries.length}`);
      await persisted.promise;
      calls.push(`visible:${preview.entries.length}`);
    },
  });
  // Release the deferred from the test after asserting no second chunk was consumed.
});

it("requests only missing offsets from a 23-entry resumed batch", async () => {
  await runAnalysis({ ...optionsFor50, resumePreview: previewWithOffsets(0, 23) });
  expect(providerPrompt()).not.toContain('"index":1');
  expect(commits[0].subtitles).toHaveLength(50);
});

it("maps duplicate source indexes to distinct cue offsets", async () => {
  expect(previews.at(-1)?.entries.map((entry) => entry.cueOffset)).toEqual([0, 1]);
});
```

Also assert abort during an already-started async preview waits for that callback, while results not yet persisted are never emitted.

- [ ] **Step 2: Run analyze tests and confirm failure**

Run: `pnpm vitest run src/llm/analyze.test.ts`

Expected: FAIL because preview callbacks are synchronous and keyed by request index.

- [ ] **Step 3: Replace index-keyed resolution with offset-keyed resolution**

Introduce an internal request shape:

```ts
interface RequestedCue {
  cueOffset: number;
  cue: SrtCue; // cue.index is made unique only for the model protocol
}
```

Map `validateCueOutput(...).index` back through the request map to `cueOffset`, then store `Map<number, Subtitle>` keyed by offset. `unresolvedCueIndexes` remains the model-facing unique indexes for diagnostics, but journal entries and ordering always use offsets.

Seed the map only when `resumePreview.startCueOffset` and `endCueOffset` match the current batch. A mismatched preview is a programmer error and throws before calling the provider.

- [ ] **Step 4: Drain parser results through an awaited cumulative preview**

Parser callbacks collect newly validated entries synchronously. After every `parser.feed(chunk, ...)` and after `parser.flush(...)`, call an async drain function:

```ts
const publishResolved = async () => {
  if (!dirty) return;
  dirty = false;
  const entries = orderedResolvedEntries(requestBatch, resolved);
  await opts.onPreview?.({
    startCueOffset,
    endCueOffset,
    entries,
    subtitles: entries.map((entry) => entry.subtitle),
  });
};
```

Do not pass the abort signal into the persistence callback. If abort happens while it is awaiting, let the write finish, then `throwIfAborted` before reading another provider chunk.

Every existing `opts.onPreview?.(null)` call must also become `await opts.onPreview?.(null)` so rollback/reprojection cannot race an outstanding journal save.

- [ ] **Step 5: Run analyze tests and typecheck**

Run:

```bash
pnpm vitest run src/llm/analyze.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit durable streaming semantics**

```bash
git add src/llm/analyze.ts src/llm/analyze.test.ts
git commit -m "feat(analysis): await durable cue previews"
```

---

### Task 6: Connect Streaming Previews to Session Journals

**Files:**
- Modify: `src/llm/analysisSession.ts`
- Modify: `src/llm/analysisSession.test.ts`

**Interfaces:**
- Consumes: `resumePreview`/async `onPreview` from Task 5 and `session.saveInflight` from Task 4.
- Produces: `executeAnalysisSession` that persists before calling UI preview callbacks.

- [ ] **Step 1: Add failing end-to-end session tests**

Test the real ordering across the mocked Tauri boundary:

```ts
it("saves inflight before publishing a preview", async () => {
  const order: string[] = [];
  mockInvoke.mockImplementation(async (command) => {
    if (command === "save_analysis_inflight") order.push("disk");
    return successfulCommandResult(command);
  });

  await executeAnalysisSession({
    ...options,
    onPreview: () => order.push("ui"),
  });

  expect(order.indexOf("disk")).toBeLessThan(order.indexOf("ui"));
});

it("reuses 23 durable entries and commits all 50 once", async () => {
  expect(providerRequestedCueCount).toBe(27);
  expect(savedCanonical.checkpoint.nextCueOffset).toBe(50);
  expect(savedCanonical.subtitles).toHaveLength(50);
});
```

- [ ] **Step 2: Run session tests and confirm failure**

Run: `pnpm vitest run src/llm/analysisSession.test.ts`

Expected: FAIL because `executeAnalysisSession` does not persist previews.

- [ ] **Step 3: Build and save cumulative journals in `executeAnalysisSession`**

Convert `session.inflight` to `resumePreview` for `runAnalysis`. For every non-null preview:

1. create a journal with `crypto.randomUUID()` when this batch has no journal;
2. merge preview entries monotonically;
3. `await session.saveInflight(journal)`;
4. call `options.onPreview(committed, durablePreview)` only after success.

The journal uses `session.transcriptGeneration`, committed fingerprint/revision, current style, and preview batch boundaries. Extend the public session with a readonly `transcriptGeneration` field so this construction never relies on UI state.

After `onCommit`, canonical `save()` clears the local journal when the checkpoint crosses its end. Then publish `onCommitted` and `onPreview(committed, null)` in the existing order.

Treat a null preview from `runAnalysis` as “reproject current durable state,” not “erase the journal”: if `session.inflight` still exists after an abort or failed canonical save, convert it back to an `AnalysisPreview` and pass that to the UI callback. Only canonical advancement, explicit discard, or destructive reset may produce a truly empty preview.

- [ ] **Step 4: Run analysis session and streaming tests**

Run:

```bash
pnpm vitest run src/llm/analysisSession.test.ts src/llm/analyze.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the connection layer**

```bash
git add src/llm/analysisSession.ts src/llm/analysisSession.test.ts
git commit -m "feat(analysis): journal streaming session progress"
```

---

### Task 7: Foreground and Background Durable Progress UI

**Files:**
- Modify: `src/store/analysis.ts`
- Create: `src/store/analysis.test.ts`
- Modify: `src/pages/Player.tsx`
- Modify: `src/pages/Player.analysisResume.test.tsx`
- Modify: `src/store/backgroundAnalyses.ts`
- Modify: `src/store/backgroundAnalyses.test.ts`
- Modify: `src/components/ProgressBanner.tsx`
- Modify: `src/components/ProgressBanner.test.tsx`
- Modify: `src/components/DownloadQueueWidget.tsx`
- Modify: `src/components/DownloadQueueWidget.test.tsx`

**Interfaces:**
- Consumes: durable `AnalysisPreview.entries`.
- Produces explicit UI counts:

```ts
committedCueOffset: number;
inflightCueCount: number;
inflightBatchSize: number;
```

- [ ] **Step 1: Write failing store and component tests**

Assert:

```ts
expect(useAnalysis.getState()).toMatchObject({
  committedCueOffset: 50,
  inflightCueCount: 23,
  inflightBatchSize: 50,
  progressPercent: 73,
});

expect(screen.getByText(/正式完成 50 条/)).toBeInTheDocument();
expect(screen.getByText(/本批已保存 23\/50 条/)).toBeInTheDocument();
expect(screen.getByRole("button", { name: "暂停解析" })).toBeInTheDocument();
```

For the background queue, assert percent and “已保存” use `committedCueOffset + inflightCueCount`, not only the canonical offset.

- [ ] **Step 2: Run focused UI tests and confirm failure**

Run:

```bash
pnpm vitest run src/components/ProgressBanner.test.tsx src/components/DownloadQueueWidget.test.tsx src/store/backgroundAnalyses.test.ts src/pages/Player.analysisResume.test.tsx
```

Expected: FAIL with missing inflight count fields and old “停止解析” copy.

- [ ] **Step 3: Extend Zustand progress state**

`setCommittedAnalysis` sets `committedCueOffset` from the checkpoint and both inflight values to zero. `setAnalysisPreview` sets:

```ts
const inflightCueCount = preview?.entries.length ?? 0;
const inflightBatchSize = preview
  ? preview.endCueOffset - preview.startCueOffset
  : 0;
const durableCueCount = committed.checkpoint.nextCueOffset + inflightCueCount;
```

Use `durableCueCount / totalCues` for `progressPercent`. Do not derive durability from deduplicated subtitle array length.

- [ ] **Step 4: Preserve durable preview during pause and ownership transfer**

Replace foreground rollback-to-canonical behavior with a projection of `session.inflight`. On stop/navigation, the UI may clear only results not represented by `session.inflight`; it must continue showing durable entries.

Background jobs receive `inflightCueCount` and `inflightBatchSize` from previews. `publishAnalysis` resets them only after canonical commit. Takeover returns canonical analysis plus the current durable journal projection.

Extend the takeover shape explicitly:

```ts
export interface BackgroundTakeover {
  session: PersistedAnalysisSession;
  cues: SrtCue[];
  analysis: CheckpointedAnalysis;
  inflightPreview: AnalysisPreview | null;
  errorMessage: string | null;
  quotaError: QuotaExhaustedDetails | null;
}
```

On foreground takeover, call `setCommittedAnalysis` first and then `setAnalysisPreview` with `inflightPreview` when non-null. Initial background publication must project `session.inflight` immediately, so moving a 23-entry foreground batch to the background never makes the visible count fall back to the canonical checkpoint.

Quota recovery messages receive `committedCueOffset + inflightCueCount` as the saved count while retaining the existing structured error shape.

- [ ] **Step 5: Update copy and progress calculations**

Use:

- active button: `暂停解析`
- active/paused text when inflight exists: `正式完成 N 条 · 本批已保存 M/K 条`
- paused fallback when no inflight exists: existing “已生成 N 行字幕” semantics
- background row: `已保存 {committed + inflight}/{total} 条`

- [ ] **Step 6: Run UI tests and typecheck**

Run:

```bash
pnpm vitest run src/components/ProgressBanner.test.tsx src/components/DownloadQueueWidget.test.tsx src/store/backgroundAnalyses.test.ts src/pages/Player.analysisResume.test.tsx
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit UI integration**

```bash
git add src/store/analysis.ts src/store/analysis.test.ts src/pages/Player.tsx src/pages/Player.analysisResume.test.tsx src/store/backgroundAnalyses.ts src/store/backgroundAnalyses.test.ts src/components/ProgressBanner.tsx src/components/ProgressBanner.test.tsx src/components/DownloadQueueWidget.tsx src/components/DownloadQueueWidget.test.tsx
git commit -m "feat(analysis): show durable partial-batch progress"
```

If `src/store/analysis.test.ts` did not exist before Task 7, include the newly created file; otherwise the same command stages its modification.

---

### Task 8: Destructive Cleanup, Recovery Matrix, and Documentation

**Files:**
- Modify: `src-tauri/src/commands/analysis_store.rs`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: journal artifact helpers and the existing destructive boundary.
- Produces: complete invalidation behavior for reset, retranscription, delete, and materialized replacement.

- [ ] **Step 1: Add failing destructive-path tests**

Add exact cases to `analysis_store.rs` tests:

```rust
#[test]
fn delete_snapshot_removes_analysis_and_inflight_artifacts() {
    let dir = TestDir::new("delete-all-analysis-artifacts");
    let analysis_path = dir.analysis_path();
    let mut store = AnalysisStore::default();
    for path in all_analysis_artifacts(&analysis_path) {
        fs::write(&path, b"stale").unwrap();
    }

    store
        .delete_snapshot_at_with("v1", &analysis_path, fs::remove_file)
        .unwrap();

    assert!(all_analysis_artifacts(&analysis_path)
        .into_iter()
        .all(|path| !path.exists()));
}

#[test]
fn successful_materialized_replacement_removes_old_inflight() {
    let dir = TestDir::new("replace-clears-inflight");
    let analysis_path = dir.analysis_path();
    let transcript_path = dir.transcript_path();
    fs::write(&transcript_path, "old transcript").unwrap();
    seed_analysis_and_inflight(&analysis_path, "j-old");
    let mut store = AnalysisStore::default();

    replace_materialized_snapshot_at(
        &mut store,
        "v1",
        &transcript_path,
        &analysis_path,
        "new transcript",
        checkpointed_at("sha256:new", 4, 100),
    ).unwrap();

    assert_eq!(fs::read_to_string(&transcript_path).unwrap(), "new transcript");
    assert!(!inflight_path(&analysis_path).exists());
}

#[test]
fn failed_materialized_replacement_keeps_matching_old_inflight() {
    let dir = TestDir::new("replace-rollback-keeps-inflight");
    let analysis_path = dir.analysis_path();
    let transcript_path = dir.transcript_path();
    fs::write(&transcript_path, "old transcript").unwrap();
    seed_analysis_and_inflight(&analysis_path, "j-old");
    let old_journal = read_inflight_strict(&inflight_path(&analysis_path)).unwrap();
    let mut store = AnalysisStore::default();

    let result = replace_materialized_snapshot_at_with(
        &mut store,
        "v1",
        &transcript_path,
        &analysis_path,
        "new transcript",
        checkpointed_at("sha256:new", 4, 100),
        |_from, _to| Err(std::io::Error::other("install failed")),
    );

    assert!(result.is_err());
    assert_eq!(fs::read_to_string(&transcript_path).unwrap(), "old transcript");
    assert_eq!(read_inflight_strict(&inflight_path(&analysis_path)).unwrap(), old_journal);
}

#[test]
fn changed_transcript_generation_never_adopts_old_inflight() {
    let dir = TestDir::new("generation-rejects-inflight");
    let analysis_path = dir.analysis_path();
    let transcript_path = dir.transcript_path();
    fs::write(&transcript_path, "new transcript").unwrap();
    seed_analysis_and_inflight(&analysis_path, "j-old");
    let mut store = AnalysisStore::default();

    let opened = store
        .begin_for_transcript_at(
            "v1", &transcript_path, &analysis_path, false, None, "neutral",
        ).unwrap().unwrap();

    assert!(opened.session.inflight.is_none());
}
```

Add `replace_materialized_snapshot_at_with` as the injected-operation form used by the failure test; the production `replace_materialized_snapshot_at` delegates to it with `fs::rename`. Journal deletion runs only after both production renames have committed.

- [ ] **Step 2: Run destructive-path tests and confirm failure**

Run from `src-tauri`: `cargo test commands::analysis_store::tests -- --nocapture`

Expected: at least the journal cleanup tests FAIL.

- [ ] **Step 3: Extend artifact cleanup under the existing boundary**

`remove_snapshot_artifacts` and `delete_snapshot_at_with` remove both canonical and journal artifacts for explicit reset/delete. Retranscription invokes that same invalidation after revoking the lease.

For `replace_materialized_snapshot_at`, preserve the old journal until the new transcript and analysis are both committed. After successful publication, remove old journal artifacts best-effort. If installation fails and rollback restores the old transcript/analysis pair, do not delete its still-matching journal.

- [ ] **Step 4: Document recovery semantics**

Add a `CLAUDE.md` section stating:

- 50 cues remain the canonical transaction size;
- `analysis.inflight.json` is local-only and bounded;
- UI preview means disk-persisted;
- commit-before-cleanup handles process death;
- destructive operations must use the analysis-store boundary;
- summary restarts as one request.

- [ ] **Step 5: Run the full verification gate**

Run:

```bash
pnpm typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml
```

Expected: TypeScript typecheck PASS, all Vitest tests PASS, all Rust tests PASS, and Rust build PASS with no warnings introduced by this feature.

- [ ] **Step 6: Commit cleanup and docs**

```bash
git add src-tauri/src/commands/analysis_store.rs CLAUDE.md
git commit -m "fix(analysis): harden inflight recovery boundaries"
```
