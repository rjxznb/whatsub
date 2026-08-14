# Key Phrase Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every analysis provider emit a compact streamable cue format, reject sentence-length “phrases”, recover safe legacy annotations, and repair malformed phrase annotations without retranslating successful cues.

**Architecture:** Keep JSON Lines as the streaming envelope but reduce the canonical cue payload to `i`, `zh`, and `p`. Put provider-independent phrase rules and untrusted-output normalization in focused pure modules, then let `analyze.ts` orchestrate one targeted annotation-repair round after translations resolve. Preserve the existing verbose formats as input-only compatibility paths and apply the same phrase validator to final summary output.

**Tech Stack:** TypeScript, Vitest, Web Streams/provider abstraction, existing `JsonLineParser` and analysis checkpoint pipeline.

## Global Constraints

- Apply one prompt and one validation path to every provider; do not branch on Qwen or any vendor id.
- Prefer one-to-five-word expressions; permit at most eight lexical English tokens.
- Reject a highlight equal to a complete cue containing more than five tokens.
- Keep 50 cues as the default transaction size and preserve one-line-at-a-time preview streaming.
- Preserve valid translations when annotation data is malformed.
- Run one malformed-content annotation repair round only; provider transport failures retain the existing bounded retry policy.
- Continue accepting both existing verbose response shapes, but never weaken substring or length validation.
- Do not truncate an overlong expression.

---

## File Structure

- Create `src/llm/phraseRules.ts`: pure token counting, phrase acceptance, and normalization shared by cue and summary validators.
- Create `src/llm/phraseRules.test.ts`: boundary and whole-cue phrase tests.
- Modify `src/llm/prompts.ts`: compact cue/summary contracts and targeted annotation-repair prompt.
- Modify `src/llm/prompts.test.ts`: prompt contract tests.
- Modify `src/llm/cueOutput.ts`: compact/verbose normalization and damaged-annotation classification.
- Modify `src/llm/cueOutput.test.ts`: compact, compatibility, phrase-length, and damage-state tests.
- Create `src/llm/summaryOutput.ts`: compact/verbose summary normalization, filtering, and deduplication.
- Create `src/llm/summaryOutput.test.ts`: summary validation tests.
- Modify `src/llm/analyze.ts`: targeted annotation repair and summary validator integration.
- Modify `src/llm/analyze.test.ts`: end-to-end repair, degradation, retry, and streaming tests.
- Modify `src/llm/analysisProviderRetry.integration.test.ts`: canonical compact provider fixture.
- Modify `CLAUDE.md`: record the compact contract and targeted repair invariant.

---

### Task 1: Shared Phrase Quality Boundary

**Files:**
- Create: `src/llm/phraseRules.ts`
- Create: `src/llm/phraseRules.test.ts`

**Interfaces:**
- Produces: `countPhraseTokens(value: string): number`
- Produces: `isAllowedLearningPhrase(phrase: string, completeCue?: string): boolean`
- The hard maximum is eight tokens; a phrase equal to a cue with more than five tokens is rejected.

- [ ] **Step 1: Write the failing phrase-rule tests**

```ts
import { describe, expect, it } from "vitest";
import { countPhraseTokens, isAllowedLearningPhrase } from "./phraseRules";

describe("learning phrase rules", () => {
  it("counts contractions and hyphenated terms as one token", () => {
    expect(countPhraseTokens("wouldn't have a state-of-the-art solver")).toBe(5);
  });

  it("accepts an eight-token fixed expression and rejects nine tokens", () => {
    expect(isAllowedLearningPhrase("one two three four five six seven eight")).toBe(true);
    expect(isAllowedLearningPhrase("one two three four five six seven eight nine")).toBe(false);
  });

  it("rejects a long complete cue but permits a short complete expression", () => {
    expect(isAllowedLearningPhrase(
      "would you mind if I opened the window",
      "Would you mind if I opened the window?",
    )).toBe(false);
    expect(isAllowedLearningPhrase("give it a shot", "Give it a shot!")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm exec vitest run src/llm/phraseRules.test.ts`

Expected: FAIL because `./phraseRules` does not exist.

- [ ] **Step 3: Implement the minimal pure phrase rules**

```ts
const TOKEN_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

export function countPhraseTokens(value: string): number {
  return value.match(TOKEN_RE)?.length ?? 0;
}

function comparable(value: string): string {
  return (value.match(TOKEN_RE) ?? []).join(" ").toLocaleLowerCase();
}

export function isAllowedLearningPhrase(
  phrase: string,
  completeCue?: string,
): boolean {
  const count = countPhraseTokens(phrase);
  if (count < 1 || count > 8) return false;
  return !(
    completeCue
    && count > 5
    && comparable(phrase) === comparable(completeCue)
  );
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `pnpm exec vitest run src/llm/phraseRules.test.ts`

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/llm/phraseRules.ts src/llm/phraseRules.test.ts
git commit -m "feat(llm): enforce learning phrase length"
```

---

### Task 2: Compact Cue Contract and Safe Compatibility Parsing

**Files:**
- Modify: `src/llm/prompts.ts`
- Modify: `src/llm/prompts.test.ts`
- Modify: `src/llm/cueOutput.ts`
- Modify: `src/llm/cueOutput.test.ts`

**Interfaces:**
- Consumes: `isAllowedLearningPhrase(phrase, completeCue)` from Task 1.
- Produces: compact cue JSONL `{ "i": number, "zh": string, "p": [[source, translation, note], ...] }`.
- Produces: `CueOutputValidation` resolved results with `needsAnnotationRepair: boolean`.
- Retains input compatibility for verbose `index/translation/highlights` and legacy `highlightWords/keyNotes/highlightTranslations`.

- [ ] **Step 1: Add failing prompt-contract tests**

Extend `src/llm/prompts.test.ts`:

```ts
it("uses the compact streaming cue schema for every provider", () => {
  const prompt = buildSystemPrompt("colloquial");
  expect(prompt).toContain('{"i":12,"zh":');
  expect(prompt).toContain('"p":[["catch up"');
  expect(prompt).toContain("one to five English words");
  expect(prompt).toContain("NEVER exceed eight English words");
  expect(prompt).not.toContain('"isKeyPoint": boolean');
  expect(prompt).not.toContain('"highlights": [{');
});
```

- [ ] **Step 2: Add failing cue-normalization tests**

Add tests to `src/llm/cueOutput.test.ts` that assert:

```ts
it("accepts compact tuples and derives isKeyPoint", () => {
  const result = validateCueOutput({
    i: 54,
    zh: "真实的堆栈问题",
    p: [["stack questions", "堆栈问题", "表示一组连续相关的问题"]],
  }, requested);
  expect(result).toMatchObject({
    status: "resolved",
    needsAnnotationRepair: false,
    subtitle: {
      translation: "真实的堆栈问题",
      isKeyPoint: true,
      highlightWords: ["stack questions"],
    },
  });
});

it("recovers the previous highlightWords maps safely", () => {
  const result = validateCueOutput({
    index: 54,
    translation: "真实的堆栈问题",
    isKeyPoint: true,
    highlightWords: ["stack questions"],
    keyNotes: { "stack questions": "表示一组连续相关的问题" },
    highlightTranslations: { "stack questions": "堆栈问题" },
  }, requested);
  expect(result).toMatchObject({
    status: "resolved",
    needsAnnotationRepair: false,
    subtitle: { highlightWords: ["stack questions"] },
  });
});

it("preserves translation and requests annotation repair for an overlong phrase", () => {
  const longSource = "actual stack questions one two three four five six";
  const longRequested = new Map([[54, { ...source, text: longSource }]]);
  const result = validateCueOutput({
    i: 54,
    zh: "这是一个完整长句",
    p: [[longSource, "完整长句", "模型错误地选中了整句"]],
  }, longRequested);
  expect(result).toMatchObject({
    status: "resolved",
    needsAnnotationRepair: true,
    subtitle: {
      translation: "这是一个完整长句",
      isKeyPoint: false,
      highlightWords: [],
    },
  });
});
```

Retain the existing verbose `highlights` test to prove compatibility.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `pnpm exec vitest run src/llm/prompts.test.ts src/llm/cueOutput.test.ts`

Expected: prompt assertions fail; compact and legacy-map results do not resolve as specified; `needsAnnotationRepair` is absent.

- [ ] **Step 4: Replace the provider-facing schema in `prompts.ts`**

Use this canonical schema and rules in `SYSTEM_PROMPT_TEMPLATE`:

```text
PER-CUE JSONL SCHEMA
{"i":12,"zh":"我得补上进度","p":[["catch up","补上","动词短语，表示赶上或补做落下的事情"]]}

i = supplied cue index.
zh = Chinese translation.
p = zero to two phrase tuples: [exact English source, exact Chinese substring, Chinese usage note].

Phrase selection:
- Prefer one to five English words.
- A genuine fixed expression, idiom, or phrasal pattern may use up to eight words.
- NEVER exceed eight English words.
- NEVER select the complete cue when it contains more than five words.
- Use p=[] when there is no useful learning phrase.
```

Remove the model-facing `isKeyPoint` and verbose `highlights` schema, but leave local compatibility parsing in code.

- [ ] **Step 5: Normalize all accepted cue shapes in `cueOutput.ts`**

Change the resolved union member to:

```ts
| {
    status: "resolved";
    index: number;
    subtitle: Subtitle;
    needsAnnotationRepair: boolean;
  }
```

Resolve identity and translation with compact-first aliases:

```ts
const index = typeof value.i === "number" ? value.i : value.index;
const rawTranslation = typeof value.zh === "string" ? value.zh : value.translation;
```

Create normalized candidates from, in order, compact `p` tuples, verbose
`highlights` objects, or legacy maps. Validate every candidate through the
existing exact-substring checks plus:

```ts
if (!isAllowedLearningPhrase(phrase, source.text)) continue;
```

Derive `isKeyPoint` solely from `highlightWords.length > 0`. Set
`needsAnnotationRepair=true` only when the response claimed or supplied
annotation intent but no candidate survived. Treat canonical `p:[]` and verbose
`highlights:[]` with `isKeyPoint !== true` as legitimately empty.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `pnpm exec vitest run src/llm/phraseRules.test.ts src/llm/prompts.test.ts src/llm/cueOutput.test.ts`

Expected: all focused tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/llm/prompts.ts src/llm/prompts.test.ts src/llm/cueOutput.ts src/llm/cueOutput.test.ts
git commit -m "feat(llm): use compact cue analysis format"
```

---

### Task 3: Targeted Annotation Repair Without Retranslation

**Files:**
- Modify: `src/llm/prompts.ts`
- Modify: `src/llm/prompts.test.ts`
- Modify: `src/llm/cueOutput.ts`
- Modify: `src/llm/cueOutput.test.ts`
- Modify: `src/llm/analyze.ts`
- Modify: `src/llm/analyze.test.ts`

**Interfaces:**
- Produces: `buildAnnotationRepairPrompt(items: readonly AnnotationRepairInput[]): string`.
- Produces: `validateAnnotationRepair(value, requested): AnnotationRepairValidation`.
- `AnnotationRepairInput` contains `index`, authoritative English `text`, and accepted Chinese `translation`.
- `resolveCueBatch` returns the original ordered subtitles after applying one targeted repair round to damaged entries.

- [ ] **Step 1: Add failing repair-prompt and repair-validator tests**

Test that the prompt contains only the damaged cue, includes its accepted
translation, requests `{ "i", "p" }`, and explicitly forbids a new translation.
Test `validateAnnotationRepair` with:

```ts
{
  i: 54,
  p: [["stack questions", "堆栈问题", "表示一组连续相关的问题"]],
}
```

Expected: a valid annotation patch for index 54. Also test an over-eight-word
tuple returns an invalid patch without altering the accepted translation.

- [ ] **Step 2: Add failing end-to-end targeted-repair tests**

In `src/llm/analyze.test.ts`, script two cues where cue 0 has a valid translation
but an overlong phrase and cue 1 is fully valid. Script a second provider
response containing only cue 0's compact `i/p` repair. Assert:

```ts
expect(provider.requests).toHaveLength(2);
expect(provider.requests[1].userPrompt).toContain("source-0");
expect(provider.requests[1].userPrompt).toContain("translation-0");
expect(provider.requests[1].userPrompt).not.toContain("source-1");
expect(provider.requests[1].userPrompt).toContain("do not translate");
expect(committedSubtitles[0].highlightWords).toEqual(["source"]);
```

Add a second test whose repair response remains malformed and assert cue 0 is
committed with its original translation, `isKeyPoint=false`, and no highlights.

Add a third test where the repair request throws `ProviderTransportError` once
and succeeds on the next attempt. Use fake timers and assert the retry event has
`kind: "transport"`; malformed repair content itself must not cause a second
content-repair request.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `pnpm exec vitest run src/llm/prompts.test.ts src/llm/cueOutput.test.ts src/llm/analyze.test.ts`

Expected: annotation-repair APIs are missing and no targeted second request occurs.

- [ ] **Step 4: Implement the repair prompt and pure patch validator**

Add:

```ts
export interface AnnotationRepairInput {
  index: number;
  text: string;
  translation: string;
}
```

The prompt serializes one JSON object per input and ends with this exact output
contract:

```text
Return one line per supplied cue: {"i":12,"p":[["English phrase","中文片段","中文用法说明"]]}
Do not translate again. Do not return zh, text, timestamps, prose, or markdown.
Use p=[] when no useful phrase exists.
```

The pure validator maps `i` to the authoritative input, validates compact tuples
with the shared phrase and substring rules, and returns either a valid subtitle
annotation patch or invalid content.

- [ ] **Step 5: Orchestrate one annotation-repair round in `analyze.ts`**

While resolving translations, keep a set of cue offsets whose resolved result
has `needsAnnotationRepair=true`. Once every translation in the batch is
resolved, call a new `repairDamagedAnnotations` helper with only those entries.

The helper must:

- retain the accepted subtitle map as source of truth;
- parse repair JSONL incrementally;
- replace only `isKeyPoint`, `highlightWords`, `keyNotes`, and
  `highlightTranslations` for valid repair entries;
- treat malformed or missing repair entries as translation-only degradation;
- retry only `isRetryableProviderFailure(error)` using
  `ANALYSIS_RETRY_POLICY`, not `ProviderProtocolError` caused by malformed
  content;
- report transport retries through `onRetry` with only damaged cue indexes;
- publish one final preview if repair changed any annotations.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `pnpm exec vitest run src/llm/phraseRules.test.ts src/llm/prompts.test.ts src/llm/cueOutput.test.ts src/llm/analyze.test.ts`

Expected: all targeted repair and existing cue recovery tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/llm/prompts.ts src/llm/prompts.test.ts src/llm/cueOutput.ts src/llm/cueOutput.test.ts src/llm/analyze.ts src/llm/analyze.test.ts
git commit -m "fix(llm): repair malformed phrase annotations"
```

---

### Task 4: Compact and Filtered Summary Output

**Files:**
- Create: `src/llm/summaryOutput.ts`
- Create: `src/llm/summaryOutput.test.ts`
- Modify: `src/llm/prompts.ts`
- Modify: `src/llm/prompts.test.ts`
- Modify: `src/llm/analyze.ts`
- Modify: `src/llm/analyze.test.ts`

**Interfaces:**
- Consumes: `isAllowedLearningPhrase(expression)` from Task 1.
- Produces: `validateSummaryOutput(value: unknown): KeyPhrase[] | null`.
- Accepts compact `{ p: [[expression, meaningZh, usage], ...] }` and verbose `{ type: "summary", keyPhrases: [...] }`.

- [ ] **Step 1: Write failing pure summary tests**

```ts
import { describe, expect, it } from "vitest";
import { validateSummaryOutput } from "./summaryOutput";

describe("validateSummaryOutput", () => {
  it("accepts compact tuples and deduplicates expressions case-insensitively", () => {
    expect(validateSummaryOutput({ p: [
      ["catch up", "补上", "用于赶上进度"],
      [" Catch Up ", "赶上", "重复项"],
    ] })).toEqual([
      { expression: "catch up", meaningZh: "补上", usage: "用于赶上进度" },
    ]);
  });

  it("drops overlong expressions without invalidating the summary", () => {
    expect(validateSummaryOutput({ p: [
      ["one two three four five six seven eight nine", "长句", "不应保留"],
      ["give it a shot", "试试看", "用于鼓励尝试"],
    ] })).toEqual([
      { expression: "give it a shot", meaningZh: "试试看", usage: "用于鼓励尝试" },
    ]);
  });

  it("continues to accept the verbose summary during migration", () => {
    expect(validateSummaryOutput({
      type: "summary",
      keyPhrases: [{ expression: "catch up", meaningZh: "补上", usage: "用于赶进度" }],
    })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the pure test and verify RED**

Run: `pnpm exec vitest run src/llm/summaryOutput.test.ts`

Expected: FAIL because `summaryOutput.ts` does not exist.

- [ ] **Step 3: Implement summary normalization**

Implement `validateSummaryOutput` to:

- return `null` when neither accepted envelope is present;
- normalize compact tuples or verbose objects into `KeyPhrase`;
- trim every string and reject empty required values;
- drop expressions failing `isAllowedLearningPhrase`;
- retain the first occurrence by `expression.toLocaleLowerCase()`;
- return `[]` as a valid summary when the envelope is valid but every phrase is filtered.

- [ ] **Step 4: Change the summary prompt and integration**

Make `buildSummaryPrompt` request exactly:

```json
{"p":[["catch up","补上","用于表示赶上进度或补做遗漏事项"]]}
```

Retain the one-line/no-prose instruction and the one-to-five/eight-word phrase
rules. Replace private `parseSummary`/`isKeyPhrase` in `analyze.ts` with
`validateSummaryOutput`.

Update existing summary fixtures in `analyze.test.ts` to compact output while
keeping one explicit verbose compatibility case. Assert an all-overlong compact
summary commits `keyPhrases: []` and advances the checkpoint to `complete`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm exec vitest run src/llm/summaryOutput.test.ts src/llm/prompts.test.ts src/llm/analyze.test.ts`

Expected: summary tests and all existing analysis tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/llm/summaryOutput.ts src/llm/summaryOutput.test.ts src/llm/prompts.ts src/llm/prompts.test.ts src/llm/analyze.ts src/llm/analyze.test.ts
git commit -m "feat(llm): simplify key phrase summary output"
```

---

### Task 5: Provider Regression Gate and Architecture Documentation

**Files:**
- Modify: `src/llm/analysisProviderRetry.integration.test.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: compact cue schema and provider-independent parser from Tasks 1–4.
- Produces: cross-provider regression evidence and durable architecture notes.

- [ ] **Step 1: Update provider fixtures to canonical compact JSONL**

Use:

```ts
const cueJsonLine = `${JSON.stringify({ i: 51, zh: "translation-51", p: [] })}\n`;
```

Run: `pnpm exec vitest run src/llm/analysisProviderRetry.integration.test.ts`

Expected: Claude and Gemini transport-retry integration tests PASS using the new
canonical content format.

- [ ] **Step 2: Update the architecture invariant in `CLAUDE.md`**

Replace the existing JSON Lines bullet with a concise statement that records:

- canonical cue output is `{i,zh,p}` JSONL;
- `p` contains `[source, translation, note]` tuples;
- `isKeyPoint` is derived locally;
- old verbose shapes are input-only compatibility paths;
- phrase limits are one-to-five preferred and eight hard maximum;
- valid translations survive damaged annotations;
- only damaged annotations receive one targeted repair round.

- [ ] **Step 3: Run the complete verification gate**

Run:

```powershell
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected:

- every Vitest file passes;
- TypeScript exits 0;
- Vite production build exits 0;
- `git diff --check` prints no errors.

- [ ] **Step 4: Commit**

```powershell
git add src/llm/analysisProviderRetry.integration.test.ts CLAUDE.md
git commit -m "docs(llm): record compact phrase analysis contract"
```

- [ ] **Step 5: Request code review**

Review the complete branch against
`docs/superpowers/specs/2026-08-14-key-phrase-quality-design.md`, with particular
attention to malformed-annotation degradation, transport-only repair retries,
legacy compatibility, and whether any provider-specific branch was introduced.
