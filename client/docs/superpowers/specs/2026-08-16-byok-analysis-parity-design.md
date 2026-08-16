# BYOK Analysis Parity Design

**Date:** 2026-08-16

## Problem

whatSub currently has three subtitle-analysis implementations with different
contracts:

- the managed mobile relay has the compact `{i,zh,p}` protocol, strict phrase
  quality rules, missing-index continuation, bounded retries, and durable
  per-cue checkpoints;
- desktop BYOK already has compact output, streaming per-cue journals, and
  missing-index retries, but still permits denser and longer annotations than
  the managed compact path;
- iOS BYOK still asks the model to echo complete cue objects, targets key points
  on 30–50% of cues, persists only complete 50-cue batches, and has no
  analysis-owned retry loop.

The user-visible result depends on which route was selected. The same model can
produce sparse, robust output through the relay but over-annotated or fragile
output through BYOK.

## Goals

- Give desktop BYOK, iOS BYOK, and managed compact analysis the same semantic
  output contract and recovery guarantees.
- Keep source text, indexes, and timestamps authoritative in the client or
  server; the model supplies only an index, translation, and optional phrase.
- Preserve every strictly validated cue and request only unresolved indexes.
- Retry only failures that can heal without user action.
- Keep 50 cues as the durable batch size and retain progressive display.
- Keep BYOK direct-to-provider. No user API key or BYOK subtitle content is
  routed through whatSub's server.

## Non-goals

- Do not change chat, roleplay, photo analysis, or agent-tool retry behavior.
- Do not change the managed-analysis HTTP/SSE wire protocol.
- Do not change subscription quota, queue capacity, worker count, or model
  routing.
- Do not make all server accounts compact as part of this work. Production
  compact rollout remains a separate configuration decision.
- Do not reduce the normal 50-cue batch size.

## Chosen architecture

Use a documented **compact-v1 behavior contract**, implemented natively in
TypeScript and Swift. A shared runtime package is rejected because the desktop,
iOS, and backend are separate repositories and Swift cannot consume the
TypeScript validator without introducing a new build/runtime dependency.

Each implementation must prove parity with the same fixture concepts:

1. source-owned identity is reconstructed locally;
2. only requested indexes are accepted;
3. a non-empty trimmed `zh` resolves the translation;
4. `p` contains zero or one `[expression, meaningZh, usage]` tuple;
5. expression is an exact source substring containing one to four words;
6. `meaningZh` is an exact substring of `zh`;
7. usage is 25–90 Unicode code points;
8. at most `min(10, ceil(originalBatchCueCount / 5))` cues are highlighted;
9. the highlight limit is a ceiling, not a target;
10. malformed optional annotation never discards a valid translation.

Desktop keeps its translation-style clause. iOS BYOK uses the natural
conversational style because it currently exposes no translation-style setting.

## Prompt contract

Per-cue output is JSON Lines, one single-line object for each requested cue:

```json
{"i":7,"zh":"我得赶上进度","p":[["catch up","赶上进度","表示补回落下的进度，常用于工作、学习或消息积压后追赶进度的语境。"]]}
```

The prompt must explicitly say:

- no markdown, prose, source text, timestamps, or additional fields;
- one row for every requested index, in request order;
- zero or one phrase per cue;
- one to four English words;
- choose only a phrasal verb, fixed collocation, idiom, pragmatic spoken
  expression, or easily misunderstood use;
- omit greetings, fillers, names, numbers, function words, ordinary literal
  noun phrases, and simple compositional sentences;
- `p=[]` is normal and preferred to low-value annotation;
- the exact remaining highlight allowance for that request.

Summary remains a separate request. Its existing platform-specific envelope may
remain, but summary phrases use the same 1–4-word and 25–90-code-point quality
rules. A summary failure is fail-open: completed cue translations stay valid
and usable.

## Deterministic validation and budget

Prompt compliance is not trusted. Each client validates the output and
assembles its local `Subtitle`/`Cue` from the immutable submitted cue.

One highlight budget belongs to the original durable batch. It is shared by
the initial request, missing-only continuations, and optional annotation
repair. A continuation receives the remaining allowance, not a new allowance
calculated from the smaller missing set. A valid translation whose phrase is
invalid or over budget becomes a translation-only cue.

## Recovery contract

### Retryable

- provider transport/URL-session failures;
- HTTP 408, ordinary 429, and HTTP 5xx;
- empty/truncated streams and repairable protocol output;
- malformed or missing cue rows, provided the attempt bound has not expired.

### Non-retryable

- cancellation or explicit pause;
- missing configuration or consent;
- invalid API key/authentication;
- exhausted balance, subscription quota, or managed-relay admission rejection;
- unsupported/missing model and other deterministic HTTP 4xx responses.

The analysis-owned policy is four total requests per unfinished cue batch, with
500 ms, 1500 ms, and 3500 ms local backoffs. A longer provider `Retry-After`
wins. Cancellation interrupts backoff.

Every request operates on the unresolved subset. A validated cue is never
re-requested or overwritten. A complete durable batch is committed atomically.

## Persistence

Desktop already persists validated in-flight rows through
`analysis_inflight`; this format remains unchanged.

iOS upgrades its BYOK checkpoint from completed batches only to:

- completed 50-cue batches;
- at most one unfinished batch containing validated cue entries keyed by
  source offset;
- optional completed summary.

Each accepted iOS cue is synchronously written before the engine treats it as
recoverable. On app restart, the engine validates saved source index/text/time
against the current transcript, seeds the resolved map, and requests only
missing cues. Partial checkpoints never appear as a final Library analysis
until the full batch commits.

## Compatibility and rollout

- Existing desktop journals remain valid.
- iOS checkpoint schema v1 is migrated in memory to schema v2 with no partial
  batch; completed batches and summary remain intact.
- No server API or database migration is needed.
- Release desktop and iOS independently after their own test gates.
- Keep managed compact rollout configuration unchanged while comparing the
  same transcript across relay, desktop BYOK, and iOS BYOK.

## Execution split

The two client plans are independently reviewable and may run in parallel:

- desktop: `docs/superpowers/plans/2026-08-16-desktop-byok-compact-parity.md`;
- iOS: sibling repository `whatsub-mobile/docs/superpowers/plans/2026-08-16-ios-byok-compact-recovery.md`.

No `whatsub-license` implementation task is required. Its compact prompt,
missing-index continuation, checkpoint recovery, and bounded retry behavior are
the reference implementation and must remain unchanged during client work.

## Acceptance criteria

- A 50-cue response containing 42 valid rows keeps those 42 visible and
  persisted; the next request contains only the remaining eight indexes.
- Restarting desktop or iOS during that unfinished batch resumes from the 42
  validated rows.
- At most ten of fifty cues are highlighted, each with at most one 1–4-word
  phrase and a 25–90-code-point usage note.
- HTTP 401/403, invalid key, quota/balance, model-not-found, cancellation, and
  pause make no automatic retry.
- Network failure, HTTP 408/429/5xx, empty/truncated response, and incomplete
  JSONL use bounded retries without redoing accepted cues.
- Summary failure never removes committed cue translations.
