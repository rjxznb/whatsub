# Streaming Analysis Recovery Design

## Background

The current analysis transaction sends up to 50 subtitle cues to the selected
LLM. The provider still streams JSON Lines, but the frontend buffers every
parsed cue until the whole request finishes and the batch is atomically saved.
This protects the durable checkpoint, but it also makes the UI update in groups
of 50 rather than cue by cue.

The transaction currently treats any malformed non-empty JSON line as a
non-retryable `ProviderProtocolError`. One malformed model-generated line
therefore rejects the entire batch even when the other 49 results are valid.
The previous parser silently skipped malformed lines, which hid the error but
could permanently omit subtitles.

LLM output cannot be trusted as structurally or semantically perfect. The
application must distinguish authoritative local data from generated data,
validate generated fields independently, and repair only unresolved cues.

## Goals

1. Restore cue-by-cue visible streaming without weakening the durable
   checkpoint and lease guarantees.
2. Keep the existing default input batch size of 50 and avoid one API request
   per cue.
3. Isolate malformed or missing output to the affected cue rather than failing
   or repeating the whole batch.
4. Re-request only unresolved cues, including after a mid-stream transport
   interruption.
5. Guarantee that source text, timestamps, cue identity, persistence ordering,
   and highlight relationships come from deterministic local validation.
6. Never silently advance `nextCueOffset` past a cue that has no valid
   translation.
7. Preserve restart behavior: a hard process termination loses at most the
   current uncommitted input batch and never reruns Whisper when the matching
   transcript exists.

## Non-goals

- Do not claim that an LLM translation is linguistically perfect. The
  application can validate structure and relationships, not prove translation
  quality.
- Do not persist individual preview cues or add a second partial-output file.
- Do not change the Whisper pipeline, lease coordinator, atomic file
  replacement, or checkpoint format.
- Do not reduce the normal provider request to one cue per request.
- Do not heuristically invent or repair malformed translation text.
- Do not trigger release or CI as part of implementation.

## Authoritative and generated fields

The LLM no longer echoes fields the application already owns. Each
per-cue response uses a compact contract:

```json
{"index":54,"translation":"……","isKeyPoint":false,"highlights":[{"source":"stack questions","translation":"堆栈问题","note":"……"}]}
```

The final `Subtitle` is assembled locally:

- `index` selects an input cue and must belong to the current request.
- `time`, `endTime`, and `text` always come from that input `SrtCue`.
- `translation`, `isKeyPoint`, and highlight annotations are generated.
- `highlightWords`, `keyNotes`, and `highlightTranslations` are derived locally
  from validated `highlights`; the provider no longer has to maintain three
  parallel structures with identical keys.

This reduces duplicated output and removes the possibility that model-echoed
source text or timestamps overwrite the transcript.

## Per-cue validation

Validation is independent for each parsed object:

1. The object must contain an integer `index` requested by the current
   attempt.
2. A cue index may resolve only once in a batch. Later duplicates are ignored.
3. `translation` must be a non-empty string. Otherwise the cue remains
   unresolved.
4. Invalid or missing `isKeyPoint` becomes `false`; it does not invalidate the
   translation.
5. `highlights` must be an array. Invalid entries are discarded independently.
6. A highlight `source` must be an exact non-empty substring of the
   authoritative English cue.
7. A highlight `translation` must be an exact non-empty substring of the
   generated Chinese translation.
8. A highlight `note` must be a non-empty string. An invalid note removes only
   that highlight.
9. After invalid highlights are removed, `isKeyPoint` may remain true, but the
   resulting dictionaries are always structurally consistent.

Malformed JSON, markdown fences, and prose do not immediately fail the
request. They resolve no cue. At the end of the attempt, the requested indexes
without a valid result form the next repair request.

The parser must retain diagnostic information for malformed lines, including
the JSON parse error and a bounded escaped excerpt, without exposing API keys
or the full prompt.

## Batch and repair algorithm

One durable transaction still covers the contiguous input range
`[startCueOffset, endCueOffset)`, normally 50 cues.

1. Create an in-memory result map keyed by the authoritative cue index.
2. Request all unresolved cues in that range.
3. Parse complete JSON Lines as they arrive.
4. Validate each object. When a cue first becomes valid:
   - add it to the result map;
   - publish it as an ephemeral preview;
   - remove its index from the unresolved set.
5. If the stream completes with unresolved indexes, make the next request with
   only those cues.
6. If transport reading fails after some valid lines, retain those validated
   in-memory results and retry only the unresolved cues.
7. DeepSeek/managed DeepSeek keeps the existing maximum of four total attempts
   with cancellable backoff. Providers without the DeepSeek analysis retry
   profile keep their existing attempt policy.
8. When every input cue is resolved, order results by the original input
   range, build one candidate revision, save it through the existing analysis
   lease, and then publish the committed snapshot.
9. Only after Rust confirms the atomic save does `nextCueOffset` advance to
   `endCueOffset`.

If attempts are exhausted with unresolved cues, the transaction fails without
advancing the checkpoint. All preview cues from that uncommitted transaction
are removed, restoring the last durable snapshot. The error identifies the
unresolved cue count and indexes rather than displaying a raw full JSON line.

## Preview state

Preview state is explicitly separate from persisted analysis:

- The durable Zustand analysis remains the last Rust-confirmed
  `CheckpointedAnalysis`.
- A foreground or background runtime may overlay preview subtitles for its
  currently owned lease and batch.
- Preview updates never call `save_analysis_session`.
- Starting a repair attempt keeps already validated previews and removes only
  values that have not resolved.
- Cancellation, terminal failure, stale lease, reset, delete, cloud
  replacement, or component teardown clears the preview overlay.
- A successful batch save replaces the preview overlay with the committed
  snapshot in one visible update.
- Preview callbacks carry a batch/attempt identity so late callbacks from an
  obsolete request cannot update a newer runtime.

The player and background analysis widget derive their visible subtitle count
from `committed + current preview`, while progress and restart position remain
based only on `checkpoint.nextCueOffset`.

## Failure classification

The system distinguishes three layers:

1. **Transport/SSE failure**: request send, stream read, HTTP 408/429/5xx, or
   malformed provider transport framing. Follow the existing provider retry
   policy and retain already validated cue results in memory.
2. **Model-content failure**: malformed JSON Line, missing index, duplicate
   index, empty translation, or invalid generated fields. Resolve valid cues
   and re-request only unresolved cues.
3. **Application/persistence failure**: abort, stale lease, invalid durable
   checkpoint, or atomic save failure. Do not regenerate content under the old
   session; clear preview and preserve the previous durable revision.

Authentication, license, and quota errors remain immediately actionable and
must not be retried as malformed model output.

## Summary phase

The global key-phrase summary remains a separate transaction after all cue
batches are committed. A malformed model-generated summary is retryable under
the provider's analysis retry profile, but it never invalidates or resubmits
committed cue analysis. Summary output continues to be strictly schema
validated before `phase: "complete"` is saved.

## Compatibility

Existing `analysis.json` files and `AnalysisCheckpoint` version 1 remain
unchanged. Existing generated subtitle objects retain their current persisted
shape. Only the provider response contract and in-memory preview/repair flow
change.

The compact response prompt applies to all supported analysis providers. Retry
counts remain provider-specific. The deprecated callback API may expose valid
cues as previews, but durable production callers use the session API.

## Testing

Production changes require failing tests first for:

1. Valid cue lines are previewed before the provider stream ends.
2. A batch is persisted only after every input cue has a valid translation.
3. One malformed line among 50 re-requests only that cue.
4. An empty translation re-requests only that cue.
5. A mid-stream transport failure retains validated results and requests only
   unresolved indexes on the next attempt.
6. Duplicate and out-of-range indexes cannot replace another cue.
7. Source text and timestamps always come from the local `SrtCue`.
8. Invalid highlights are removed independently while a valid translation is
   retained.
9. Preview is cleared on cancellation, terminal exhaustion, stale lease, and
   session reset.
10. A successful save replaces preview with the committed snapshot without
    duplicate subtitles.
11. A hard kill before save resumes from the previous checkpoint; a hard kill
    after save resumes from the next batch.
12. Summary malformed output retries summary only.
13. Authentication/quota failures do not enter content-repair retries.
14. Foreground and background analysis present the same streaming and rollback
    behavior.

The final verification gate includes focused parser/analysis/session/store
tests, full frontend tests, typecheck, production frontend build, Rust tests,
Rust build, and a Tauri startup smoke.

## Acceptance criteria

- The UI normally displays each valid analyzed subtitle as it arrives.
- The default provider request still contains up to 50 unresolved cues.
- A malformed result for one cue never discards or regenerates other valid
  results from the same in-memory transaction.
- Missing or invalid translations are never silently skipped.
- The durable checkpoint advances only after every cue in the contiguous batch
  is resolved and atomically saved.
- Restart, cancellation, deletion, and stale-producer guarantees from the
  lease redesign remain intact.
- Users see a concise repair/retry status and actionable terminal error instead
  of a raw malformed JSON payload.
