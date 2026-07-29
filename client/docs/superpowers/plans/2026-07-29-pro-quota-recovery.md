# Pro Quota Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Pro users a structured, checkpoint-aware recovery experience when the managed-AI monthly token quota is exhausted, including a preflight guard and a direct path to BYOK settings.

**Architecture:** Preserve quota metadata at the managed-relay boundary, normalize it into a focused `QuotaExhaustedDetails` value, and store that value alongside the existing analysis error. Pure helpers own preflight decisions, reset-time/resume rules, and user copy; `ImportModal`, `Player`, `ProgressBanner`, and `Settings` only wire those decisions into existing flows.

**Tech Stack:** React 19, TypeScript, Zustand, React Router, Vitest, Testing Library, Tauri invoke/plugin HTTP.

## Global Constraints

- Only `vendorId === "whatsub-managed"` performs the preflight quota lookup.
- A failed preflight lookup is advisory and must not block import.
- `quota_exceeded` remains non-retryable at the provider layer.
- Existing 50-cue durable checkpoint and preview rollback semantics must not change.
- Existing Pro users must never see the generic「升级 Pro」CTA for `quota_exceeded`.
- Trial/free exhaustion keeps the existing upgrade behavior.
- Do not change server quota values, billing, or request-time overage semantics.

---

## File Structure

- Create `src/llm/quotaRecovery.ts`: focused pure normalization, preflight, copy, and reset-boundary helpers.
- Create `src/llm/quotaRecovery.test.ts`: behavior tests for those helpers.
- Modify `src/llm/providers/relayErrors.ts` and its test: retain structured quota metadata.
- Modify `src/store/analysis.ts`: store optional quota-exhaustion details with an analysis error.
- Modify `src/pages/Player.tsx` and `src/pages/Player.analysisResume.test.tsx`: translate `RelayError` into checkpoint-aware state.
- Modify `src/components/ProgressBanner.tsx` and its test: render quota recovery UI and navigate to BYOK settings.
- Modify `src/components/ImportModal.tsx` and its test: managed quota preflight before `import_video`.
- Modify `src/pages/Settings.tsx` and `src/pages/Settings.modelDownload.test.tsx`: add `llm-provider` deep-link scrolling/highlight without regressing whisper highlighting.
- Modify `CLAUDE.md`: document Pro quota preflight and checkpoint recovery behavior.

---

### Task 1: Preserve Relay Quota Metadata

**Files:**
- Modify: `src/llm/providers/relayErrors.ts`
- Test: `src/llm/providers/relayErrors.test.ts`

**Interfaces:**
- Produces: `RelayErrorInfo.used`, `.limit`, `.periodResetAt` as `number | null`.
- Produces: matching readonly fields on `RelayError`.

- [ ] **Step 1: Write the failing metadata test**

Add a test with a literal response body and assert the parsed result retains all fields:

```ts
const info = parseRelayError(429, JSON.stringify({
  error: "quota_exceeded",
  message: "本月额度已用完。",
  used: 5_000_100,
  limit: 5_000_000,
  periodResetAt: 1_785_520_800_000,
}));
expect(info).toEqual({
  code: "quota_exceeded",
  message: "本月额度已用完。",
  upsell: true,
  used: 5_000_100,
  limit: 5_000_000,
  periodResetAt: 1_785_520_800_000,
});
```

Also assert malformed/missing numeric fields normalize to `null`, never `NaN` or strings.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run src/llm/providers/relayErrors.test.ts`

Expected: FAIL because the parsed object and `RelayError` do not expose quota metadata.

- [ ] **Step 3: Implement minimal parsing**

Parse the JSON once into `{ error, message, used, limit, periodResetAt }`; use a small local numeric guard and pass normalized fields into `RelayError`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run src/llm/providers/relayErrors.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm/providers/relayErrors.ts src/llm/providers/relayErrors.test.ts
git commit -m "feat(llm): preserve managed quota metadata"
```

### Task 2: Add Pure Quota Recovery Decisions

**Files:**
- Create: `src/llm/quotaRecovery.ts`
- Create: `src/llm/quotaRecovery.test.ts`

**Interfaces:**
- Produces: `QuotaExhaustedDetails` with `used`, `limit`, `periodResetAt`, `committedCueOffset`, `totalCues`.
- Produces: `quotaDetailsFromRelayError(error, committedCueOffset, totalCues)`.
- Produces: `preflightManagedQuota(settings, loadQuota?)` returning `Promise<QuotaExhaustedDetails | null>`.
- Produces: `canResumeQuota(details, now)` and `quotaRecoveryMessage(details, locale?)`.
- Produces: `SETTINGS_LLM_LINK = "/settings?highlight=llm-provider"`.

- [ ] **Step 1: Write failing pure tests**

Cover these literal behaviors:

```ts
expect(await preflightManagedQuota(managedSettings, async () => ({
  tier: "pro", used: 5_000_000, limit: 5_000_000,
  requestCount: 9, periodResetAt: 1_785_520_800_000,
}))).toMatchObject({ committedCueOffset: 0, totalCues: 0 });

expect(await preflightManagedQuota(byokSettings, async () => {
  throw new Error("must not run");
})).toBeNull();

expect(await preflightManagedQuota(managedSettings, async () => {
  throw new Error("offline");
})).toBeNull();

expect(canResumeQuota(details, details.periodResetAt! - 1)).toBe(false);
expect(canResumeQuota(details, details.periodResetAt!)).toBe(true);
```

Assert message output includes `已保存到第 150 条字幕` and a deterministic hand-derived reset string by injecting/choosing a stable locale/time-zone formatting path.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run src/llm/quotaRecovery.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement minimal pure helpers**

Use `llmQuota` as the default loader but allow injection for tests. Return `null` for non-managed settings, non-Pro tiers, available quota, and loader failures. Preserve missing relay metadata as `null`. Use `Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", ... })` so the reset copy is explicitly Beijing time instead of depending on the machine locale.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm vitest run src/llm/quotaRecovery.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm/quotaRecovery.ts src/llm/quotaRecovery.test.ts
git commit -m "feat(analysis): add managed quota recovery decisions"
```

### Task 3: Persist Checkpoint-Aware Quota Errors

**Files:**
- Modify: `src/store/analysis.ts`
- Modify: `src/pages/Player.tsx`
- Test: `src/pages/Player.analysisResume.test.tsx`

**Interfaces:**
- Consumes: `QuotaExhaustedDetails`, `quotaDetailsFromRelayError` from Task 2.
- Produces: `AnalysisState.quotaError: QuotaExhaustedDetails | null`.
- Changes: `setError(message, upsell, stage, quotaError?)` clears/replaces structured detail atomically.

- [ ] **Step 1: Write failing store/Player behavior tests**

Exercise real store behavior:

```ts
useAnalysis.getState().setCommittedAnalysis(persistedAt50, 100);
useAnalysis.getState().setError("本月额度已用完", true, "analysis", {
  used: 5_000_100, limit: 5_000_000,
  periodResetAt: 1_785_520_800_000,
  committedCueOffset: 50, totalCues: 100,
});
expect(useAnalysis.getState().quotaError?.committedCueOffset).toBe(50);
expect(useAnalysis.getState().checkpoint?.nextCueOffset).toBe(50);
```

Then call a non-quota `setError` and `reset`, asserting stale quota metadata is cleared.

- [ ] **Step 2: Run test and verify RED**

Run: `pnpm vitest run src/pages/Player.analysisResume.test.tsx`

Expected: FAIL because `quotaError` and the fourth `setError` argument do not exist.

- [ ] **Step 3: Implement store field and Player catch wiring**

In the foreground catch, if `e instanceof RelayError && e.code === "quota_exceeded"`, derive details using `session.analysis.checkpoint.nextCueOffset` and `cues.length`; pass them to `setError`. Keep generic `errorUpsell` for trial/free errors. Do not modify `executeAnalysisSession` or checkpoint persistence.

- [ ] **Step 4: Run test and verify GREEN**

Run: `pnpm vitest run src/pages/Player.analysisResume.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/analysis.ts src/pages/Player.tsx src/pages/Player.analysisResume.test.tsx
git commit -m "feat(player): retain quota recovery checkpoint"
```

### Task 4: Render Pro Recovery UI and Settings Deep Link

**Files:**
- Modify: `src/components/ProgressBanner.tsx`
- Modify: `src/components/ProgressBanner.test.tsx`
- Modify: `src/pages/Settings.tsx`
- Modify: `src/pages/Settings.modelDownload.test.tsx`

**Interfaces:**
- Consumes: `quotaError`, `canResumeQuota`, `quotaRecoveryMessage`, `SETTINGS_LLM_LINK`.
- Produces: Settings accepts `?highlight=llm-provider` and scrolls/highlights the 翻译服务 section.

- [ ] **Step 1: Write failing ProgressBanner tests**

Render with a real analysis store containing a Pro quota error. Assert:

- recovery message includes committed cue count;
-「切换自己的 API」exists;
-「升级 Pro」does not exist;
- before reset,「继续解析」does not exist;
- at/after reset,「继续解析」exists and invokes the supplied callback;
- clicking BYOK navigates to `/settings?highlight=llm-provider`.

- [ ] **Step 2: Write failing Settings highlight test**

Mock `useSearchParams` to return `highlight=llm-provider`, render the real Settings page, advance timers past 150 ms, and assert the 翻译服务 section receives the amber ring class and its `scrollIntoView` is called. Keep the existing whisper-model test green.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `pnpm vitest run src/components/ProgressBanner.test.tsx src/pages/Settings.modelDownload.test.tsx`

Expected: FAIL because quota-specific UI and LLM highlighting do not exist.

- [ ] **Step 4: Implement UI and deep-link behavior**

Use `useNavigate` in `ProgressBanner`. Give the 翻译服务 `<section>` its own ref/highlight state; generalize the existing timeout effect without sharing refs between targets. When `quotaError` exists, suppress generic `errorMessage` duplication and generic upgrade CTA, render the focused message, and gate continue via `canResumeQuota(quotaError, Date.now())`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm vitest run src/components/ProgressBanner.test.tsx src/pages/Settings.modelDownload.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/ProgressBanner.tsx src/components/ProgressBanner.test.tsx src/pages/Settings.tsx src/pages/Settings.modelDownload.test.tsx
git commit -m "feat(player): explain Pro quota recovery"
```

### Task 5: Guard New Manual Imports With Managed Quota Preflight

**Files:**
- Modify: `src/components/ImportModal.tsx`
- Modify: `src/components/ImportModal.test.tsx`

**Interfaces:**
- Consumes: `preflightManagedQuota`, `quotaRecoveryMessage`, `SETTINGS_LLM_LINK`.
- Behavior: manual foreground and background submit call preflight after local form validation but before `invoke("import_video")`.

- [ ] **Step 1: Write failing component tests**

For a complete managed quota response at its limit, click「开始解析」and assert the real modal displays quota recovery copy and no progress view; `import_video` must not be invoked. Add two positive-path tests: BYOK skips quota loading and invokes import; a rejected quota lookup degrades open and invokes import.

- [ ] **Step 2: Run test and verify RED**

Run: `pnpm vitest run src/components/ImportModal.test.tsx`

Expected: FAIL because submit does not query quota or render a quota notice.

- [ ] **Step 3: Implement minimal preflight UI**

Add `quotaBlock` state. Before building/running the import request, await `preflightManagedQuota(settings)`; when non-null, store it and return. Render a compact amber panel in the form with reset copy and「切换自己的 API」using `navigate(SETTINGS_LLM_LINK)`. Clear the block when the provider/settings change or a later preflight succeeds.

- [ ] **Step 4: Run test and verify GREEN**

Run: `pnpm vitest run src/components/ImportModal.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ImportModal.tsx src/components/ImportModal.test.tsx
git commit -m "feat(import): preflight managed AI quota"
```

### Task 6: Documentation and Full Verification

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Documents: request-boundary quota enforcement, preflight degradation, 50-cue recovery, and Pro/BYOK UI behavior.

- [ ] **Step 1: Update architecture documentation**

Add a focused managed-relay quota section describing:

- Pro default monthly budget remains server-configured;
- last under-cap request is allowed to finish and may overshoot;
- next request returns permanent `quota_exceeded`;
- manual import preflight is advisory;
- checkpointed analysis resumes without download/Whisper.

- [ ] **Step 2: Run all verification**

```bash
pnpm typecheck
pnpm test
cd src-tauri && cargo test
```

Expected: typecheck clean; all Vitest tests pass; all Rust tests pass with only pre-existing ignored tests.

- [ ] **Step 3: Review the final diff**

Run:

```bash
git diff --check
git status --short
git log --oneline -8
```

Confirm no unrelated files or parent-level untracked user files are staged.

- [ ] **Step 4: Commit documentation**

```bash
git add CLAUDE.md
git commit -m "docs(analysis): document Pro quota recovery"
```

