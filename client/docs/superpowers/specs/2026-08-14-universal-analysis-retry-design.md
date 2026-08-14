# Universal Subtitle Analysis Retry Design

## Problem

The desktop subtitle-analysis pipeline currently grants the four-attempt repair policy only to providers tagged with the historical `deepseek-analysis` retry profile. Direct Qwen requests therefore receive one attempt. In a controlled reproduction, `qwen-flash` returned HTTP 200 with `finish_reason: stop` but omitted 10–12 entries from a 50-cue JSONL request. The client correctly rejected the incomplete batch, but it did not ask Qwen to produce only the missing entries.

This is a pipeline responsibility, not a DeepSeek-specific capability. Any supported model can truncate JSONL, emit one malformed line, omit an index, or encounter a transient transport failure.

## Goals

- Apply the same analysis recovery policy to every `Provider` used by desktop subtitle analysis.
- Preserve every cue that has already passed validation and request only unresolved cues on later attempts.
- Retry transient transport failures during analysis, including network failures, HTTP 429, and HTTP 5xx responses.
- Fail immediately for deterministic failures such as invalid credentials, insufficient balance or quota, unsupported/missing models, and other non-retryable HTTP 4xx responses.
- Keep the current streaming preview and durable in-flight journal behavior: valid cues remain visible and recoverable as soon as they arrive.
- Limit the change to subtitle/video analysis. Ordinary AI conversation and tool calls retain their existing retry behavior.

## Non-goals

- Do not reduce the normal batch size from 50 cues.
- Do not add provider-specific Qwen parsing or prompts.
- Do not retry indefinitely.
- Do not re-request, overwrite, or re-bill already validated cue outputs.
- Do not change server-managed queue capacity, mobile behavior, or conversational AI behavior.

## Design

### One analysis retry policy

Replace the provider-selected `DEEPSEEK_ANALYSIS_RETRY_POLICY` / `NO_RETRY_POLICY` split with one analysis-owned policy:

- maximum attempts: 4 total (initial attempt plus at most 3 retries)
- backoff delays: 500 ms, 1500 ms, 3500 ms
- an HTTP `Retry-After` value remains authoritative when it is longer than the local delay
- cancellation interrupts backoff and prevents another request

`runAnalysis` and its internal helpers own this policy. The generic `Provider` interface no longer advertises `retryProfile`, and `openaiCompatible` no longer assigns a DeepSeek-only profile.

### Cue-level content repair

`resolveCueBatch` continues to validate each streamed JSONL object independently and store valid results by cue offset. After each attempt it computes unresolved cue indexes.

If any cues remain unresolved and attempts remain, the next request uses the existing repair prompt and contains only those unresolved cues. Resolved cues are neither requested again nor replaced. Preview publication continues during every attempt, so a model that returns 40 valid entries and omits 10 immediately publishes the 40, then requests only the 10.

Malformed lines, missing indexes, duplicate indexes, invalid fields, and an otherwise clean stream that ends early are all content-repair cases. After the fourth attempt, the existing actionable error lists only the indexes still unresolved.

### Transport and HTTP failures

Every analysis operation uses the same retryability classifier:

- retry: network/transport interruption, HTTP 429, HTTP 5xx, and protocol/content failures that another model response can repair
- do not retry: abort/cancel, authentication failures, quota/balance exhaustion, model-not-found/unsupported requests, and other deterministic HTTP 4xx responses

For cue batches, valid entries collected before a retryable stream failure stay in the resolved map and the retry requests only the remaining cues. For atomic analysis operations such as final key-phrase generation, a retry repeats that operation because there is no valid partial object to preserve.

### Scope isolation

The policy is local to `src/llm/analyze.ts`. It must not be moved into the provider's generic `stream()` implementation because that stream is also used by chat and tools, where replaying a request can duplicate visible output or tool side effects.

## Interface changes

- Remove `retryProfile?: "deepseek-analysis"` from `Provider`.
- Remove vendor-based retry-profile assignment from `createOpenAICompatibleProvider`.
- Replace `retryPolicyFor(provider)` with a provider-independent analysis policy.
- Keep all public analysis callbacks and checkpoint formats unchanged.

## Testing

Tests must prove the behavior rather than vendor labels:

1. A provider without metadata returns a partial batch, then receives only missing cue indexes and completes successfully.
2. Valid cues emitted before a retryable transport failure are preserved; only unresolved cues are retried.
3. A provider without metadata retries malformed/incomplete model content up to the shared limit and reports remaining indexes.
4. Retryable network, HTTP 429, and HTTP 5xx failures retry under the analysis policy.
5. HTTP 401/403, quota/balance, model-not-found/other deterministic 4xx, and cancellation do not retry.
6. OpenAI-compatible provider tests no longer expect vendor-specific retry metadata.
7. Existing streaming preview, checkpoint recovery, summary generation, and cancellation tests remain green.

Run the focused LLM test files, TypeScript typecheck, and the full frontend test suite before completion.

## Acceptance criteria

- Direct `qwen-flash` can recover from a 50-cue response that contains only a valid subset without restarting transcription or the completed portion of analysis.
- DeepSeek and the managed relay retain their current four-attempt analysis resilience.
- Other configured models receive the same bounded recovery behavior.
- A permanent authentication, balance/quota, or request-configuration error is surfaced immediately rather than delayed by retries.
- No chat/tool request gains automatic replay behavior.
