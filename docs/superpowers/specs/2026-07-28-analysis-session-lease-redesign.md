# Analysis Session Lease Redesign

## Background

The current checkpoint branch uses a durable generation sidecar next to
`analysis.json`. It tracks generation, previous generation, revision, hashes,
deletion tombstones, and pending writes. This protects many already-modelled
crash windows, but it does not bind a producer to its identity when that
producer starts. A stale producer can therefore call the compatibility save
API after a delete and discover the new lifecycle too late.

Import cancellation has a related lifecycle race. `cancel_import` currently
signals a token and returns before the child process exits and before the old
working directory is cleaned. A replacement import can start during that
window, after which the old cleanup or unregister path can affect the new job.

## Goals

1. Bind every foreground or background analysis producer to an opaque lease at
   session start.
2. Reject every save from a revoked or superseded lease.
3. Keep exact input-offset checkpoints so process termination loses at most the
   uncommitted DeepSeek batch.
4. Preserve a complete old or new `analysis.json` across a crash; never expose
   partial JSON.
5. Make cancel completion mean the old subprocess and its cleanup have actually
   finished before a same-video replacement import may start.
6. Strictly validate persisted analysis before it is used for continuation.
7. Remove the durable generation/pending-write state machine rather than adding
   another compatibility layer to it.

## Non-goals

- Do not make the remote import queue restart-safe; its server contract still
  lacks video id, stage, and checkpoint fields.
- Do not preserve partial output from the currently streaming DeepSeek batch.
- Do not add a user-visible setting for checkpointing or leases.
- Do not trigger release or CI.

## Persistence model

### Runtime lease

Rust owns a process-local coordinator keyed by `videoId`. Starting an analysis
session returns an opaque lease token. Every subsequent save must include that
token. The coordinator accepts a save only when the token is still the active
lease for that video.

Deleting analysis, deleting the video, cancelling an import cleanup, or
explicitly starting a replacement analysis revokes the prior lease before any
destructive filesystem work begins. Late results from the old producer are
therefore rejected even when they arrive after a new import starts.

Leases are intentionally not persisted. After a process termination, no old
producer remains alive. The restarted application validates the durable
analysis file and obtains a fresh runtime lease before continuing.

### Revision and transcript identity

The checkpoint remains part of `analysis.json`:

```ts
type AnalysisCheckpoint = {
  version: 1;
  transcriptFingerprint: string;
  nextCueOffset: number;
  phase: "cues" | "summary" | "complete";
  revision: number;
};
```

Within one lease, Rust accepts only a higher revision for the same transcript
fingerprint. Byte- or semantic-identical repetition of the current revision is
an idempotent success. A lower revision, changed fingerprint, malformed
checkpoint, or different payload at an equal revision is rejected.

Starting a fresh analysis session for a changed transcript begins at revision
zero under a newly issued lease. This transition is explicit; an ordinary save
cannot change transcript identity.

### Atomic file replacement

`analysis.json` is written to a temporary file, flushed, and atomically moved
over the destination. A failed replacement retains the previous valid file and
removes the temporary file when safe. The generation sidecar, backup protocol,
content-hash reconciliation, and pending-write journal are removed.

After a hard process kill, disk therefore contains either the previous complete
revision or the next complete revision. Restart never needs to infer a commit
from two competing state files.

## Session API

The frontend uses one persisted session abstraction rather than individual
callers discovering generations during each save.

Conceptual commands:

```ts
beginAnalysisSession(videoId, mode): Promise<{
  lease: string;
  analysis: unknown | null;
}>;

saveAnalysisSession(videoId, lease, analysis): Promise<{
  status: "applied" | "alreadyCurrent" | "rejected";
  revision: number | null;
}>;

revokeAnalysisSessions(videoId): Promise<void>;
```

`mode` distinguishes continuation from an explicit reset. Continuation loads
and validates the existing file. Reset revokes the old lease and authorizes a
new revision-zero analysis. The lease is captured when the producer starts and
is passed through every commit; producers never look up the current lease at
save time.

The TypeScript session publishes a commit to Zustand/UI state only after Rust
confirms the corresponding atomic save. A rejected lease becomes a stale
session error and must not be silently rebound to the current session.

## Persisted-data validation

Continuation requires a strict parser, not generic JSON equivalence. It checks:

- `subtitles` and `keyPhrases` are arrays of valid domain objects;
- checkpoint version, phase, fingerprint, offset, and revision are valid;
- `nextCueOffset` is within the transcript;
- summary/complete phases have consumed all cues;
- the stored transcript fingerprint matches the current `transcript.srt`.

Legacy files without checkpoints remain readable and are migrated once using
the existing compatibility rule. Malformed checkpointed files are not resumed.
The UI reports that the saved analysis cannot be continued and offers explicit
fresh analysis; it does not silently skip cues.

## DeepSeek transaction boundary and restart behavior

One input cue batch is one transaction:

1. Read `[startCueOffset, endCueOffset)`.
2. Buffer streamed model output in memory.
3. Retry transient provider failures against exactly that input range.
4. After a complete valid stream, build the next checkpoint revision.
5. Atomically save through the session lease.
6. Publish the committed result to UI state.

If whatSub is killed during step 2 through 5, the batch is not considered
committed. On restart, the application reads the previous complete checkpoint,
opens a new lease, and repeats only that batch. Completed batches are never
resent.

If all cue batches are committed and summary generation is interrupted, restart
keeps every cue result and retries only the summary phase. Whisper is not rerun
when a complete matching transcript already exists.

## Import cancellation lifecycle

The import registry stores a unique job identity, cancellation token, and a
completion notification per video. Registration must not silently replace an
active same-video job.

`cancel_import` performs these steps:

1. Identify the exact active job.
2. Signal cancellation.
3. Wait for its sidecar process to exit.
4. Revoke analysis leases for that video.
5. Complete working-directory and library cleanup.
6. Remove the registry entry only if it still belongs to that job.
7. Return success.

Only after step 7 may the frontend start the same video again. A missing active
job remains an idempotent success, but the command must not claim that a known
job is complete while cleanup is still running.

Whole-video deletion similarly revokes leases in Rust before removing files.
Frontend caches are updated from the backend-confirmed result rather than being
the authority that makes a deletion safe.

## Error handling

- Revoked lease: stop the stale producer and reload current durable state.
- Invalid persisted checkpoint: do not resume; present explicit fresh-analysis
  recovery.
- Atomic replacement failure: preserve old analysis and publish nothing new.
- User cancellation: stop without provider retry and without committing the
  current batch.
- DeepSeek transient exhaustion: keep the last committed checkpoint and expose
  “继续解析”.
- Authentication, quota, protocol, and schema failures remain non-retryable.

## Migration

The new code reads existing `analysis.json` files. Existing
`analysis.generation.json`, `.tmp`, and `.bak` artifacts are inspected only by a
one-time migration/cleanup path:

1. Prefer a valid visible `analysis.json`.
2. Recover a valid temporary/backup file only when the visible file is absent
   or invalid and the candidate is unambiguous.
3. Remove obsolete sidecar artifacts after a valid file has been selected.
4. Never infer continuation from malformed or contradictory artifacts.

This migration is isolated from the steady-state save path.

## Testing

Required failing tests before production changes:

1. A producer started before deletion cannot save after deletion/reimport even
   when its first save occurs late.
2. A stale save cannot acquire or discover the replacement producer's lease.
3. A cancelled import does not return until cleanup completes.
4. Old-job unregister cannot remove a replacement job entry.
5. Same-video concurrent registration is rejected or serialized explicitly.
6. Hard kill before batch save resumes from the previous cue offset.
7. Hard kill after atomic save resumes from the next cue offset.
8. Summary interruption retries summary only.
9. Invalid checkpointed JSON is never accepted as an idempotent save/resume.
10. Lower/equal-conflicting revisions and changed fingerprints are rejected.
11. Legacy analysis migrates once and remains readable.
12. Foreground and background continuation never call retranscription or delete
    analysis implicitly.

The final gate includes focused frontend/Rust tests, full frontend tests,
typecheck, production build, Rust library tests/build, diff audit, and a Tauri
startup smoke. No real OTP, release, push, or CI is part of this design.

## Acceptance criteria

- A stale producer cannot write after any delete, cancel, reset, or replacement
  session boundary.
- Same-video reimport cannot begin until the prior cancelled job has exited and
  cleaned its files.
- A hard process kill loses at most one uncommitted DeepSeek batch.
- Restart continues by exact input offset and never by output count.
- Valid transcript means DeepSeek continuation does not rerun Whisper.
- Persisted malformed state fails closed with an explicit recovery action.
- The steady-state Rust persistence implementation no longer depends on the
  generation sidecar/pending-write state machine.
