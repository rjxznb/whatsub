# Desktop BYOK Compact Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align desktop BYOK phrase quality and highlight density with the managed compact contract while preserving the desktop's existing per-cue journal and universal retry behavior.

**Architecture:** Keep `runAnalysis` and `analysis_inflight` as the recovery boundary. Tighten the compact validator, introduce one batch-scoped highlight budget shared by initial output and annotation repair, and add the exact remaining allowance to each cue prompt. The existing four-attempt missing-index retry loop remains authoritative and is verified rather than rewritten.

**Tech Stack:** TypeScript 5.8, Vitest 4, async generators, existing `JsonLineParser`, Tauri persistence commands.

## Global Constraints

- Normal batch size remains 50 cues.
- Compact cue shape remains `{i:number,zh:string,p:[string,string,string][]}`.
- At most one phrase per highlighted cue.
- Phrase length is 1–4 English tokens.
- Usage note length is 25–90 Unicode code points.
- Highlight capacity is `min(10, ceil(originalBatchCueCount / 5))`.
- The budget is shared across initial output, retries, and annotation repair.
- Valid translation survives malformed or over-budget annotation.
- Existing retry policy stays at 4 total attempts with 500/1500/3500 ms backoff and longer `Retry-After` precedence.
- Do not change chat, agent tools, provider interfaces, batch size, or persisted journal schema.
- Preserve user-selected `TranslationStyle` guidance.

---

### Task 1: Encode the compact phrase rules in deterministic desktop code

**Files:**
- Modify: `src/llm/phraseRules.ts`
- Modify: `src/llm/phraseRules.test.ts`
- Modify: `src/llm/cueOutput.ts`
- Modify: `src/llm/cueOutput.test.ts`

**Interfaces:**
- Produces: `compactHighlightCapacity(cueCount: number): number`, `HighlightBudget`, and stricter `isAllowedLearningPhrase`/annotation validation.
- Consumes later: Task 2 passes one `HighlightBudget` through a complete batch attempt.

- [ ] **Step 1: Add failing phrase-rule tests**

Add cases proving:

```ts
expect(compactHighlightCapacity(0)).toBe(0);
expect(compactHighlightCapacity(1)).toBe(1);
expect(compactHighlightCapacity(13)).toBe(3);
expect(compactHighlightCapacity(50)).toBe(10);
expect(isAllowedLearningPhrase("one two three four", "one two three four five")).toBe(true);
expect(isAllowedLearningPhrase("one two three four five", "one two three four five six")).toBe(false);
```

Add a budget test that accepts ten highlighted cues, rejects the eleventh, and
does not consume capacity for a translation-only cue.

- [ ] **Step 2: Run the focused tests and verify failure**

```powershell
pnpm exec vitest run src/llm/phraseRules.test.ts src/llm/cueOutput.test.ts
```

Expected: FAIL because the 4-word limit, note-length rule, one-phrase limit,
and budget do not exist.

- [ ] **Step 3: Implement the rules**

In `phraseRules.ts`, add:

```ts
export const MAX_HIGHLIGHTED_CUES = 10;
export const CUES_PER_HIGHLIGHT = 5;

export function compactHighlightCapacity(cueCount: number): number {
  if (!Number.isFinite(cueCount) || cueCount <= 0) return 0;
  return Math.min(MAX_HIGHLIGHTED_CUES, Math.ceil(Math.floor(cueCount) / CUES_PER_HIGHLIGHT));
}

export class HighlightBudget {
  constructor(readonly limit: number, private usedCount = 0) {}
  get remaining(): number { return Math.max(0, this.limit - this.usedCount); }
  accept(): boolean {
    if (this.remaining === 0) return false;
    this.usedCount += 1;
    return true;
  }
}
```

Change `isAllowedLearningPhrase` to reject token counts above 4. In
`cueOutput.ts`, keep only the first valid candidate and require the trimmed note
to contain 25–90 Unicode code points (`Array.from(note).length`). Do not reject
the cue when annotation is invalid; return the valid translation with an empty
annotation patch and `needsAnnotationRepair=true` when annotation was intended.

- [ ] **Step 4: Run the focused tests**

```powershell
pnpm exec vitest run src/llm/phraseRules.test.ts src/llm/cueOutput.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- src/llm/phraseRules.ts src/llm/phraseRules.test.ts src/llm/cueOutput.ts src/llm/cueOutput.test.ts
git commit -m "feat(llm): enforce compact phrase quality"
```

---

### Task 2: Share one highlight budget across a desktop cue batch

**Files:**
- Modify: `src/llm/analyze.ts`
- Modify: `src/llm/analyze.test.ts`

**Interfaces:**
- Consumes: `compactHighlightCapacity`, `HighlightBudget`, `validateCueOutput`, and `validateAnnotationRepair`.
- Produces: budgeted preview and committed subtitles with identical annotation state.

- [ ] **Step 1: Add failing batch-budget tests**

Add one 50-cue scripted response that supplies a valid phrase for every cue.
Assert all 50 translations resolve, only 10 subtitles are key points, and the
preview's final state equals the committed state. Add a 13-cue case expecting
at most 3 highlights.

Add a continuation case: the first response accepts 8 highlighted cues and
leaves 10 indexes unresolved; the continuation may add only 2 highlighted
cues. Add an annotation-repair case proving repair cannot exceed the same
remaining capacity.

- [ ] **Step 2: Run and verify the tests fail**

```powershell
pnpm exec vitest run src/llm/analyze.test.ts -t "highlight budget"
```

Expected: FAIL because each response currently validates annotations without a
shared batch allowance.

- [ ] **Step 3: Thread the budget through the existing batch resolver**

At the start of `resolveCueBatch`, create one budget using the original batch
length. Seed its used count from highlighted entries restored by
`seedResumePreview`. Apply the budget exactly once when a newly resolved cue's
validated annotation is first inserted into `resolved`; if no slot remains,
replace its annotation fields with:

```ts
{
  isKeyPoint: false,
  highlightWords: [],
  keyNotes: {},
  highlightTranslations: {},
}
```

Pass the same budget to `repairDamagedAnnotations`. Apply repaired patches in
the original request order, not response arrival order, so retry timing cannot
change which source cue receives the remaining slots. Never consume a slot for
`p=[]`, invalid annotations, duplicate output, or an already resolved cue.

- [ ] **Step 4: Run analysis and journal regression tests**

```powershell
pnpm exec vitest run src/llm/analyze.test.ts src/llm/analysisJournal.test.ts src/llm/analysisPersistence.test.ts
```

Expected: PASS, including partial-output retry and resumed in-flight journal
tests.

- [ ] **Step 5: Commit**

```powershell
git add -- src/llm/analyze.ts src/llm/analyze.test.ts
git commit -m "feat(llm): budget desktop cue highlights"
```

---

### Task 3: Align cue and repair prompt wording with compact-v1

**Files:**
- Modify: `src/llm/prompts.ts`
- Modify: `src/llm/prompts.test.ts`
- Modify: `src/llm/analyze.ts`

**Interfaces:**
- Produces: cue/continuation/repair prompt builders that receive `maxHighlightedCues`.
- Consumes: the batch budget's current `remaining` value from Task 2.

- [ ] **Step 1: Add failing prompt assertions**

For cue, continuation, and annotation-repair prompts, assert the generated text
contains the exact allowance and all compact constraints:

```ts
expect(prompt).toContain("At most 3 cues in this request may have a non-empty p array");
expect(prompt).toContain("one to four English words");
expect(prompt).toContain("25 to 90 Chinese characters");
expect(prompt).toContain("The limit is a ceiling, not a target");
```

Also assert the translation-style block still changes between `formal` and
`colloquial`. Add summary assertions for the 1–4-word phrase limit and 25–90
code-point substantive usage rule.

- [ ] **Step 2: Run and verify failure**

```powershell
pnpm exec vitest run src/llm/prompts.test.ts
```

- [ ] **Step 3: Update prompt builders and call sites**

Extend `buildUserPrompt`, `buildContinuationPrompt`, `buildRepairPrompt`, and
`buildAnnotationRepairPrompt` with an options argument:

```ts
export interface CompactPromptOptions { maxHighlightedCues: number }
```

Add the compact high-value/low-value categories from the design. Pass the
budget's current `remaining` value at the moment each request is built. Keep
`buildSystemPrompt(style)` responsible for translation register only; do not
remove style support. Tighten `buildSummaryPrompt` to the same 1–4-word and
25–90-character quality language without changing its JSON envelope.

- [ ] **Step 4: Run prompt and analysis tests**

```powershell
pnpm exec vitest run src/llm/prompts.test.ts src/llm/analyze.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- src/llm/prompts.ts src/llm/prompts.test.ts src/llm/analyze.ts
git commit -m "feat(llm): align desktop compact prompts"
```

---

### Task 4: Prove existing desktop retry parity remains intact

**Files:**
- Modify: `src/llm/analyze.test.ts`
- Verify: `src/llm/retry.test.ts`
- Verify: `src/llm/analysisProviderRetry.integration.test.ts`

**Interfaces:**
- Consumes: existing `ANALYSIS_RETRY_POLICY`, `analysis_inflight`, and provider error classifier.
- Produces: verification evidence; no new retry implementation.

- [ ] **Step 1: Add one explicit retry-parity matrix**

Add a table-driven test that proves 408/429/500/503/network errors retry and
400/401/403/quota/model-404 do not. Add assertions to the existing partial
stream test that accepted rows are not present in the second request, and to
the journal reload test that only unresolved rows are sent. Keep existing
cancellation and summary fail-open tests in the focused command.

- [ ] **Step 2: Add only missing assertions, then run focused tests**

```powershell
pnpm exec vitest run src/llm/analyze.test.ts src/llm/retry.test.ts src/llm/analysisProviderRetry.integration.test.ts src/llm/analysisSession.test.ts
```

Expected: PASS with four total attempts and 500/1500/3500 ms backoff.

- [ ] **Step 3: Commit the parity regression tests**

```powershell
git add -- src/llm/analyze.test.ts src/llm/analysisProviderRetry.integration.test.ts src/llm/analysisSession.test.ts
git commit -m "test(llm): lock desktop recovery parity"
```

---

### Task 5: Desktop final verification

**Files:**
- Verify only.

- [ ] **Step 1: Run all LLM tests**

```powershell
pnpm exec vitest run src/llm
```

- [ ] **Step 2: Run typecheck, full frontend suite, and build**

```powershell
pnpm typecheck
pnpm test
pnpm build
```

- [ ] **Step 3: Check scope**

```powershell
git diff --check
git status --short
git log -6 --oneline
```

Expected: only planned desktop LLM files and documentation are changed; the
pre-existing untracked `../AGENTS.md` and `../.agents/skills/` remain untouched.
