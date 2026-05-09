# 任意单词 / 短语收藏到词汇本 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在视频播放页右栏字幕里拖蓝任意单词/短语，可选择性调用 LLM 拿中文释义，再收藏到词汇本；已收藏的词重选时直接编辑、debounce 自动保存。

**Architecture:** 新增 `SubtitleSelectionBubble` 组件挂到 `SubtitleList` 内部，监听 `mouseup` + `selectionchange` 触发气泡。LLM 查词复用现有 `Provider.stream` 接口，把所有 chunk 拼起来一次性 `JSON.parse`（不走流式渲染管线）。草稿存到 `localStorage`，已收藏态的 inputs 改动 debounce 500ms 后调 `vocab_add` upsert。已收藏的词在字幕原文里加 zinc dashed underline。

**Tech Stack:** React 19 + TypeScript + Tailwind v3 + zustand · Vitest + @testing-library/react + happy-dom · Tauri 2 invoke (`vocab_list / vocab_add / vocab_remove`)

**Spec:** [docs/superpowers/specs/2026-05-08-arbitrary-vocab-add-design.md](../specs/2026-05-08-arbitrary-vocab-add-design.md)

---

## File map

```
新增
  src/llm/lookupExpression.ts                       (~50 行)
  src/llm/lookupExpression.test.ts
  src/store/vocabDraft.ts                           (~40 行)
  src/store/vocabDraft.test.ts
  src/components/SubtitleSelectionBubble.tsx        (~280 行)
  src/utils/normalizeExpression.ts                  (~15 行)
  src/utils/normalizeExpression.test.ts

改动
  src/llm/prompts.ts                                (新增 buildLookupPrompt)
  src/components/SubtitleList.tsx                   (挂载气泡 + 虚线下划线 + 透传 props)
  src/pages/Player.tsx                              (透传 videoId / videoTitle 给 SubtitleList)
```

---

## Task 1: 新增 `buildLookupPrompt`

**Files:**
- Modify: `src/llm/prompts.ts` (append at file end)

- [ ] **Step 1: Write the failing test**

Create `src/llm/prompts.lookup.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildLookupPrompt } from "./prompts";

describe("buildLookupPrompt", () => {
  it("includes expression and cue text in the prompt", () => {
    const out = buildLookupPrompt("apparently", "She apparently left early.");
    expect(out).toContain("apparently");
    expect(out).toContain("She apparently left early.");
  });

  it("requests strict JSON object with two fields", () => {
    const out = buildLookupPrompt("catch up", "I need to catch up on emails");
    expect(out).toMatch(/JSON/);
    expect(out).toContain("meaningZh");
    expect(out).toContain("usage");
  });

  it("escapes nothing — passes raw cue text including quotes", () => {
    const out = buildLookupPrompt("uh", `He said "uh" a lot.`);
    expect(out).toContain(`He said "uh" a lot.`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && pnpm test -- src/llm/prompts.lookup.test.ts`
Expected: FAIL with "buildLookupPrompt is not exported" or similar.

- [ ] **Step 3: Add the function to `src/llm/prompts.ts`**

Append to the end of the file:

```ts
/**
 * Single-shot lookup of a user-selected word or short phrase. Used by the
 * subtitle selection bubble to fetch a Chinese gloss + usage for arbitrary
 * vocab adds (separate from the per-cue analysis pipeline).
 *
 * Output is parsed by `lookupExpression.ts` as a single JSON object.
 */
export function buildLookupPrompt(expression: string, cueText: string): string {
  return `请给出下面英文单词或短语的中文释义和简短中文用法说明。结合上下文判断在这一句里的具体含义。

单词/短语：${expression}

上下文：${cueText}

输出严格的 JSON 对象，只能包含两个字段，不要任何其他文字、Markdown 代码块、注释：

{"meaningZh": "中文释义（10-30 字）", "usage": "中文用法说明（30-80 字，举一个简单例子或描述使用语境）"}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && pnpm test -- src/llm/prompts.lookup.test.ts`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/llm/prompts.ts client/src/llm/prompts.lookup.test.ts
git commit -m "feat(llm): add buildLookupPrompt for vocab single-word lookup"
```

---

## Task 2: `lookupExpression` 模块

封装一次性 LLM 查词调用。复用现有 `Provider.stream`，收集所有 chunk 拼成完整字符串，再 `JSON.parse`。

**Files:**
- Create: `src/llm/lookupExpression.ts`
- Test: `src/llm/lookupExpression.test.ts`

- [ ] **Step 1: Write the failing test**

`src/llm/lookupExpression.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { lookupExpression, extractJsonObject } from "./lookupExpression";
import type { Provider } from "./providers/types";

function mockProvider(chunks: string[]): Provider {
  return {
    async *stream() {
      for (const c of chunks) yield c;
    },
  };
}

describe("extractJsonObject", () => {
  it("returns the input when it's already plain JSON", () => {
    expect(extractJsonObject(`{"a":1}`)).toBe(`{"a":1}`);
  });

  it("strips ```json fences", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe(`{"a":1}`);
  });

  it("strips bare ``` fences", () => {
    expect(extractJsonObject("```\n{\"a\":1}\n```")).toBe(`{"a":1}`);
  });

  it("strips leading prose", () => {
    expect(extractJsonObject(`好的，结果是：{"a":1}`)).toBe(`{"a":1}`);
  });

  it("handles trailing prose", () => {
    expect(extractJsonObject(`{"a":1}\n以上是结果`)).toBe(`{"a":1}`);
  });

  it("picks first { to last } when nested", () => {
    expect(extractJsonObject(`junk{"a":{"b":1}}tail`)).toBe(`{"a":{"b":1}}`);
  });
});

describe("lookupExpression", () => {
  it("parses JSON from streamed chunks", async () => {
    const provider = mockProvider([
      `{"meaningZh":"显然`,
      `","usage":"口语里表达..."}`,
    ]);
    const result = await lookupExpression("apparently", "She apparently left.", provider);
    expect(result).toEqual({ meaningZh: "显然", usage: "口语里表达..." });
  });

  it("strips markdown code fence", async () => {
    const provider = mockProvider([
      "```json\n",
      `{"meaningZh":"显然","usage":"x"}`,
      "\n```",
    ]);
    const result = await lookupExpression("apparently", "ctx", provider);
    expect(result).toEqual({ meaningZh: "显然", usage: "x" });
  });

  it("trims whitespace in fields", async () => {
    const provider = mockProvider([`{"meaningZh":"  显然  ","usage":" "}`]);
    const result = await lookupExpression("apparently", "ctx", provider);
    expect(result).toEqual({ meaningZh: "显然", usage: "" });
  });

  it("coerces missing fields to empty string", async () => {
    const provider = mockProvider([`{"meaningZh":"显然"}`]);
    const result = await lookupExpression("apparently", "ctx", provider);
    expect(result).toEqual({ meaningZh: "显然", usage: "" });
  });

  it("propagates AbortError", async () => {
    const provider: Provider = {
      async *stream() {
        const err = new DOMException("aborted", "AbortError");
        throw err;
      },
    };
    await expect(lookupExpression("x", "y", provider)).rejects.toThrow(/aborted/i);
  });

  it("throws on unparseable response", async () => {
    const provider = mockProvider(["not json at all"]);
    await expect(lookupExpression("x", "y", provider)).rejects.toThrow();
  });

  it("passes signal through to provider", async () => {
    const stream = vi.fn(async function* () {
      yield `{"meaningZh":"x","usage":"y"}`;
    });
    const provider: Provider = { stream };
    const ctrl = new AbortController();
    await lookupExpression("a", "b", provider, ctrl.signal);
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({ signal: ctrl.signal })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && pnpm test -- src/llm/lookupExpression.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/llm/lookupExpression.ts`**

```ts
import type { Provider } from "./providers/types";
import { buildLookupPrompt } from "./prompts";

export interface LookupResult {
  meaningZh: string;
  usage: string;
}

const SYSTEM = "You are a precise English-to-Chinese vocabulary helper. Output only the requested JSON object.";

export async function lookupExpression(
  expression: string,
  cueText: string,
  provider: Provider,
  signal?: AbortSignal,
): Promise<LookupResult> {
  let buffer = "";
  for await (const chunk of provider.stream({
    systemPrompt: SYSTEM,
    userPrompt: buildLookupPrompt(expression, cueText),
    signal,
  })) {
    buffer += chunk;
  }
  const json = extractJsonObject(buffer);
  const parsed = JSON.parse(json) as Partial<LookupResult>;
  return {
    meaningZh: String(parsed.meaningZh ?? "").trim(),
    usage: String(parsed.usage ?? "").trim(),
  };
}

/**
 * Tolerant extractor: strips ```json``` / ``` fences and any prose before the
 * first `{` or after the last `}`. LLMs occasionally wrap output despite the
 * "no fences, no prose" instruction in the prompt.
 */
export function extractJsonObject(raw: string): string {
  let s = raw.trim();
  // Strip fenced code block, both ```json and bare ```
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const m = s.match(fence);
  if (m) s = m[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return s;
  return s.slice(first, last + 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && pnpm test -- src/llm/lookupExpression.test.ts`
Expected: 13 PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/llm/lookupExpression.ts client/src/llm/lookupExpression.test.ts
git commit -m "feat(llm): add lookupExpression for single-word vocab queries"
```

---

## Task 3: `vocabDraft` 模块（localStorage 草稿）

读、写、清三个纯函数；`makeVocabId` 复用 `types/vocab.ts` 的实现。

**Files:**
- Create: `src/store/vocabDraft.ts`
- Test: `src/store/vocabDraft.test.ts`

- [ ] **Step 1: Write the failing test**

`src/store/vocabDraft.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadDraft, saveDraft, clearDraft, type VocabDraft } from "./vocabDraft";

beforeEach(() => {
  window.localStorage.clear();
});

const sample: VocabDraft = {
  expression: "apparently",
  meaningZh: "显然",
  usage: "口语里表达听上去像那么回事",
  cueText: "She apparently left early.",
  cueTime: 12.3,
  videoId: "vid1",
  videoTitle: "Episode 1",
  updatedAt: "2026-05-08T10:00:00.000Z",
};

describe("vocabDraft", () => {
  it("returns null when no draft exists", () => {
    expect(loadDraft("apparently")).toBeNull();
  });

  it("saves and loads round-trip", () => {
    saveDraft(sample);
    const loaded = loadDraft("apparently");
    expect(loaded).toEqual(sample);
  });

  it("normalizes expression key (case-insensitive)", () => {
    saveDraft({ ...sample, expression: "Apparently" });
    expect(loadDraft("apparently")).not.toBeNull();
    expect(loadDraft("APPARENTLY")).not.toBeNull();
  });

  it("clearDraft removes the entry", () => {
    saveDraft(sample);
    clearDraft("apparently");
    expect(loadDraft("apparently")).toBeNull();
  });

  it("returns null on corrupt JSON", () => {
    window.localStorage.setItem("whatsub:vocab-draft:bad", "{not json");
    expect(loadDraft("bad")).toBeNull();
  });

  it("does not throw if localStorage is empty", () => {
    expect(() => clearDraft("nonexistent")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && pnpm test -- src/store/vocabDraft.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/store/vocabDraft.ts`**

```ts
import { makeVocabId } from "../types/vocab";

export interface VocabDraft {
  expression: string;
  meaningZh: string;
  usage: string;
  cueText: string;
  cueTime: number;
  videoId: string;
  videoTitle: string;
  updatedAt: string;
}

const PREFIX = "whatsub:vocab-draft:";

function key(expression: string): string {
  return PREFIX + makeVocabId(expression);
}

export function loadDraft(expression: string): VocabDraft | null {
  try {
    const raw = window.localStorage.getItem(key(expression));
    if (!raw) return null;
    return JSON.parse(raw) as VocabDraft;
  } catch {
    return null;
  }
}

export function saveDraft(draft: VocabDraft): void {
  window.localStorage.setItem(key(draft.expression), JSON.stringify(draft));
}

export function clearDraft(expression: string): void {
  window.localStorage.removeItem(key(expression));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && pnpm test -- src/store/vocabDraft.test.ts`
Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/store/vocabDraft.ts client/src/store/vocabDraft.test.ts
git commit -m "feat(vocab): add localStorage draft persistence helpers"
```

---

## Task 4: `normalizeExpression` 工具

提取选区文本时去掉首尾空白和标点。单独抽出来是因为气泡和（未来潜在的）其他入口都要用同一套规则。

**Files:**
- Create: `src/utils/normalizeExpression.ts`
- Test: `src/utils/normalizeExpression.test.ts`

- [ ] **Step 1: Write the failing test**

`src/utils/normalizeExpression.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeExpression } from "./normalizeExpression";

describe("normalizeExpression", () => {
  it("returns trimmed text unchanged when no edge punctuation", () => {
    expect(normalizeExpression("apparently")).toBe("apparently");
  });

  it("strips trailing comma", () => {
    expect(normalizeExpression("apparently,")).toBe("apparently");
  });

  it("strips leading and trailing punctuation", () => {
    expect(normalizeExpression('"apparently!"')).toBe("apparently");
  });

  it("preserves internal apostrophes and hyphens", () => {
    expect(normalizeExpression("can't help")).toBe("can't help");
    expect(normalizeExpression("state-of-the-art")).toBe("state-of-the-art");
  });

  it("trims whitespace", () => {
    expect(normalizeExpression("  catch up  ")).toBe("catch up");
  });

  it("returns empty for whitespace-only", () => {
    expect(normalizeExpression("   ")).toBe("");
  });

  it("returns empty for punctuation-only", () => {
    expect(normalizeExpression(".,!?")).toBe("");
  });

  it("collapses internal multiple spaces to single space", () => {
    expect(normalizeExpression("catch  up")).toBe("catch up");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && pnpm test -- src/utils/normalizeExpression.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/utils/normalizeExpression.ts`**

```ts
const EDGE_PUNCT = /^[\s,.!?;:"'(){}[\]]+|[\s,.!?;:"'(){}[\]]+$/g;

/**
 * Trim whitespace and edge punctuation from a user selection. Internal
 * apostrophes and hyphens (can't, state-of-the-art) are preserved. Multiple
 * internal spaces collapse to one.
 */
export function normalizeExpression(raw: string): string {
  return raw.replace(EDGE_PUNCT, "").replace(/\s+/g, " ");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && pnpm test -- src/utils/normalizeExpression.test.ts`
Expected: 8 PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/normalizeExpression.ts client/src/utils/normalizeExpression.test.ts
git commit -m "feat(utils): add normalizeExpression for selection cleanup"
```

---

## Task 5: SubtitleList — 字幕原文「已收藏」虚线下划线

把 `renderEnglishWithHighlights` 改为接受 `vocabSet` 参数，在剩余纯文本片段里做第二层切片。LLM 黄色高亮优先（先切），剩下的部分再扫描 vocab 命中加 dashed underline。

**Files:**
- Modify: `src/components/SubtitleList.tsx`
- Test: `src/components/SubtitleList.render.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

`src/components/SubtitleList.render.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { renderEnglishWithHighlights } from "./SubtitleList";
import type { Subtitle } from "../llm/types";

const cue = (overrides: Partial<Subtitle> = {}): Subtitle => ({
  time: 0,
  endTime: 1,
  text: "I need to catch up on emails apparently",
  translation: "我得追一下邮件显然",
  isKeyPoint: false,
  highlightWords: [],
  keyNotes: {},
  highlightTranslations: {},
  ...overrides,
});

describe("renderEnglishWithHighlights", () => {
  it("renders plain text when neither LLM highlight nor vocab match", () => {
    const { container } = render(
      <div>{renderEnglishWithHighlights(cue(), new Set())}</div>
    );
    expect(container.querySelectorAll("[data-highlight]")).toHaveLength(0);
    expect(container.textContent).toBe("I need to catch up on emails apparently");
  });

  it("wraps a vocab hit in a dashed-underline span", () => {
    const { container } = render(
      <div>{renderEnglishWithHighlights(cue(), new Set(["apparently"]))}</div>
    );
    const spans = container.querySelectorAll("[data-highlight=\"true\"]");
    expect(spans.length).toBe(1);
    expect(spans[0].textContent).toBe("apparently");
    expect(spans[0].className).toContain("border-dashed");
  });

  it("matches case-insensitively (vocab id is lowercased)", () => {
    const c = cue({ text: "Apparently it's late" });
    const { container } = render(
      <div>{renderEnglishWithHighlights(c, new Set(["apparently"]))}</div>
    );
    const spans = container.querySelectorAll("[data-highlight=\"true\"]");
    expect(spans.length).toBe(1);
    expect(spans[0].textContent).toBe("Apparently");
  });

  it("LLM yellow highlight takes precedence over vocab dashed underline for overlapping ranges", () => {
    // 'catch up' is both an LLM highlightWord and in vocab. Should render yellow only.
    const c = cue({
      text: "I catch up later",
      highlightWords: ["catch up"],
      keyNotes: { "catch up": "动词短语" },
      highlightTranslations: { "catch up": "追上" },
    });
    const { container } = render(
      <div>{renderEnglishWithHighlights(c, new Set(["catch up"]))}</div>
    );
    // Only one highlight span total — the yellow one. No double-wrapping.
    const all = container.querySelectorAll("[data-highlight=\"true\"]");
    expect(all.length).toBe(1);
    // Yellow style → bg-yellow / amber, not border-dashed
    expect(all[0].className).not.toContain("border-dashed");
  });

  it("renders both LLM highlight and a separate vocab match in same cue", () => {
    const c = cue({
      text: "I catch up on emails apparently",
      highlightWords: ["catch up"],
      keyNotes: { "catch up": "动词短语" },
      highlightTranslations: { "catch up": "追上" },
    });
    const { container } = render(
      <div>{renderEnglishWithHighlights(c, new Set(["apparently"]))}</div>
    );
    const all = container.querySelectorAll("[data-highlight=\"true\"]");
    expect(all.length).toBe(2);
    const dashed = container.querySelectorAll(".border-dashed");
    expect(dashed.length).toBe(1);
    expect(dashed[0].textContent).toBe("apparently");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && pnpm test -- src/components/SubtitleList.render.test.tsx`
Expected: FAIL — `renderEnglishWithHighlights` either not exported or doesn't accept the second arg.

- [ ] **Step 3: Modify `src/components/SubtitleList.tsx`**

Two changes — export `renderEnglishWithHighlights` (so the test can import it) and accept `vocabSet`. Then update its caller in the same file.

3a. At the bottom of the file, replace the existing `renderEnglishWithHighlights` (currently `function renderEnglishWithHighlights(s: Subtitle): ReactNode`) with the exported version below:

```tsx
export function renderEnglishWithHighlights(
  s: Subtitle,
  vocabSet: Set<string>,
): ReactNode {
  // Pass 1: LLM highlightWords (yellow + keyNote tooltip).
  const llmWords = [...s.highlightWords].sort(
    (a, b) => s.text.indexOf(a) - s.text.indexOf(b)
  );
  const tokens = sliceWithSpans(s.text, llmWords, (w) => (
    <HighlightWord key={`${w}-${s.text.indexOf(w)}`} word={w} note={s.keyNotes[w]} />
  ));

  // Pass 2: in each plain-text token, find vocab matches (case-insensitive,
  // longest first to handle phrase before single-word).
  if (vocabSet.size === 0) return tokens;
  const vocabPhrases = [...vocabSet].sort((a, b) => b.length - a.length);
  return tokens.flatMap((tok, i) => {
    if (typeof tok !== "string") return [tok];
    return spliceVocabUnderlines(tok, vocabPhrases, i);
  });
}

function spliceVocabUnderlines(
  text: string,
  phrasesLowercased: string[],
  baseKey: number,
): ReactNode[] {
  const lower = text.toLowerCase();
  // Find non-overlapping match ranges (start, end, originalCase).
  type Hit = { start: number; end: number };
  const hits: Hit[] = [];
  for (const phrase of phrasesLowercased) {
    let from = 0;
    while (true) {
      const idx = lower.indexOf(phrase, from);
      if (idx === -1) break;
      const end = idx + phrase.length;
      // Skip if overlaps an earlier accepted hit.
      const conflicts = hits.some((h) => idx < h.end && end > h.start);
      if (!conflicts) hits.push({ start: idx, end });
      from = end;
    }
  }
  hits.sort((a, b) => a.start - b.start);
  if (hits.length === 0) return [text];
  const out: ReactNode[] = [];
  let cursor = 0;
  hits.forEach((h, i) => {
    if (h.start > cursor) out.push(text.slice(cursor, h.start));
    out.push(
      <span
        key={`vocab-${baseKey}-${i}`}
        data-highlight="true"
        title="已收藏"
        className="border-b border-dashed border-zinc-500/70"
      >
        {text.slice(h.start, h.end)}
      </span>
    );
    cursor = h.end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

// Note: `renderWithSpans` (the existing helper at file end) is renamed to
// `sliceWithSpans` and otherwise unchanged. Update its existing callers
// (renderTranslationWithHighlights below) to use the new name.
function sliceWithSpans(
  text: string,
  phrases: string[],
  wrap: (phrase: string, key: string) => ReactNode
): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const p of phrases) {
    if (!p) continue;
    const idx = text.indexOf(p, cursor);
    if (idx === -1) continue;
    if (idx > cursor) out.push(text.slice(cursor, idx));
    out.push(wrap(p, `${p}-${idx}`));
    cursor = idx + p.length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
```

3b. Delete the old `renderWithSpans` declaration at the bottom of the file (it's now replaced by `sliceWithSpans` above).

3c. Update `renderTranslationWithHighlights` (inside the same file, just above the old `renderWithSpans`) to call `sliceWithSpans` instead of `renderWithSpans`. Find:

```tsx
return renderWithSpans(s.translation, sorted, (zh, key) => (
```

Replace `renderWithSpans` with `sliceWithSpans`.

3d. Update the in-file caller. In the `subtitles.map((s, i) => { ... })` block, replace:

```tsx
{renderEnglishWithHighlights(s)}
```

with:

```tsx
{renderEnglishWithHighlights(s, vocabSet)}
```

3e. Add the `vocabSet` prop. Replace the `Props` interface above the component function with:

```tsx
interface Props {
  subtitles: Subtitle[];
  currentIdx: number;
  onJump: (timeSec: number) => void;
  autoScroll: boolean;
  editing: boolean;
  onChanged?: () => void;
  /** Lowercased expressions saved in vocab for THIS video. Used to render
   *  dashed underlines on already-saved words. Computed in Player.tsx via
   *  useMemo over useVocabulary().entries filtered by videoId. */
  vocabSet: Set<string>;
}
```

Replace the destructured props in the `SubtitleList(...)` function signature with:

```tsx
export function SubtitleList({
  subtitles,
  currentIdx,
  onJump,
  autoScroll,
  editing,
  onChanged,
  vocabSet,
}: Props) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && pnpm test -- src/components/SubtitleList.render.test.tsx`
Expected: 5 PASS.

- [ ] **Step 5: Run tests; typecheck is expected to fail at one site**

Run: `cd client && pnpm test`
Expected: all tests PASS (5 new + all previously passing).

Run: `cd client && pnpm typecheck`
Expected: FAILS with exactly one error in `src/pages/Player.tsx`: missing required prop `vocabSet` on `<SubtitleList>`. Task 6 fixes this. **Do not proceed to commit until tests pass; the typecheck failure is expected and resolved by the next task.**

- [ ] **Step 6: Commit**

```bash
git add client/src/components/SubtitleList.tsx client/src/components/SubtitleList.render.test.tsx
git commit -m "feat(subtitle): dashed-underline already-saved vocab in subtitle text"
```

---

## Task 6: Player.tsx — 透传 videoId/title + 计算 vocabSet

`SubtitleSelectionBubble` 在 Task 7 才创建。本任务先把 SubtitleList 的接口改完整、解决 typecheck 错误。

**Files:**
- Modify: `src/pages/Player.tsx`
- Modify: `src/components/SubtitleList.tsx` (add 2 new optional props for the bubble integration; pass-through only)

- [ ] **Step 1: Add bubble-related props (placeholder) to SubtitleList**

In `src/components/SubtitleList.tsx`, extend the `Props` interface:

```tsx
interface Props {
  subtitles: Subtitle[];
  currentIdx: number;
  onJump: (timeSec: number) => void;
  autoScroll: boolean;
  editing: boolean;
  onChanged?: () => void;
  vocabSet: Set<string>;
  /** Used by SubtitleSelectionBubble to record which video an entry came from. */
  videoId: string;
  videoTitle: string;
}
```

Update the function signature:

```tsx
export function SubtitleList({
  subtitles,
  currentIdx,
  onJump,
  autoScroll,
  editing,
  onChanged,
  vocabSet,
  videoId: _videoId,        // wired up in Task 7
  videoTitle: _videoTitle,
}: Props) {
```

`_`-prefix to silence the unused-var warning until Task 7.

- [ ] **Step 2: Update Player.tsx caller**

In `src/pages/Player.tsx`, find the `<SubtitleList ... />` JSX (around line 568):

```tsx
{tab === "subtitles" && (
  <SubtitleList
    subtitles={analysis.subtitles}
    currentIdx={currentIdx}
    onJump={jump}
    autoScroll={autoScrollSubtitle}
    editing={editingSubtitle}
    onChanged={schedulePartialSave}
  />
)}
```

Replace with:

```tsx
{tab === "subtitles" && (
  <SubtitleList
    subtitles={analysis.subtitles}
    currentIdx={currentIdx}
    onJump={jump}
    autoScroll={autoScrollSubtitle}
    editing={editingSubtitle}
    onChanged={schedulePartialSave}
    vocabSet={vocabSetForVideo}
    videoId={videoId ?? ""}
    videoTitle={entry?.title ?? videoId ?? ""}
  />
)}
```

Add `vocabSetForVideo` calculation. Just below the line `const currentIdx = useVideoSync(videoRef, analysis.subtitles);` (around line 404), insert:

```tsx
// Lowercased expressions saved in vocab for the CURRENT video. Used by
// SubtitleList to render dashed underlines on already-saved words.
// Recomputed when entries or videoId change.
const vocabSetForVideo = useMemo(
  () =>
    new Set(
      vocab.entries
        .filter((e) => e.videoId === videoId)
        .map((e) => e.id)
    ),
  [vocab.entries, videoId]
);
```

Add `useMemo` to the React import at the top of the file:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
```

- [ ] **Step 3: Run typecheck and tests**

Run: `cd client && pnpm typecheck && pnpm test`
Expected: typecheck PASS; all tests PASS.

- [ ] **Step 4: Sanity manual check**

Run: `cd client && pnpm tauri dev`

Open a video that has at least one analyzed cue. Manually call `useVocabulary.getState().add({...})` from the dev console (or use the existing KeyPhrase ⭐ button) to save a phrase that appears in a cue, then refresh the player page. The phrase should appear with a faint dashed underline in the subtitle text. Yellow LLM highlights should still render normally. **DO NOT skip this step** — it's the only quick way to confirm Task 5's render path is wired before the bubble lands.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/SubtitleList.tsx client/src/pages/Player.tsx
git commit -m "feat(player): pass videoId/title/vocabSet to SubtitleList"
```

---

## Task 7: SubtitleSelectionBubble — 骨架 + 选区检测 + 折叠态 UI + 直接收藏

第一个能 run 起来的版本。能选词 → 弹气泡 → 点 ⭐ 直接收藏（meaningZh / usage 留空）。还没有 LLM 查词、没有动画、没有草稿、没有 outside-click 关闭。

**Files:**
- Create: `src/components/SubtitleSelectionBubble.tsx`
- Modify: `src/components/SubtitleList.tsx` (mount bubble, expose listRef-aware logic)

- [ ] **Step 1: Create the component file**

`src/components/SubtitleSelectionBubble.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Search, Star } from "lucide-react";
import type { Subtitle } from "../llm/types";
import { useVocabulary } from "../store/vocab";
import { normalizeExpression } from "../utils/normalizeExpression";

interface SelectionInfo {
  expression: string;
  cueIdx: number;
  cueText: string;
  cueTime: number;
  rect: DOMRect;
}

interface Props {
  /** The list container the bubble watches for selection events. */
  listRef: React.RefObject<HTMLDivElement | null>;
  subtitles: Subtitle[];
  videoId: string;
  videoTitle: string;
  /** Disable the bubble entirely (e.g. in subtitle edit mode). */
  disabled: boolean;
}

/**
 * Floating bubble that appears above any text the user drag-selects inside
 * the subtitle list. Lets them ⭐ directly save with empty meaning, or click
 * 🔍 to fetch a Chinese gloss + usage from the LLM (added in Task 8).
 */
export function SubtitleSelectionBubble({
  listRef,
  subtitles,
  videoId,
  videoTitle,
  disabled,
}: Props) {
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  const { has, toggle } = useVocabulary();

  // Detect a valid selection on mouseup inside the list container.
  useEffect(() => {
    if (disabled) return;
    const list = listRef.current;
    if (!list) return;
    const onMouseUp = () => {
      // Defer until selection settles after the click that ends drag.
      setTimeout(() => setInfo(readSelection(list, subtitles)), 0);
    };
    list.addEventListener("mouseup", onMouseUp);
    return () => list.removeEventListener("mouseup", onMouseUp);
  }, [listRef, subtitles, disabled]);

  // Hide if selection is cleared elsewhere (e.g. clicking the video).
  useEffect(() => {
    if (!info) return;
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setInfo(null);
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, [info]);

  if (!info) return null;

  const saved = has(info.expression);
  const top = Math.max(8, info.rect.top - 44);
  const left = clampLeft(info.rect.left + info.rect.width / 2 - 120);

  const onStar = async () => {
    await toggle({
      expression: info.expression,
      meaningZh: "",
      usage: "",
      videoId,
      videoTitle,
      cueTime: info.cueTime,
      cueText: info.cueText,
    });
    setInfo(null);
    // Clear browser selection so it doesn't immediately re-pop.
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div
      style={{ position: "fixed", top, left, width: 240 }}
      className="z-50 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 shadow-xl backdrop-blur"
    >
      <span
        className="flex-1 truncate text-sm text-zinc-100"
        title={info.expression}
      >
        {info.expression}
      </span>
      <button
        type="button"
        title="LLM 查词（Task 8 后启用）"
        disabled
        className="flex h-7 items-center gap-1 rounded px-2 text-xs text-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
      >
        <Search className="h-3.5 w-3.5" />
        查词
      </button>
      <button
        type="button"
        onClick={onStar}
        title={saved ? "已收藏 · 点击移除" : "收藏到我的词汇本"}
        className={
          "flex h-7 w-7 items-center justify-center rounded-full transition-colors " +
          (saved
            ? "text-amber-300 hover:bg-amber-900/30"
            : "text-zinc-400 hover:bg-zinc-800 hover:text-amber-300")
        }
      >
        <Star className="h-4 w-4" fill={saved ? "currentColor" : "none"} />
      </button>
    </div>
  );
}

/**
 * Read the current selection. Returns null if:
 *  - no selection / collapsed
 *  - normalized text is empty
 *  - anchor and focus aren't inside the same cue
 */
function readSelection(
  list: HTMLDivElement,
  subtitles: Subtitle[],
): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  // Both ends must be within the list.
  if (
    !list.contains(range.startContainer) ||
    !list.contains(range.endContainer)
  )
    return null;

  const startCue = closestCue(range.startContainer);
  const endCue = closestCue(range.endContainer);
  if (!startCue || !endCue || startCue !== endCue) return null;

  const idxStr = startCue.getAttribute("data-idx");
  if (!idxStr) return null;
  const cueIdx = Number(idxStr);
  const sub = subtitles[cueIdx];
  if (!sub) return null;

  const expression = normalizeExpression(sel.toString());
  if (!expression) return null;

  const rect = range.getBoundingClientRect();
  return {
    expression,
    cueIdx,
    cueText: sub.text,
    cueTime: sub.time,
    rect,
  };
}

function closestCue(node: Node): HTMLElement | null {
  let n: Node | null = node;
  while (n && n.nodeType !== Node.ELEMENT_NODE) n = n.parentNode;
  if (!n) return null;
  const el = n as HTMLElement;
  return el.closest<HTMLElement>("[data-idx]");
}

function clampLeft(x: number): number {
  const min = 8;
  const max = (typeof window !== "undefined" ? window.innerWidth : 1200) - 248;
  return Math.max(min, Math.min(x, max));
}
```

- [ ] **Step 2: Mount the bubble inside SubtitleList**

In `src/components/SubtitleList.tsx`:

2a. Add the import at the top:

```tsx
import { SubtitleSelectionBubble } from "./SubtitleSelectionBubble";
```

2b. Use the previously underscored props:

```tsx
videoId,
videoTitle,
```

(remove the leading underscores)

2c. Inside the returned JSX, just before the closing `</div>` of the listRef container, mount the bubble:

```tsx
return (
  <div ref={listRef} className="overflow-y-auto h-full">
    {subtitles.length === 0 ? (
      // ... existing empty state ...
    ) : (
      // ... existing subtitles.map ...
    )}
    <SubtitleSelectionBubble
      listRef={listRef}
      subtitles={subtitles}
      videoId={videoId}
      videoTitle={videoTitle}
      disabled={editing}
    />
  </div>
);
```

- [ ] **Step 3: Run typecheck**

Run: `cd client && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Manual smoke test**

Run: `cd client && pnpm tauri dev`

In a video with subtitles:
- Drag-select a word in a cue → bubble should appear above selection with the word + disabled 查词 button + ⭐
- Click ⭐ → vocab should pick up the word (check via Library → ⭐ link → see "apparently" entry with empty meaningZh, cueText filled)
- Drag-select again across two cues → no bubble
- Toggle "✎ 编辑：开" → drag-select → no bubble (disabled)
- Drag-select an already-saved word → bubble shows ⭐ FILLED → click ⭐ → entry removed
- Drag-select with leading/trailing punctuation `"apparently,"` → bubble shows just "apparently"

Don't proceed if any of these fail. Common gotcha: if the bubble appears but flashes off immediately, check the `selectionchange` listener isn't clearing prematurely on `mouseup`.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/SubtitleSelectionBubble.tsx client/src/components/SubtitleList.tsx
git commit -m "feat(subtitle): bubble for arbitrary vocab add (skeleton, direct ⭐ only)"
```

---

## Task 8: Bubble — 🔍 LLM 查词 + 展开输入区

接通 `lookupExpression`、加 `expanded` 状态、加 inputs。⭐ 现在带上当前 inputs 值保存。

**Files:**
- Modify: `src/components/SubtitleSelectionBubble.tsx`

- [ ] **Step 1: Add state types and LLM wiring**

Replace the imports block at the top of `SubtitleSelectionBubble.tsx` with:

```tsx
import { useEffect, useRef, useState } from "react";
import { Search, Star, Loader2, AlertCircle } from "lucide-react";
import type { Subtitle } from "../llm/types";
import { useVocabulary } from "../store/vocab";
import { useSettings } from "../store/settings";
import { normalizeExpression } from "../utils/normalizeExpression";
import { lookupExpression } from "../llm/lookupExpression";
import { getProvider } from "../llm/providers";
```

- [ ] **Step 2: Replace the component body to add expanded state**

Replace the entire `export function SubtitleSelectionBubble(...)` body (everything between `export function ...` and the next `function readSelection`) with:

```tsx
type LookupState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string };

export function SubtitleSelectionBubble({
  listRef,
  subtitles,
  videoId,
  videoTitle,
  disabled,
}: Props) {
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [meaningZh, setMeaningZh] = useState("");
  const [usage, setUsage] = useState("");
  const [lookup, setLookup] = useState<LookupState>({ kind: "idle" });
  const lookupAbortRef = useRef<AbortController | null>(null);
  const { has, toggle, add } = useVocabulary();
  const { settings } = useSettings();

  // Reset bubble state every time a new selection is made.
  useEffect(() => {
    if (!info) return;
    setExpanded(false);
    setMeaningZh("");
    setUsage("");
    setLookup({ kind: "idle" });
    lookupAbortRef.current?.abort();
  }, [info?.expression]);

  // Detect selection (unchanged from Task 7).
  useEffect(() => {
    if (disabled) return;
    const list = listRef.current;
    if (!list) return;
    const onMouseUp = () => {
      setTimeout(() => setInfo(readSelection(list, subtitles)), 0);
    };
    list.addEventListener("mouseup", onMouseUp);
    return () => list.removeEventListener("mouseup", onMouseUp);
  }, [listRef, subtitles, disabled]);

  // Hide on collapsed selection.
  useEffect(() => {
    if (!info) return;
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setInfo(null);
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, [info]);

  if (!info) return null;

  const saved = has(info.expression);

  const onLookup = async () => {
    lookupAbortRef.current?.abort();
    const ctrl = new AbortController();
    lookupAbortRef.current = ctrl;
    setExpanded(true);
    setLookup({ kind: "loading" });
    try {
      const provider = getProvider(settings);
      const result = await lookupExpression(
        info.expression,
        info.cueText,
        provider,
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      setMeaningZh(result.meaningZh);
      setUsage(result.usage);
      setLookup({ kind: "idle" });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setLookup({ kind: "error", message: String(e) });
    }
  };

  const onStar = async () => {
    if (saved) {
      // Toggle behavior — remove and stay open so user can re-edit + re-save.
      await toggle({
        expression: info.expression,
        meaningZh,
        usage,
        videoId,
        videoTitle,
        cueTime: info.cueTime,
        cueText: info.cueText,
      });
      return;
    }
    // Insert (upsert by id).
    await add({
      id: info.expression.toLowerCase().trim(),
      expression: info.expression,
      meaningZh,
      usage,
      videoId,
      videoTitle,
      cueTime: info.cueTime,
      cueText: info.cueText,
      addedAt: new Date().toISOString(),
    });
    setInfo(null);
    window.getSelection()?.removeAllRanges();
  };

  const top = Math.max(8, info.rect.top - (expanded ? 200 : 44));
  const left = clampLeft(info.rect.left + info.rect.width / 2 - 200);

  const llmReady = isProviderReady(settings);

  return (
    <div
      style={{ position: "fixed", top, left, width: 400 }}
      className="z-50 flex flex-col rounded-lg border border-zinc-700 bg-zinc-900/95 shadow-xl backdrop-blur"
    >
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
        <span
          className="flex-1 truncate text-sm text-zinc-100"
          title={info.expression}
        >
          {info.expression}
        </span>
        <button
          type="button"
          onClick={onLookup}
          disabled={!llmReady || lookup.kind === "loading"}
          title={llmReady ? "LLM 查词" : "请先在设置里配置 AI 翻译服务"}
          className="flex h-7 items-center gap-1 rounded px-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {lookup.kind === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          {expanded ? "重新查" : "查词"}
        </button>
        <button
          type="button"
          onClick={onStar}
          title={saved ? "已收藏 · 点击移除" : "收藏到我的词汇本"}
          className={
            "flex h-7 w-7 items-center justify-center rounded-full transition-colors " +
            (saved
              ? "text-amber-300 hover:bg-amber-900/30"
              : "text-zinc-400 hover:bg-zinc-800 hover:text-amber-300")
          }
        >
          <Star className="h-4 w-4" fill={saved ? "currentColor" : "none"} />
        </button>
      </div>

      {/* Inputs (expanded) */}
      {expanded && (
        <div className="flex flex-col gap-2 px-3 py-2">
          {lookup.kind === "error" && (
            <div className="flex items-center gap-2 rounded bg-red-900/30 px-2 py-1 text-xs text-red-300">
              <AlertCircle className="h-3.5 w-3.5" />
              <span className="flex-1 truncate">查询失败：{lookup.message}</span>
              <button
                type="button"
                onClick={onLookup}
                className="rounded px-2 py-0.5 hover:bg-red-900/40"
              >
                重试
              </button>
            </div>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">📖 中文释义</span>
            <textarea
              value={meaningZh}
              onChange={(e) => setMeaningZh(e.target.value)}
              rows={2}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-blue-400 resize-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">💬 用法</span>
            <textarea
              value={usage}
              onChange={(e) => setUsage(e.target.value)}
              rows={2}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-blue-400 resize-none"
            />
          </label>
        </div>
      )}
    </div>
  );
}

function isProviderReady(settings: ReturnType<typeof useSettings>["settings"]): boolean {
  switch (settings.llmProvider) {
    case "openai-compatible":
      return !!settings.openaiCompatible.apiKey && !!settings.openaiCompatible.baseUrl;
    case "claude":
      return !!settings.claude.apiKey;
    case "gemini":
      return !!settings.gemini.apiKey;
    default:
      return false;
  }
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd client && pnpm typecheck`
Expected: PASS. If `useVocabulary().add` signature complains, double-check the `add` parameter shape matches `VocabEntry` exactly (note `id` and `addedAt` are required).

- [ ] **Step 4: Manual smoke test**

Run: `cd client && pnpm tauri dev`

- Select a word → bubble shows 查词 enabled (assuming a configured LLM provider)
- Click 查词 → bubble expands, shows loading spinner → after a few seconds, inputs fill with Chinese gloss + usage
- Edit inputs → click ⭐ → vocab page shows the word with the edited values (visit Vocab page via header)
- Select a word → click ⭐ without 查词 → vocab entry has empty meaningZh
- LLM provider unset (clear API key in settings) → 查词 button disabled with tooltip; ⭐ still works

- [ ] **Step 5: Commit**

```bash
git add client/src/components/SubtitleSelectionBubble.tsx
git commit -m "feat(subtitle): bubble LLM lookup + editable meaning/usage inputs"
```

---

## Task 9: Bubble — AI 建议浮卡（替换/追加 + Grammarly hover preview）

用户在 inputs 里写过内容后，再次点 🔍 → 不直接覆盖，而是浮一张「AI 建议」卡片，hover 替换/追加按钮时输入框实时预览，松开恢复用户原值，点击才真正写入。

**Files:**
- Modify: `src/components/SubtitleSelectionBubble.tsx`

- [ ] **Step 1: Replace the lookup logic**

Find `const onLookup = async () => { ... }` and replace with the suggestion-aware version:

```tsx
const [suggestion, setSuggestion] = useState<{
  meaningZh: string;
  usage: string;
} | null>(null);
const [hoverPreview, setHoverPreview] = useState<
  null | "replace" | "append"
>(null);

const onLookup = async () => {
  lookupAbortRef.current?.abort();
  const ctrl = new AbortController();
  lookupAbortRef.current = ctrl;
  setExpanded(true);
  setLookup({ kind: "loading" });
  try {
    const provider = getProvider(settings);
    const result = await lookupExpression(
      info.expression,
      info.cueText,
      provider,
      ctrl.signal,
    );
    if (ctrl.signal.aborted) return;
    const userHasContent = meaningZh.trim() || usage.trim();
    if (userHasContent) {
      // Don't overwrite — show suggestion card instead.
      setSuggestion(result);
    } else {
      setMeaningZh(result.meaningZh);
      setUsage(result.usage);
    }
    setLookup({ kind: "idle" });
  } catch (e) {
    if (ctrl.signal.aborted) return;
    setLookup({ kind: "error", message: String(e) });
  }
};
```

(Place the two new `useState` lines just below the existing `useState` block at the top of the component, alongside `meaningZh / usage / lookup`.)

- [ ] **Step 2: Compute preview values**

Just below the `onStar` handler, add:

```tsx
const previewMeaning =
  hoverPreview === "replace"
    ? suggestion?.meaningZh ?? meaningZh
    : hoverPreview === "append" && suggestion?.meaningZh
    ? joinWithBreak(meaningZh, suggestion.meaningZh)
    : meaningZh;

const previewUsage =
  hoverPreview === "replace"
    ? suggestion?.usage ?? usage
    : hoverPreview === "append" && suggestion?.usage
    ? joinWithBreak(usage, suggestion.usage)
    : usage;

const showingPreview = hoverPreview !== null;
```

And below the component (next to `clampLeft`), add the helper:

```tsx
function joinWithBreak(a: string, b: string): string {
  if (!a.trim()) return b;
  if (!b.trim()) return a;
  return `${a}\n\n${b}`;
}
```

- [ ] **Step 3: Wire preview into the textareas + render the suggestion card**

In the JSX, replace the two `textarea` blocks with preview-aware ones:

```tsx
<label className="flex flex-col gap-1">
  <span className="text-xs text-zinc-500">📖 中文释义</span>
  <textarea
    value={previewMeaning}
    onChange={(e) => setMeaningZh(e.target.value)}
    rows={2}
    readOnly={showingPreview}
    className={
      "w-full rounded border px-2 py-1 text-sm focus:outline-none resize-none " +
      (showingPreview
        ? "border-amber-500/40 bg-amber-950/20 text-amber-100/80 italic"
        : "border-zinc-700 bg-zinc-950 text-zinc-100 focus:border-blue-400")
    }
  />
</label>
<label className="flex flex-col gap-1">
  <span className="text-xs text-zinc-500">💬 用法</span>
  <textarea
    value={previewUsage}
    onChange={(e) => setUsage(e.target.value)}
    rows={2}
    readOnly={showingPreview}
    className={
      "w-full rounded border px-2 py-1 text-sm focus:outline-none resize-none " +
      (showingPreview
        ? "border-amber-500/40 bg-amber-950/20 text-amber-100/80 italic"
        : "border-zinc-700 bg-zinc-950 text-zinc-100 focus:border-blue-400")
    }
  />
</label>
```

Just below the second `<label>` block (still inside `expanded && (...)`), add the suggestion card:

```tsx
{suggestion && (
  <div className="flex flex-col gap-2 rounded border border-amber-500/40 bg-amber-950/20 p-2">
    <div className="text-xs font-medium text-amber-300">AI 建议</div>
    <div className="text-xs text-amber-100/80">
      <div>📖 {suggestion.meaningZh || "（空）"}</div>
      <div>💬 {suggestion.usage || "（空）"}</div>
    </div>
    <div className="flex gap-2">
      <button
        type="button"
        onMouseEnter={() => setHoverPreview("replace")}
        onMouseLeave={() => setHoverPreview(null)}
        onClick={() => {
          setMeaningZh(suggestion.meaningZh);
          setUsage(suggestion.usage);
          setSuggestion(null);
          setHoverPreview(null);
        }}
        className="flex-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/20"
      >
        替换
      </button>
      <button
        type="button"
        onMouseEnter={() => setHoverPreview("append")}
        onMouseLeave={() => setHoverPreview(null)}
        onClick={() => {
          setMeaningZh(joinWithBreak(meaningZh, suggestion.meaningZh));
          setUsage(joinWithBreak(usage, suggestion.usage));
          setSuggestion(null);
          setHoverPreview(null);
        }}
        className="flex-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/20"
      >
        追加
      </button>
      <button
        type="button"
        onClick={() => {
          setSuggestion(null);
          setHoverPreview(null);
        }}
        className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
      >
        忽略
      </button>
    </div>
  </div>
)}
```

- [ ] **Step 4: Reset suggestion on new selection**

Find the `useEffect` that runs on `info?.expression` change (resets meaningZh/usage/lookup) and add:

```tsx
setSuggestion(null);
setHoverPreview(null);
```

So the full reset block becomes:

```tsx
useEffect(() => {
  if (!info) return;
  setExpanded(false);
  setMeaningZh("");
  setUsage("");
  setLookup({ kind: "idle" });
  setSuggestion(null);
  setHoverPreview(null);
  lookupAbortRef.current?.abort();
}, [info?.expression]);
```

- [ ] **Step 5: Manual smoke test**

Run: `cd client && pnpm tauri dev`

- Select word → 查词 → inputs filled with LLM result
- Modify "中文释义" to add your own note
- Click 重新查 again → suggestion card appears with [替换] [追加] [忽略]
- Hover [替换] → both textareas IMMEDIATELY show LLM's values in amber italic preview state
- Move mouse off → textareas snap back to your edited values
- Hover [追加] → textareas show your value + blank line + LLM value
- Click [追加] → values commit, suggestion card disappears
- Re-select a fresh word → no suggestion card, normal flow

- [ ] **Step 6: Commit**

```bash
git add client/src/components/SubtitleSelectionBubble.tsx
git commit -m "feat(subtitle): bubble AI suggestion overlay with hover preview"
```

---

## Task 10: Bubble — 草稿持久化（未收藏路径）+ 已收藏自动 upsert

两件事一起做，因为它们共用「保存当前 inputs 到 vocab/draft」逻辑：

1. 关闭气泡时，如果 expression 未在 vocab 且 inputs 有内容 → 写 localStorage 草稿
2. 重新选中同一 expression 时，如果未在 vocab 但有草稿 → 自动展开 + 预填草稿
3. 已收藏的 expression 重选 → 自动展开 + 预填 vocab 现存值；inputs 改动 debounce 500ms 自动 upsert

**Files:**
- Modify: `src/components/SubtitleSelectionBubble.tsx`

- [ ] **Step 1: Add the import + extend the vocab destructure**

Add to the imports at the top of `SubtitleSelectionBubble.tsx`:

```tsx
import { loadDraft, saveDraft, clearDraft, type VocabDraft } from "../store/vocabDraft";
```

Extend the existing vocab destructure (currently `const { has, toggle, add } = useVocabulary();`) to also pull `entries`:

```tsx
const { entries, has, toggle, add } = useVocabulary();
```

- [ ] **Step 2: On selection change, restore from vocab or draft**

Replace the existing reset useEffect (the `useEffect` keyed on `info?.expression`) with:

```tsx
useEffect(() => {
  if (!info) return;
  setLookup({ kind: "idle" });
  setSuggestion(null);
  setHoverPreview(null);
  lookupAbortRef.current?.abort();

  const id = info.expression.toLowerCase().trim();
  const existing = entries.find((e) => e.id === id);
  if (existing) {
    // Already-saved: auto-expand with vocab values; debounce-upsert active.
    setMeaningZh(existing.meaningZh);
    setUsage(existing.usage);
    setExpanded(true);
    return;
  }
  const draft = loadDraft(info.expression);
  if (draft) {
    setMeaningZh(draft.meaningZh);
    setUsage(draft.usage);
    setExpanded(true);
    return;
  }
  // Fresh, no draft, no vocab — collapsed default.
  setMeaningZh("");
  setUsage("");
  setExpanded(false);
}, [info?.expression]);
```

- [ ] **Step 3: Debounce-upsert for the already-saved path**

Add this useEffect after the selection-change one:

```tsx
const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

useEffect(() => {
  if (!info) return;
  if (!saved) return;            // only auto-update entries already in vocab
  if (suggestion) return;        // user is mid-suggestion-decision; don't fire yet

  if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
  debounceTimerRef.current = setTimeout(() => {
    void add({
      id: info.expression.toLowerCase().trim(),
      expression: info.expression,
      meaningZh,
      usage,
      videoId,
      videoTitle,
      cueTime: info.cueTime,
      cueText: info.cueText,
      addedAt:
        entries.find((e) => e.id === info.expression.toLowerCase().trim())
          ?.addedAt ?? new Date().toISOString(),
    });
  }, 500);

  return () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
  };
}, [meaningZh, usage, saved, info?.expression, suggestion]);
```

`addedAt` is preserved by reading the existing entry's value when we have it — so debounce upserts don't reset the saved-at timestamp.

- [ ] **Step 4: On close, save draft if applicable**

Wrap the existing `onStar` to clear the draft on save (insert path), and add a new `closeBubble(reason)` helper:

Replace the `onStar` body with:

```tsx
const onStar = async () => {
  if (debounceTimerRef.current) {
    clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;
  }
  if (saved) {
    // Cancel any pending upsert FIRST so it doesn't race with the remove.
    await toggle({
      expression: info.expression,
      meaningZh,
      usage,
      videoId,
      videoTitle,
      cueTime: info.cueTime,
      cueText: info.cueText,
    });
    // Stay open in expanded state (user might re-edit and re-save).
    return;
  }
  await add({
    id: info.expression.toLowerCase().trim(),
    expression: info.expression,
    meaningZh,
    usage,
    videoId,
    videoTitle,
    cueTime: info.cueTime,
    cueText: info.cueText,
    addedAt: new Date().toISOString(),
  });
  clearDraft(info.expression);
  setInfo(null);
  window.getSelection()?.removeAllRanges();
};
```

Add a closeBubble helper just above the JSX `return`:

```tsx
const closeBubble = () => {
  if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
  // Only write a draft when the entry isn't in vocab and the user typed something.
  if (info && !saved && (meaningZh.trim() || usage.trim())) {
    const draft: VocabDraft = {
      expression: info.expression,
      meaningZh,
      usage,
      cueText: info.cueText,
      cueTime: info.cueTime,
      videoId,
      videoTitle,
      updatedAt: new Date().toISOString(),
    };
    saveDraft(draft);
  }
  setInfo(null);
};
```

(`closeBubble` will be wired to outside-click and ESC in Task 11.)

- [ ] **Step 5: Manual smoke test**

Run: `cd client && pnpm tauri dev`

Test draft path:
1. Select "apparently" → 查词 → edit "显然" to "显然，明显地" → click outside the bubble (anywhere else in the page) → bubble closes
   - **NOTE: outside-click close is added in Task 11.** For this task, manually clear the selection (e.g. drag-select an empty area) to test the close path.
2. Re-select "apparently" → bubble auto-expands → inputs show "显然，明显地" (the draft).
3. Click ⭐ to save → bubble closes.
4. Re-select "apparently" → bubble auto-expands → inputs prefilled with "显然，明显地" (now from VOCAB, not draft) + ⭐ FILLED.

Test debounce upsert:
5. Continue from step 4 — bubble shows expanded, ⭐ filled. Edit "中文释义" to "明显地".
6. Wait 600ms.
7. Open another tab in the app (Vocab page) → entry's meaningZh should now be "明显地".

Test cancel-on-unstar race:
8. Select an existing saved word → bubble expanded → edit input quickly → IMMEDIATELY click ⭐ to unstar (within the 500ms debounce window).
9. Vocab page → entry should be GONE (no race-condition resurrection).

- [ ] **Step 6: Commit**

```bash
git add client/src/components/SubtitleSelectionBubble.tsx
git commit -m "feat(subtitle): vocab draft + auto-upsert on saved-entry edit"
```

---

## Task 11: Bubble — 滚轮拦截 + 外部点击关闭 + ESC + 入场动画

最后的 polish 一起做：

1. 气泡可见时禁用字幕区滚轮 / touchmove
2. document `mousedown` 落在气泡外 → closeBubble
3. ESC 键 → closeBubble
4. 入场 / 退场 Tailwind 过渡

**Files:**
- Modify: `src/components/SubtitleSelectionBubble.tsx`

- [ ] **Step 1: Wheel + touchmove block on the list container**

Inside the component body (after the existing `useEffect`s), add:

```tsx
useEffect(() => {
  if (!info) return;
  const list = listRef.current;
  if (!list) return;
  const block = (e: Event) => e.preventDefault();
  list.addEventListener("wheel", block, { passive: false });
  list.addEventListener("touchmove", block, { passive: false });
  return () => {
    list.removeEventListener("wheel", block);
    list.removeEventListener("touchmove", block);
  };
}, [info, listRef]);
```

- [ ] **Step 2: Outside-click close**

Add a ref for the bubble root and a document-level mousedown listener:

```tsx
const bubbleRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (!info) return;
  const onDown = (e: MouseEvent) => {
    if (!bubbleRef.current) return;
    if (bubbleRef.current.contains(e.target as Node)) return;
    // Click on selection itself — let it stand; selectionchange will close
    // if it collapses.
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      const x = e.clientX, y = e.clientY;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return;
    }
    closeBubble();
  };
  document.addEventListener("mousedown", onDown);
  return () => document.removeEventListener("mousedown", onDown);
}, [info, saved, meaningZh, usage]);
```

Attach `bubbleRef` to the outermost `<div>`:

```tsx
<div
  ref={bubbleRef}
  style={{ ... }}
  className={ ... }
>
```

- [ ] **Step 3: ESC key**

Add another effect:

```tsx
useEffect(() => {
  if (!info) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeBubble();
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}, [info, saved, meaningZh, usage]);
```

- [ ] **Step 4: Animation**

Add `mounted` boolean state that delays the "ready" class by one frame:

```tsx
const [mounted, setMounted] = useState(false);

useEffect(() => {
  if (!info) {
    setMounted(false);
    return;
  }
  // RAF so the first paint uses the initial (translated, transparent) class,
  // then transitions on the next frame to the final class.
  const id = requestAnimationFrame(() => setMounted(true));
  return () => cancelAnimationFrame(id);
}, [info?.expression]);
```

Update the bubble's outer `<div>` className:

```tsx
<div
  ref={bubbleRef}
  style={{ position: "fixed", top, left, width: 400 }}
  className={
    "z-50 flex flex-col rounded-lg border border-zinc-700 bg-zinc-900/95 shadow-xl backdrop-blur " +
    "transition-all duration-150 ease-out " +
    (mounted ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-1 scale-95")
  }
>
```

- [ ] **Step 5: Manual full-flow acceptance**

Run: `cd client && pnpm tauri dev`

Walk through the full spec acceptance list (spec section "测试 / 手动验收"):

1. Drag-select a single word → bubble fades in 150ms → directly click ⭐ → vocab entry appears, meaningZh empty, cueText filled
2. Drag-select a phrase → 🔍 查词 → spinner → result fills inputs → tweak a character → ⭐ → vocab has tweaked value
3. Already-saved word → bubble auto-expanded + ⭐ filled → tweak input → wait 500ms → vocab updated → click ⭐ → entry removed; bubble stays expanded with current inputs intact
4. Select word → write meaningZh → click empty area below cues → bubble fades out → re-select same word → bubble auto-expands with what you wrote
5. Continue from #4 → ⭐ to save → re-select → bubble shows vocab values (not draft); confirm `localStorage.getItem("whatsub:vocab-draft:<word>")` returns null in dev console
6. After ⭐ saving and re-editing inputs (already-saved path), then clicking 🔍 again → AI 建议 card → hover [替换] / [追加] → inputs preview live → click → values commit
7. Drag-select crossing two cues → bubble does NOT appear
8. Toggle 编辑模式开 → drag-select inside textarea → bubble does NOT appear
9. After saving a phrase, scroll up to find an earlier cue containing it → see faint dashed underline (Task 5)
10. Bubble visible → try to scroll the subtitle list with wheel → blocked. Close the bubble → wheel works again.
11. Clear API key in settings → bubble's 🔍 disabled with tooltip; ⭐ still works
12. ESC closes bubble; clicking outside closes bubble; clicking on the selection itself does NOT close

If anything fails, debug before proceeding.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/SubtitleSelectionBubble.tsx
git commit -m "feat(subtitle): bubble polish — wheel block, outside-click, ESC, fade-in animation"
```

---

## Task 12: Final cleanup + typecheck + full test run

- [ ] **Step 1: Run all tests + typecheck**

Run: `cd client && pnpm test && pnpm typecheck`
Expected: ALL PASS.

- [ ] **Step 2: Sanity-grep for placeholders**

```bash
cd client && rg -n "TODO|FIXME|XXX" src/components/SubtitleSelectionBubble.tsx src/llm/lookupExpression.ts src/store/vocabDraft.ts src/utils/normalizeExpression.ts
```

Expected: no matches.

- [ ] **Step 3: Verify spec self-review acceptance items 1–11 still pass**

(Same as Task 11 step 5, redo end-to-end on a fresh `pnpm tauri dev`.)

- [ ] **Step 4: Final commit (if any cleanup) — or skip if none**

```bash
# Only if there were changes
git add -A
git commit -m "chore(vocab-add): final cleanup"
```

---

## Self-review notes

**Spec coverage check:**

| Spec section | Implementing task |
|---|---|
| 用户流程图 — 未收藏路径 | Tasks 7–9 |
| 用户流程图 — 已收藏路径 | Task 10 |
| 拖蓝选区检测 + cue 归属 | Task 7 (`readSelection`) |
| 表达式标准化（首尾标点） | Task 4 (`normalizeExpression`) |
| 跨 cue 拒绝 | Task 7 |
| 编辑模式禁用 | Task 7 (`disabled` prop) |
| 气泡定位（fixed, 上方 8px） | Tasks 7, 8 (`top` calc) |
| 气泡淡入动画 | Task 11 |
| 折叠态 / 展开态 / loading / error | Tasks 7, 8 |
| 🔍 LLM 查词 | Task 8 |
| AI 建议浮卡 + hover 预览 | Task 9 |
| 草稿 localStorage（写/读/清） | Tasks 3, 10 |
| 已收藏 debounce upsert + cancel race | Task 10 |
| 滚轮 / touchmove 禁用 | Task 11 |
| 外部点击关闭 + ESC | Task 11 |
| 字幕「已收藏」虚线下划线 | Task 5 |
| LLM provider 未配置 → 🔍 disabled | Task 8 |
| 测试用例 1–11 | Tasks 11–12 manual check |

**Type consistency:**
- `LookupResult` defined in Task 2, used in Tasks 8/9
- `VocabDraft` defined in Task 3, used in Task 10
- `SelectionInfo` private to Task 7's bubble; not re-defined later
- `BubbleState` mentioned in spec replaced by separate `expanded: boolean` + `lookup: LookupState` + `suggestion: ... | null` — simpler, equivalent expressiveness

**Placeholder scan:** none.

**Decomposition:** 12 tasks, each shipping working+committed code. Tasks 1–4 are pure-function TDD. Task 5 is render-test TDD. Tasks 7–11 are integration tasks with manual smoke tests (component-level Vitest gets expensive for the selection / clipboard / debounce behavior we're testing; the value-to-effort ratio is poor compared to manual verification in `pnpm tauri dev`).
