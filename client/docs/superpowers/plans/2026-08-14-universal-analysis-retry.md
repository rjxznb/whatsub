# Universal Subtitle Analysis Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every desktop subtitle-analysis provider recover from incomplete JSONL and transient request failures with bounded retries, while preserving already validated cues.

**Architecture:** Retry ownership moves entirely into `src/llm/analyze.ts`, where requests are known to be side-effect-free analysis operations. Cue retries reuse the existing resolved-entry map and repair prompt so only unresolved indexes are sent again; summary retries repeat the atomic summary request. Provider implementations become transport adapters again and no longer expose vendor-specific retry metadata.

**Tech Stack:** TypeScript 5.8, Vitest 4, async generators, existing `JsonLineParser`, `retryOperation`, and typed provider errors.

## Global Constraints

- Keep the normal cue batch size at 50.
- Use 4 total attempts with backoffs of 500 ms, 1500 ms, and 3500 ms.
- Honor a longer HTTP `Retry-After` delay.
- Preserve and never re-request already validated cue entries.
- Retry transport failures, HTTP 408/429/5xx, and repairable model/protocol content failures.
- Do not retry cancellation, authentication, quota/balance, managed-relay admission rejection, or deterministic HTTP 4xx failures.
- Apply automatic replay only inside subtitle/video analysis; do not change chat or tool-call retry behavior.
- Keep checkpoint, preview, callback, and persisted journal interfaces unchanged.

---

### Task 1: Make cue and summary recovery provider-independent

**Files:**
- Modify: `src/llm/analyze.test.ts`
- Modify: `src/llm/analyze.ts`

**Interfaces:**
- Consumes: `Provider.stream(req)`, `isRetryableProviderFailure(error)`, `buildRepairPrompt(cues)`, `AnalysisPreview`, and `AnalysisRetryEvent`.
- Produces: one internal `ANALYSIS_RETRY_POLICY: RetryPolicy`; provider-independent behavior for `withProviderRetry` and `resolveCueBatch`.

- [ ] **Step 1: Replace the provider-label regression tests with behavior tests that fail under the current code**

Change the `scriptedProvider` helper so it never adds `retryProfile`:

```ts
function scriptedProvider(
  scripts: readonly StreamScript[],
): Provider & { requests: ProviderRequest[] } {
  let call = 0;
  const requests: ProviderRequest[] = [];
  return {
    requests,
    async *stream(request) {
      requests.push(request);
      const script = scripts[call++] ?? {};
      for (let i = 0; i < (script.chunks?.length ?? 0); i++) {
        await Promise.resolve();
        script.onChunk?.(i);
        yield script.chunks![i];
      }
      if (script.error) throw script.error;
    },
  };
}
```

Replace the two tests that assert providers without the DeepSeek profile do not retry. Add a direct reproduction of the Qwen failure: a 50-cue request returns only indexes 51–90, then the repair request returns 91–100.

```ts
it("repairs an incomplete 50-cue response for a provider without retry metadata", async () => {
  vi.useFakeTimers();
  const batch = cues(50, 51);
  const provider = scriptedProvider([
    { chunks: batch.slice(0, 40).map((cue) => cueLine(cue.index)) },
    { chunks: batch.slice(40).map((cue) => cueLine(cue.index)) },
  ]);
  const controller = new AbortController();
  const commits: AnalysisCommit[] = [];

  await runWithTimers(runAnalysis({
    provider,
    cues: batch,
    previouslyAnalyzed: [],
    checkpoint: checkpoint(),
    batchSize: 50,
    signal: controller.signal,
    onCommit: async (commit) => {
      commits.push(commit);
      controller.abort();
    },
  }));

  expect(provider.requests).toHaveLength(2);
  expect(provider.requests[1].userPrompt).not.toContain("\n90\t");
  expect(provider.requests[1].userPrompt).toContain("\n91\t");
  expect(provider.requests[1].userPrompt).toContain("\n100\t");
  expect(commits[0]).toMatchObject({ kind: "cues" });
  expect(commits[0].kind === "cues" && commits[0].subtitles).toHaveLength(50);
});
```

Add a table-driven transport/HTTP test whose first request fails and second request resolves the cue:

```ts
it.each([
  ["transport", new ProviderTransportError("offline", "send")],
  ["HTTP 429", new ProviderHttpError("rate limited", 429, "", 0)],
  ["HTTP 503", new ProviderHttpError("unavailable", 503, "", null)],
])("retries %s failures for every analysis provider", async (_name, failure) => {
  vi.useFakeTimers();
  const provider = scriptedProvider([{ error: failure }, { chunks: [cueLine(0)] }]);
  const controller = new AbortController();

  await runWithTimers(runAnalysis({
    provider,
    cues: cues(1),
    previouslyAnalyzed: [],
    checkpoint: checkpoint(),
    signal: controller.signal,
    onCommit: async () => controller.abort(),
  }));

  expect(provider.requests).toHaveLength(2);
});
```

Keep the existing 401 test and add a deterministic model-request 404 case, both asserting exactly one request:

```ts
it.each([
  ["authentication", new ProviderHttpError("unauthorized", 401, "", null)],
  ["model not found", new ProviderHttpError("model not found", 404, "", null)],
])("does not retry deterministic %s failures", async (_name, failure) => {
  const provider = scriptedProvider([{ error: failure }]);
  await expect(runAnalysis({
    provider,
    cues: cues(1),
    previouslyAnalyzed: [],
    checkpoint: checkpoint(),
    onCommit: async () => {},
  })).rejects.toBe(failure);
  expect(provider.requests).toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused tests and verify the new universal cases fail for the expected reason**

Run:

```powershell
pnpm exec vitest run src/llm/analyze.test.ts
```

Expected: the new incomplete-response and transient-failure cases fail because an untagged provider makes only one request. Existing DeepSeek-profile assumptions may also fail after the helper loses its metadata.

- [ ] **Step 3: Replace provider-selected policies with one analysis policy**

In `src/llm/analyze.ts`, replace both policy constants with:

```ts
const ANALYSIS_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  backoffMs: [500, 1500, 3500],
};
```

Update `withProviderRetry` to pass `ANALYSIS_RETRY_POLICY` directly:

```ts
return retryOperation(operation, {
  policy: ANALYSIS_RETRY_POLICY,
  isRetryable: (error) =>
    isRetryableProviderFailure(error) || error instanceof ProviderProtocolError,
  signal: opts.signal,
  onRetry: (event) => opts.onRetry?.({
    ...event,
    kind: event.error instanceof ModelContentError ? "content-repair" : "transport",
    unresolvedCueIndexes: [],
  }),
});
```

In `resolveCueBatch`, use `const policy = ANALYSIS_RETRY_POLICY;`. Delete `retryPolicyFor(provider)`. Keep `isRetryableAnalysisStreamFailure`, `retryDelay`, the resolved map, repair prompt selection, preview publishing, and abort handling unchanged.

- [ ] **Step 4: Run the focused suite and verify cue repair, summary retry, permanent failures, and cancellation all pass**

Run:

```powershell
pnpm exec vitest run src/llm/analyze.test.ts
```

Expected: all tests pass, including the 50-cue partial-output regression, the transport/429/503 table, the 401/404 no-retry table, malformed summary retry, preview persistence, and cancellation during backoff.

- [ ] **Step 5: Commit the provider-independent analysis behavior**

```powershell
git add -- src/llm/analyze.ts src/llm/analyze.test.ts
git commit -m "fix(llm): retry incomplete analysis for every model"
```

---

### Task 2: Remove obsolete vendor retry metadata

**Files:**
- Modify: `src/llm/providers/types.ts`
- Modify: `src/llm/providers/openaiCompatible.ts`
- Modify: `src/llm/providers/openaiCompatible.test.ts`
- Modify: `src/store/backgroundAnalyses.test.ts`

**Interfaces:**
- Consumes: the provider-independent analysis policy from Task 1.
- Produces: `Provider` with only `stream(req): AsyncIterable<string>` for analysis; no `retryProfile` field or vendor-specific retry assignment.

- [ ] **Step 1: Change the provider test to express the desired transport-only interface**

Replace `sets the DeepSeek retry profile only for DeepSeek and managed relay vendors` with:

```ts
it("does not attach analysis retry policy to provider transports", () => {
  const providers = [
    createOpenAICompatibleProvider({
      ...DEFAULT_SETTINGS,
      openaiCompatible: { baseUrl: "https://api.deepseek.com/v1", apiKey: "k", model: "m" },
    }),
    createOpenAICompatibleProvider({
      ...DEFAULT_SETTINGS,
      openaiCompatible: { baseUrl: "https://whatsub.eversay.cc/api/llm/v1", apiKey: "k", model: "m" },
    }),
    createOpenAICompatibleProvider({
      ...DEFAULT_SETTINGS,
      openaiCompatible: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "k", model: "qwen-flash" },
    }),
  ];

  expect(providers.every((provider) => !("retryProfile" in provider))).toBe(true);
});
```

- [ ] **Step 2: Run the provider test and verify it fails because DeepSeek and managed relay still expose metadata**

Run:

```powershell
pnpm exec vitest run src/llm/providers/openaiCompatible.test.ts -t "does not attach analysis retry policy"
```

Expected: FAIL because at least the DeepSeek and managed-relay providers contain `retryProfile`.

- [ ] **Step 3: Remove retry metadata from provider production code and fixtures**

In `src/llm/providers/types.ts`, remove:

```ts
retryProfile?: "deepseek-analysis";
```

In `src/llm/providers/openaiCompatible.ts`, remove the conditional spread from the returned provider:

```ts
...(vendorId === "deepseek" || vendorId === "whatsub-managed"
  ? { retryProfile: "deepseek-analysis" as const }
  : {}),
```

Do not remove `vendorId` itself: it still controls existing vendor behavior such as DeepSeek thinking settings and managed-relay error parsing.

Delete the two `retryProfile: "deepseek-analysis"` properties from provider fixtures in `src/store/backgroundAnalyses.test.ts`. Do not change their scripted stream behavior.

- [ ] **Step 4: Run provider, analysis-store, and type tests**

Run:

```powershell
pnpm exec vitest run src/llm/providers/openaiCompatible.test.ts src/store/backgroundAnalyses.test.ts src/llm/analyze.test.ts
pnpm typecheck
```

Expected: all selected tests pass and TypeScript reports no references to `Provider.retryProfile`.

- [ ] **Step 5: Confirm the obsolete identifier is gone**

Run:

```powershell
rg -n "retryProfile|deepseek-analysis|DEEPSEEK_ANALYSIS_RETRY_POLICY|NO_RETRY_POLICY" src --glob '!*.test.ts'
```

Expected: no production-code matches. The provider test intentionally mentions
`retryProfile` in a negative assertion that prevents the metadata from being
reintroduced.

- [ ] **Step 6: Commit the interface cleanup**

```powershell
git add -- src/llm/providers/types.ts src/llm/providers/openaiCompatible.ts src/llm/providers/openaiCompatible.test.ts src/store/backgroundAnalyses.test.ts
git commit -m "refactor(llm): keep analysis retry out of providers"
```

---

### Task 3: Verify the complete desktop regression surface

**Files:**
- Verify only; no planned production-file changes.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: verification evidence that the universal policy does not regress the desktop app.

- [ ] **Step 1: Run all focused LLM retry and checkpoint suites**

```powershell
pnpm exec vitest run src/llm/analyze.test.ts src/llm/retry.test.ts src/llm/providers/openaiCompatible.test.ts src/llm/analysisJournal.test.ts src/store/backgroundAnalyses.test.ts
```

Expected: all focused tests pass with no unhandled rejection or pending-timer warnings.

- [ ] **Step 2: Run the full frontend suite**

```powershell
pnpm test
```

Expected: every Vitest file passes.

- [ ] **Step 3: Run typecheck and production build**

```powershell
pnpm typecheck
pnpm build
```

Expected: TypeScript and Vite build successfully with no missing `retryProfile` references.

- [ ] **Step 4: Inspect the final diff for scope and whitespace errors**

```powershell
git diff --check HEAD~2..HEAD
git status --short
git log -3 --oneline
```

Expected: no whitespace errors; only the planned LLM analysis/provider files and plan/spec commits are present. The pre-existing untracked `../.agents/skills/` and `../AGENTS.md` remain untouched.
