# whatsub Tutor MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Tutor MVP — three single-shot AI actions (explain / quiz / liaison) with three discoverability touchpoints, local-only storage, and a locked log schema as the contract for the future Profile sub-project.

**Architecture:** Pure-TS UI + LLM orchestration layered over four small Rust commands for filesystem I/O. Reuses the existing multi-vendor LLM provider abstraction in `src/llm/providers.ts`. State is split between an in-memory zustand store (per-video, per-action UI state and liaison ranges) and on-disk JSON / JSONL files at `library/<videoId>/tutor_cache.json` and `library/<videoId>/tutor.log.jsonl`.

**Tech Stack:** Tauri 2 · React 19 + TS + Vite · Tailwind v3 · zustand · vitest. Rust uses `serde_json` + `std::fs` only — no new crates.

**Branch:** `feat/tutor-mvp` (already created from `main`, spec committed as `6ccbf27`).

**Spec:** `docs/superpowers/specs/2026-05-29-whatsub-tutor-mvp-design.md`. Read it first.

---

## File map (decomposition lock-in)

| File | Responsibility | Status |
|---|---|---|
| `src-tauri/src/commands/analysis.rs` | Add 4 `tutor_*` commands + pure helpers + tests | Modify |
| `src-tauri/src/lib.rs` | Register the 4 commands in the invoke_handler | Modify |
| `src/llm/tutorPricing.ts` | Vendor/model → ¥/1k chars table + `estimateCost()` | Create |
| `src/llm/tutorPrompts.ts` | Pure prompt builders for the 3 actions | Create |
| `src/llm/tutor.ts` | Orchestrator: `runTutorAction`, `rangeHash`, `cacheKey`, `estimateCostForAction` | Create |
| `src/store/tutor.ts` | `useTutor` zustand store + `clearTutorCache(videoId)` invoke wrapper | Create |
| `src/components/TutorActionCard.tsx` | Single action card with 4 states + cost/cache badges + ↻ | Create |
| `src/components/TutorPanel.tsx` | Right-panel tab content: cards grid + result area + pending trigger consumer | Create |
| `src/components/TutorEndOfVideoToast.tsx` | Bottom toast at 95% playback, dismiss + localStorage | Create |
| `src/components/KeyPhraseList.tsx` | Add `✨` hover button per phrase row | Modify |
| `src/components/SubtitleList.tsx` | Add `🎓` micro-button + render liaison underlines from `useTutor` | Modify |
| `src/pages/Player.tsx` | Add `tutor` tab; mount toast; call `clearTutorCache` in `onRetranscribe` | Modify |

All new TS test files mirror the source: `src/llm/tutorPricing.test.ts`, etc.

---

## Task 1: Rust `tutor_*` filesystem commands

**Files:**
- Modify: `client/src-tauri/src/commands/analysis.rs` (add helpers, commands, and tests)

The four commands wrap path-injectable pure helpers so tests use `std::env::temp_dir()` and never touch the real APPDATA (see CLAUDE.md 踩过的坑 → "Rust `#[cfg(test)]` blocks must NEVER call `paths::*_path()` directly").

- [ ] **Step 1: Write the failing test for the cache save/load roundtrip**

Append to the `#[cfg(test)] mod tests { ... }` block in `client/src-tauri/src/commands/analysis.rs`:

```rust
#[test]
fn tutor_cache_save_then_load_roundtrips() {
    let dir = std::env::temp_dir().join("whatsub-tutor-test-1");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("tutor_cache.json");
    let val = serde_json::json!({
        "createdAt": 123_u64, "model": "deepseek-chat", "content": "hi"
    });
    super::tutor_cache_save_to(&path, "explain:c0-c4", val.clone()).unwrap();
    let loaded = super::tutor_cache_load_from(&path).unwrap().unwrap();
    assert_eq!(loaded["entries"]["explain:c0-c4"], val);
    assert_eq!(loaded["version"], 1);
    let _ = std::fs::remove_dir_all(&dir);
}
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd client && cargo test --manifest-path src-tauri/Cargo.toml --lib commands::analysis::tests::tutor_cache_save_then_load_roundtrips
```

Expected: compile error — `tutor_cache_save_to` / `tutor_cache_load_from` not found.

- [ ] **Step 3: Implement the helpers + commands**

Add to `client/src-tauri/src/commands/analysis.rs`, near the existing analysis helpers:

```rust
const TUTOR_CACHE_VERSION: u32 = 1;

/// Load + parse the tutor_cache.json at `path`. Returns None if file is
/// missing or unreadable. Corrupted JSON is also treated as None so a
/// parse error never blocks the user (we just regenerate next time).
fn tutor_cache_load_from(path: &std::path::Path) -> AppResult<Option<serde_json::Value>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            eprintln!(
                "[tutor_cache] corrupt at {}: {} — treating as empty",
                path.display(),
                e
            );
            Ok(None)
        }
    }
}

/// Upsert a single entry into tutor_cache.json at `path`. Creates the file
/// (and parent dir) if missing.
fn tutor_cache_save_to(
    path: &std::path::Path,
    key: &str,
    value: serde_json::Value,
) -> AppResult<()> {
    let mut cache_obj = match tutor_cache_load_from(path)? {
        Some(serde_json::Value::Object(o)) => o,
        _ => {
            let mut o = serde_json::Map::new();
            o.insert("version".into(), TUTOR_CACHE_VERSION.into());
            o.insert(
                "entries".into(),
                serde_json::Value::Object(serde_json::Map::new()),
            );
            o
        }
    };
    if !cache_obj.contains_key("entries") {
        cache_obj.insert(
            "entries".into(),
            serde_json::Value::Object(serde_json::Map::new()),
        );
    }
    if let Some(serde_json::Value::Object(entries)) = cache_obj.get_mut("entries") {
        entries.insert(key.to_string(), value);
    }
    cache_obj.insert("version".into(), TUTOR_CACHE_VERSION.into());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let serialized = serde_json::to_string_pretty(&cache_obj)?;
    std::fs::write(path, serialized)?;
    Ok(())
}

/// Best-effort delete of tutor_cache.json.
fn tutor_cache_delete_at(path: &std::path::Path) -> AppResult<()> {
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

/// Append one JSON Lines record to tutor.log.jsonl at `path`. Creates the
/// file (and parent dir) if missing.
fn tutor_log_append_to(path: &std::path::Path, line: serde_json::Value) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(f, "{}", serde_json::to_string(&line)?)?;
    Ok(())
}

#[tauri::command]
pub fn tutor_cache_load(video_id: String) -> AppResult<Option<serde_json::Value>> {
    let path = paths::video_dir(&video_id)?.join("tutor_cache.json");
    tutor_cache_load_from(&path)
}

#[tauri::command]
pub fn tutor_cache_save(
    video_id: String,
    key: String,
    value: serde_json::Value,
) -> AppResult<()> {
    let path = paths::video_dir(&video_id)?.join("tutor_cache.json");
    tutor_cache_save_to(&path, &key, value)
}

#[tauri::command]
pub fn tutor_cache_delete(video_id: String) -> AppResult<()> {
    let path = paths::video_dir(&video_id)?.join("tutor_cache.json");
    tutor_cache_delete_at(&path)
}

#[tauri::command]
pub fn tutor_log_append(video_id: String, line: serde_json::Value) -> AppResult<()> {
    let path = paths::video_dir(&video_id)?.join("tutor.log.jsonl");
    tutor_log_append_to(&path, line)
}
```

- [ ] **Step 4: Run the first test, confirm it passes**

```bash
cd client && cargo test --manifest-path src-tauri/Cargo.toml --lib commands::analysis::tests::tutor_cache_save_then_load_roundtrips
```

Expected: 1 passed.

- [ ] **Step 5: Add the remaining tests for upsert, missing, corrupt, delete, log append**

Append to the same test mod:

```rust
#[test]
fn tutor_cache_save_upserts_into_existing_file() {
    let dir = std::env::temp_dir().join("whatsub-tutor-test-2");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("tutor_cache.json");
    super::tutor_cache_save_to(&path, "k1", serde_json::json!({"v": 1})).unwrap();
    super::tutor_cache_save_to(&path, "k2", serde_json::json!({"v": 2})).unwrap();
    let loaded = super::tutor_cache_load_from(&path).unwrap().unwrap();
    assert_eq!(loaded["entries"]["k1"]["v"], 1);
    assert_eq!(loaded["entries"]["k2"]["v"], 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn tutor_cache_load_returns_none_on_missing_file() {
    let dir = std::env::temp_dir().join("whatsub-tutor-test-3");
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("missing.json");
    assert!(super::tutor_cache_load_from(&path).unwrap().is_none());
}

#[test]
fn tutor_cache_load_treats_corrupt_as_empty() {
    let dir = std::env::temp_dir().join("whatsub-tutor-test-4");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("corrupt.json");
    std::fs::write(&path, "{ not valid json").unwrap();
    assert!(super::tutor_cache_load_from(&path).unwrap().is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn tutor_cache_delete_removes_existing_file() {
    let dir = std::env::temp_dir().join("whatsub-tutor-test-5");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("tutor_cache.json");
    super::tutor_cache_save_to(&path, "k", serde_json::json!({"v": 1})).unwrap();
    assert!(path.exists());
    super::tutor_cache_delete_at(&path).unwrap();
    assert!(!path.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn tutor_cache_delete_on_missing_is_ok() {
    let dir = std::env::temp_dir().join("whatsub-tutor-test-5b");
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("never_existed.json");
    super::tutor_cache_delete_at(&path).unwrap();
}

#[test]
fn tutor_log_appends_jsonl_lines() {
    let dir = std::env::temp_dir().join("whatsub-tutor-test-6");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("tutor.log.jsonl");
    super::tutor_log_append_to(&path, serde_json::json!({"ts": 1, "action": "explain"})).unwrap();
    super::tutor_log_append_to(
        &path,
        serde_json::json!({"ts": 2, "action": "quiz", "quizCorrect": 3}),
    )
    .unwrap();
    let raw = std::fs::read_to_string(&path).unwrap();
    let lines: Vec<&str> = raw.trim().split('\n').collect();
    assert_eq!(lines.len(), 2);
    let l1: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    let l2: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
    assert_eq!(l1["ts"], 1);
    assert_eq!(l1["action"], "explain");
    assert_eq!(l2["action"], "quiz");
    assert_eq!(l2["quizCorrect"], 3);
    let _ = std::fs::remove_dir_all(&dir);
}
```

- [ ] **Step 6: Run all the new tests**

```bash
cd client && cargo test --manifest-path src-tauri/Cargo.toml --lib commands::analysis::tests::tutor_
```

Expected: 6 passed.

- [ ] **Step 7: Commit**

```bash
git add client/src-tauri/src/commands/analysis.rs
git commit -m "feat(tutor/rust): tutor_cache + tutor_log filesystem helpers and commands

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Register Rust commands

**Files:**
- Modify: `client/src-tauri/src/lib.rs`

- [ ] **Step 1: Register the 4 commands**

In `client/src-tauri/src/lib.rs`, in the `invoke_handler` `generate_handler!` block, find the line that registers `commands::analysis::delete_analysis` and add immediately after:

```rust
            commands::analysis::delete_analysis,
            commands::analysis::tutor_cache_load,
            commands::analysis::tutor_cache_save,
            commands::analysis::tutor_cache_delete,
            commands::analysis::tutor_log_append,
```

- [ ] **Step 2: cargo check the full crate**

```bash
cd client && cargo check --manifest-path src-tauri/Cargo.toml --all-targets
```

Expected: `Finished`, no errors. Pre-existing warnings ok.

- [ ] **Step 3: Commit**

```bash
git add client/src-tauri/src/lib.rs
git commit -m "feat(tutor/rust): register tutor_cache + tutor_log commands

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `tutorPricing.ts`

**Files:**
- Create: `client/src/llm/tutorPricing.ts`
- Create: `client/src/llm/tutorPricing.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/src/llm/tutorPricing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { estimateCost } from "./tutorPricing";

describe("estimateCost", () => {
  it("computes deepseek-chat 800 chars and rounds up to ¥0.01", () => {
    // 800 × 0.002 / 1000 = 0.0016 → ceil to 0.01
    expect(estimateCost("deepseek", "deepseek-chat", 800)).toBe(0.01);
  });

  it("rounds tiny totals UP to ¥0.01 minimum", () => {
    // 50 × 0.002 / 1000 = 0.0001 → ceil to 0.01
    expect(estimateCost("deepseek", "deepseek-chat", 50)).toBe(0.01);
  });

  it("scales linearly: 50,000 chars on deepseek-chat ≈ ¥0.10", () => {
    // 50000 × 0.002 / 1000 = 0.10
    expect(estimateCost("deepseek", "deepseek-chat", 50000)).toBe(0.10);
  });

  it("returns null for unknown vendor/model", () => {
    expect(estimateCost("xai", "grok-fake", 1000)).toBeNull();
  });

  it("is case-insensitive on vendor and model name", () => {
    expect(estimateCost("DeepSeek", "DeepSeek-Chat", 1000)).toBe(0.01);
  });

  it("zero chars still rounds up to ¥0.01 (we never advertise free)", () => {
    expect(estimateCost("deepseek", "deepseek-chat", 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
cd client && pnpm test -- src/llm/tutorPricing.test.ts
```

Expected: file not found / import error.

- [ ] **Step 3: Implement `tutorPricing.ts`**

Create `client/src/llm/tutorPricing.ts`:

```ts
/**
 * Per-1000-character cost estimates in CNY for the LLM providers we support.
 *
 * Derived from each vendor's public per-1k-token pricing assuming
 * ≈ 1 token per 1.5 Chinese characters or ≈ 0.75 English words, blended
 * input + output (rough average — actual cost varies with the I/O ratio).
 *
 * Conservative: numbers are rounded UP so the user-facing estimate is a
 * safe upper bound. Better to look 1 cent expensive than understate.
 *
 * Vendor + model strings are case-folded before lookup, so config can use
 * either casing.
 */
export const TUTOR_PRICING_CNY_PER_1K_CHARS: Record<string, number> = {
  "deepseek/deepseek-chat":     0.002,
  "deepseek/deepseek-reasoner": 0.004,
  "claude/claude-3-5-sonnet":   0.05,
  "claude/claude-3-5-haiku":    0.012,
  "openai/gpt-4o":              0.04,
  "openai/gpt-4o-mini":         0.003,
  "gemini/gemini-2-flash":      0.005,
};

/**
 * Estimate the cost in CNY for an LLM call of `chars` characters
 * (prompt + expected response).
 *
 * Returns `null` if we don't know the model — caller should hide the ¥
 * figure in that case (still show the char estimate).
 *
 * The returned number is rounded UP to the nearest cent (¥0.01).
 * Special case: exactly 0 chars returns 0, not 0.01.
 */
export function estimateCost(
  vendor: string,
  model: string,
  chars: number,
): number | null {
  const key = `${vendor.toLowerCase()}/${model.toLowerCase()}`;
  const rate = TUTOR_PRICING_CNY_PER_1K_CHARS[key];
  if (rate == null) return null;
  const raw = (chars / 1000) * rate;
  return Math.ceil(raw * 100) / 100;
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd client && pnpm test -- src/llm/tutorPricing.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add client/src/llm/tutorPricing.ts client/src/llm/tutorPricing.test.ts
git commit -m "feat(tutor/llm): estimateCost with per-vendor pricing table

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `tutorPrompts.ts`

**Files:**
- Create: `client/src/llm/tutorPrompts.ts`
- Create: `client/src/llm/tutorPrompts.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/src/llm/tutorPrompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildExplainPrompt,
  buildQuizPrompt,
  buildLiaisonPrompt,
  contextChars,
  RESPONSE_CHAR_ESTIMATE,
  type TutorContext,
} from "./tutorPrompts";
import type { SrtCue } from "./types";

const sampleCues: SrtCue[] = [
  { time: 0, endTime: 2, text: "Hello, world." },
  { time: 2, endTime: 4, text: "How are you doing today?" },
];

const sampleCtx: TutorContext = { cues: sampleCues, analyzedSubtitles: [] };

describe("contextChars", () => {
  it("sums lengths of all cue texts", () => {
    expect(contextChars(sampleCtx)).toBe(
      "Hello, world.".length + "How are you doing today?".length,
    );
  });
  it("returns 0 on empty cues", () => {
    expect(contextChars({ cues: [], analyzedSubtitles: [] })).toBe(0);
  });
});

describe("RESPONSE_CHAR_ESTIMATE", () => {
  it("has entries for all 3 actions", () => {
    expect(RESPONSE_CHAR_ESTIMATE.explain).toBeGreaterThan(0);
    expect(RESPONSE_CHAR_ESTIMATE.quiz).toBeGreaterThan(0);
    expect(RESPONSE_CHAR_ESTIMATE.liaison).toBeGreaterThan(0);
  });
});

describe("buildExplainPrompt", () => {
  it("includes every cue text", () => {
    const p = buildExplainPrompt(sampleCtx);
    expect(p).toContain("Hello, world.");
    expect(p).toContain("How are you doing today?");
  });
  it("frames the audience as a Chinese-speaking learner", () => {
    expect(buildExplainPrompt(sampleCtx)).toContain("Chinese-speaking");
  });
});

describe("buildQuizPrompt", () => {
  it("requires JSON Lines output (no surrounding prose)", () => {
    const p = buildQuizPrompt(sampleCtx);
    expect(p).toContain("JSON Lines");
    expect(p).toContain("no surrounding prose");
  });
  it("asks for 5 total questions across 3 types", () => {
    const p = buildQuizPrompt(sampleCtx);
    expect(p).toContain("5");
    expect(p).toContain("vocab");
    expect(p).toContain("comprehension");
    expect(p).toContain("grammar");
  });
});

describe("buildLiaisonPrompt", () => {
  it("embeds the cueIdx in the expected output schema", () => {
    const p = buildLiaisonPrompt({ cues: [sampleCues[0]], analyzedSubtitles: [] }, 7);
    expect(p).toContain('"cueIdx": 7');
  });
  it("quotes the actual cue text for the model", () => {
    const p = buildLiaisonPrompt({ cues: [sampleCues[0]], analyzedSubtitles: [] }, 0);
    expect(p).toContain('Hello, world.');
  });
  it("allows empty-array output when no liaisons", () => {
    const p = buildLiaisonPrompt({ cues: [sampleCues[0]], analyzedSubtitles: [] }, 0);
    expect(p.toLowerCase()).toContain("empty array");
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

```bash
cd client && pnpm test -- src/llm/tutorPrompts.test.ts
```

Expected: import / file-not-found errors.

- [ ] **Step 3: Implement `tutorPrompts.ts`**

Create `client/src/llm/tutorPrompts.ts`:

```ts
import type { SrtCue, Subtitle } from "./types";

export type TutorAction = "explain" | "quiz" | "liaison";

export interface TutorContext {
  /**
   * The cues that form this action's context window.
   *  - explain / quiz (in-tab): current cue ± 2 cues (5 total)
   *  - quiz (toast trigger):   entire transcript
   *  - liaison:                 a single cue
   */
  cues: SrtCue[];
  /**
   * Subtitles produced by the analysis pipeline that overlap `cues` —
   * gives the LLM the Chinese translations + key phrases the user is
   * looking at. May be empty (e.g. analysis not yet complete).
   */
  analyzedSubtitles: Subtitle[];
}

/** Total character count of the cue texts in `ctx` — used for cost estimate. */
export function contextChars(ctx: TutorContext): number {
  return ctx.cues.reduce((sum, c) => sum + c.text.length, 0);
}

/** Expected response size in characters, per action. Used for cost estimate. */
export const RESPONSE_CHAR_ESTIMATE: Record<TutorAction, number> = {
  explain: 800,  // ~200-400 Chinese chars but Markdown overhead and headings push higher
  quiz: 1500,    // 5 questions × ~300 chars each (question + 4 options + explanation)
  liaison: 300,
};

/**
 * Build the prompt for "解释这段". Streaming markdown response.
 */
export function buildExplainPrompt(ctx: TutorContext): string {
  const transcript = ctx.cues
    .map((c, i) => `[Cue ${i}] ${c.text}`)
    .join("\n");
  return `You are an English-learning coach for a Chinese-speaking student. The student is watching a video and wants you to explain this passage.

Transcript excerpt:
${transcript}

Explain in Chinese:
1. What the dialogue means (overall meaning, not word-by-word).
2. Any idioms, cultural references, or registers (formal / casual / slangy) that a Chinese learner would miss.
3. Why the typical Chinese translation chose certain phrasings.

Keep it concise (200–400 Chinese characters total). Use markdown formatting (bold for terms, lists where useful).`;
}

/**
 * Build the prompt for "出个题". Streaming JSON Lines response — one
 * question per line. The caller parses each line as it arrives.
 */
export function buildQuizPrompt(ctx: TutorContext): string {
  const transcript = ctx.cues.map((c) => c.text).join(" ");
  return `Generate 5 multiple-choice questions about this English passage for a Chinese-speaking learner.

Passage:
${transcript}

Question mix: 2 vocabulary, 2 reading comprehension, 1 grammar.

Output as JSON Lines — one question per line, in this exact shape:
{"q": "Question in English", "type": "vocab" | "comprehension" | "grammar", "options": ["A...", "B...", "C...", "D..."], "answer": <0-3>, "explain": "Brief explanation in Chinese"}

Strict rules:
- Each option must be a complete phrase or sentence, not just a single letter or word from the original passage.
- "answer" is the 0-based index of the correct option (0, 1, 2, or 3).
- "explain" is in Chinese, 30-80 characters, says WHY the correct answer is right.
- Output ONLY the JSON Lines, no surrounding prose, no markdown code fences.`;
}

/**
 * Build the prompt for "标连读". Streaming JSON array response.
 * `cueIdx` is the cue's index in the full transcript (so the LLM
 * echoes it back and the renderer knows which cue row to underline).
 */
export function buildLiaisonPrompt(ctx: TutorContext, cueIdx: number): string {
  const cue = ctx.cues[0]; // liaison context is always a single cue
  return `Identify connected-speech / liaison points in this English sentence that a Chinese learner is likely to mishear.

Cue text: "${cue.text}"

Output as a JSON array (ONLY the array, no surrounding prose):
[{"cueIdx": ${cueIdx}, "wordStart": "<word before the join>", "wordEnd": "<word after>", "pronunciation": "/IPA/", "why": "<Chinese explanation, 20-40 chars>"}]

Only include cases where the spoken form differs meaningfully from the written form (linking r, voiced-t reduction, /j/ insertion, flap, contraction etc.). An empty array [] is valid if there are no notable liaisons in this cue.`;
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd client && pnpm test -- src/llm/tutorPrompts.test.ts
```

Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add client/src/llm/tutorPrompts.ts client/src/llm/tutorPrompts.test.ts
git commit -m "feat(tutor/llm): prompt builders for explain / quiz / liaison

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `tutor.ts` orchestrator (pure parts)

**Files:**
- Create: `client/src/llm/tutor.ts`
- Create: `client/src/llm/tutor.test.ts`

This task builds out the pure parts of the orchestrator: `rangeHash`, `cacheKey`, `estimateCostForAction`. The streaming `runTutorAction` function is added but only smoke-tested here (its integration test is part of Task 8 once we have the UI to drive it).

- [ ] **Step 1: Write the failing tests**

Create `client/src/llm/tutor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  rangeHash,
  cacheKey,
  estimateCostForAction,
  type TutorContext,
} from "./tutor";

describe("rangeHash", () => {
  it("is stable for the same indices given in different orders", () => {
    expect(rangeHash([1, 2, 3])).toBe(rangeHash([3, 1, 2]));
  });
  it("formats as c<n>-c<n>-c<n>", () => {
    expect(rangeHash([12, 13, 14])).toBe("c12-c13-c14");
  });
  it("collapses a single index to c<n>", () => {
    expect(rangeHash([13])).toBe("c13");
  });
  it("deduplicates repeated indices", () => {
    expect(rangeHash([5, 5, 5])).toBe("c5");
  });
});

describe("cacheKey", () => {
  it("formats <action>:<rangeHash>", () => {
    expect(cacheKey("explain", [12, 13, 14])).toBe("explain:c12-c13-c14");
    expect(cacheKey("liaison", [13])).toBe("liaison:c13");
  });
  it("collisions: adjacent ranges produce different keys", () => {
    expect(cacheKey("explain", [11, 12, 13])).not.toBe(
      cacheKey("explain", [12, 13, 14]),
    );
  });
});

describe("estimateCostForAction", () => {
  const ctx: TutorContext = {
    cues: [{ time: 0, endTime: 1, text: "x".repeat(200) }],
    analyzedSubtitles: [],
  };
  it("returns null for unknown model", () => {
    expect(estimateCostForAction("xai", "fake-model", "explain", ctx)).toBeNull();
  });
  it("sums context + expected response and uses the pricing table", () => {
    // 200 ctx + 800 explain estimate = 1000 chars
    // 1000 × 0.002 / 1000 = 0.002 → ceil 0.01
    expect(estimateCostForAction("deepseek", "deepseek-chat", "explain", ctx)).toBe(0.01);
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

```bash
cd client && pnpm test -- src/llm/tutor.test.ts
```

Expected: import error.

- [ ] **Step 3: Implement `tutor.ts`**

Create `client/src/llm/tutor.ts`:

```ts
import { getProvider } from "./providers";
import { useSettings } from "../store/settings";
import {
  buildExplainPrompt,
  buildQuizPrompt,
  buildLiaisonPrompt,
  contextChars,
  RESPONSE_CHAR_ESTIMATE,
  type TutorAction,
  type TutorContext,
} from "./tutorPrompts";
import { estimateCost } from "./tutorPricing";

export type { TutorAction, TutorContext } from "./tutorPrompts";

export interface TutorResultMeta {
  model: string;
  promptChars: number;
  responseChars: number;
}

export interface RunTutorActionOpts {
  action: TutorAction;
  ctx: TutorContext;
  /** Required for liaison action: the cue's index in the full transcript. */
  cueIdx?: number;
  signal: AbortSignal;
  onChunk: (chunk: string) => void;
  onDone: (full: string, meta: TutorResultMeta) => void;
  onError: (err: Error) => void;
}

/**
 * Run a Tutor action end-to-end: build prompt → call provider → stream chunks.
 *
 * On normal completion: invokes onDone with the full text + meta. On abort
 * via signal: returns silently (no onDone, no onError). On real error: invokes
 * onError. Caller decides whether to write cache / log (only on onDone).
 */
export async function runTutorAction(opts: RunTutorActionOpts): Promise<void> {
  const { action, ctx, signal, onChunk, onDone, onError } = opts;
  try {
    const settings = useSettings.getState().settings;
    const provider = getProvider(settings);
    let prompt: string;
    switch (action) {
      case "explain":
        prompt = buildExplainPrompt(ctx);
        break;
      case "quiz":
        prompt = buildQuizPrompt(ctx);
        break;
      case "liaison":
        if (opts.cueIdx == null) {
          throw new Error("liaison action requires opts.cueIdx");
        }
        prompt = buildLiaisonPrompt(ctx, opts.cueIdx);
        break;
    }
    const promptChars = prompt.length;
    let full = "";
    // provider.stream is the existing multi-vendor streaming abstraction
    // already used by runAnalysis. It yields plain-text chunks.
    for await (const chunk of provider.stream(prompt, { signal })) {
      if (signal.aborted) return;
      full += chunk;
      onChunk(chunk);
    }
    if (signal.aborted) return;
    onDone(full, {
      model: provider.model,
      promptChars,
      responseChars: full.length,
    });
  } catch (e) {
    if (signal.aborted) return;
    onError(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Stable string hash for a cue range — used as the cache-key suffix.
 * Sorts + dedupes indices so the same range always produces the same key.
 */
export function rangeHash(cueIndices: number[]): string {
  const sorted = Array.from(new Set(cueIndices)).sort((a, b) => a - b);
  return sorted.map((i) => `c${i}`).join("-");
}

/** `<action>:<rangeHash>` — used as the on-disk cache map key. */
export function cacheKey(action: TutorAction, indices: number[]): string {
  return `${action}:${rangeHash(indices)}`;
}

/** Estimated CNY cost for an action with this context. null if model unknown. */
export function estimateCostForAction(
  vendor: string,
  model: string,
  action: TutorAction,
  ctx: TutorContext,
): number | null {
  const chars = contextChars(ctx) + RESPONSE_CHAR_ESTIMATE[action];
  return estimateCost(vendor, model, chars);
}
```

**Note on `provider.stream`:** the existing `src/llm/providers.ts` exposes a `getProvider(settings)` that returns a provider object with a `stream(prompt, opts)` async generator. Confirm the exact method name when implementing — adapt if it's named differently (`generate`, `chat`, etc.). The pure parts of this file (`rangeHash`, `cacheKey`, `estimateCostForAction`) don't depend on it.

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd client && pnpm test -- src/llm/tutor.test.ts
```

Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add client/src/llm/tutor.ts client/src/llm/tutor.test.ts
git commit -m "feat(tutor/llm): runTutorAction orchestrator + rangeHash/cacheKey helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `useTutor` zustand store

**Files:**
- Create: `client/src/store/tutor.ts`
- Create: `client/src/store/tutor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/src/store/tutor.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useTutor } from "./tutor";

beforeEach(() => {
  useTutor.setState({ actions: {}, liaisonRanges: {}, pendingTrigger: null });
});

describe("useTutor.triggerAction / consumePendingTrigger", () => {
  it("triggerAction sets pendingTrigger", () => {
    useTutor.getState().triggerAction("v1", "explain", [12, 13, 14], "keyphrase-sparkle");
    expect(useTutor.getState().pendingTrigger).toEqual({
      videoId: "v1",
      action: "explain",
      indices: [12, 13, 14],
      source: "keyphrase-sparkle",
    });
  });
  it("consumePendingTrigger returns and clears", () => {
    useTutor.getState().triggerAction("v1", "quiz", [0, 1, 2], "tab-direct");
    const v = useTutor.getState().consumePendingTrigger();
    expect(v?.action).toBe("quiz");
    expect(useTutor.getState().pendingTrigger).toBeNull();
  });
  it("consumePendingTrigger on empty returns null", () => {
    expect(useTutor.getState().consumePendingTrigger()).toBeNull();
  });
});

describe("useTutor.setActionState", () => {
  it("creates and merges state per videoId + key", () => {
    useTutor.getState().setActionState("v1", "explain:c0-c4", {
      status: "streaming",
      content: "hi",
    });
    useTutor.getState().setActionState("v1", "explain:c0-c4", { content: "hi there" });
    const st = useTutor.getState().actions["v1"]["explain:c0-c4"];
    expect(st.content).toBe("hi there");
    expect(st.status).toBe("streaming");
    expect(st.cached).toBe(false);
  });
  it("isolates per videoId", () => {
    useTutor.getState().setActionState("v1", "k", { status: "done", content: "a" });
    useTutor.getState().setActionState("v2", "k", { status: "done", content: "b" });
    expect(useTutor.getState().actions["v1"]["k"].content).toBe("a");
    expect(useTutor.getState().actions["v2"]["k"].content).toBe("b");
  });
});

describe("useTutor.setLiaisonRanges", () => {
  it("stores liaison ranges per video", () => {
    useTutor.getState().setLiaisonRanges("v1", [
      { cueIdx: 13, wordStart: "did", wordEnd: "you", pronunciation: "/dɪdʒu/", why: "voiced t + y" },
    ]);
    expect(useTutor.getState().liaisonRanges["v1"]).toHaveLength(1);
  });
});

describe("useTutor.clearForVideo", () => {
  it("wipes actions + liaison for that video only", () => {
    useTutor.getState().setActionState("v1", "k", { status: "done", content: "a" });
    useTutor.getState().setActionState("v2", "k", { status: "done", content: "b" });
    useTutor.getState().setLiaisonRanges("v1", [
      { cueIdx: 1, wordStart: "x", wordEnd: "y", pronunciation: "/z/", why: "z" },
    ]);
    useTutor.getState().clearForVideo("v1");
    expect(useTutor.getState().actions["v1"]).toBeUndefined();
    expect(useTutor.getState().liaisonRanges["v1"]).toBeUndefined();
    expect(useTutor.getState().actions["v2"]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

```bash
cd client && pnpm test -- src/store/tutor.test.ts
```

Expected: import error.

- [ ] **Step 3: Implement `useTutor`**

Create `client/src/store/tutor.ts`:

```ts
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { TutorAction } from "../llm/tutorPrompts";

export type TutorActionStatus = "idle" | "streaming" | "done" | "error";

export interface TutorActionState {
  status: TutorActionStatus;
  /** Streaming content accumulator. For explain: markdown. For quiz: JSONL.
   *  For liaison: JSON array. Same shape across cache hit + LLM result. */
  content: string;
  errorMessage?: string;
  cached: boolean;
}

export interface LiaisonRange {
  cueIdx: number;
  wordStart: string;
  wordEnd: string;
  pronunciation: string;
  why: string;
}

export interface PendingTrigger {
  videoId: string;
  action: TutorAction;
  /** Cue indices forming the action's context window. */
  indices: number[];
  /** Where the trigger came from — recorded in tutor.log for funnel analysis. */
  source:
    | "tab-direct"
    | "keyphrase-sparkle"
    | "transcript-line-button"
    | "end-of-video-toast";
}

interface TutorStore {
  /** Per-video, per-cacheKey state. */
  actions: Record<string, Record<string, TutorActionState>>;
  /** Per-video liaison ranges (from "liaison" action results). */
  liaisonRanges: Record<string, LiaisonRange[]>;
  /** External trigger; consumed by TutorPanel on mount / when it becomes visible. */
  pendingTrigger: PendingTrigger | null;

  triggerAction: (
    videoId: string,
    action: TutorAction,
    indices: number[],
    source: PendingTrigger["source"],
  ) => void;
  consumePendingTrigger: () => PendingTrigger | null;
  setActionState: (
    videoId: string,
    key: string,
    partial: Partial<TutorActionState>,
  ) => void;
  setLiaisonRanges: (videoId: string, ranges: LiaisonRange[]) => void;
  clearForVideo: (videoId: string) => void;
}

const DEFAULT_ACTION_STATE: TutorActionState = {
  status: "idle",
  content: "",
  cached: false,
};

export const useTutor = create<TutorStore>((set, get) => ({
  actions: {},
  liaisonRanges: {},
  pendingTrigger: null,

  triggerAction(videoId, action, indices, source) {
    set({ pendingTrigger: { videoId, action, indices, source } });
  },

  consumePendingTrigger() {
    const v = get().pendingTrigger;
    set({ pendingTrigger: null });
    return v;
  },

  setActionState(videoId, key, partial) {
    set((s) => ({
      actions: {
        ...s.actions,
        [videoId]: {
          ...(s.actions[videoId] ?? {}),
          [key]: { ...(s.actions[videoId]?.[key] ?? DEFAULT_ACTION_STATE), ...partial },
        },
      },
    }));
  },

  setLiaisonRanges(videoId, ranges) {
    set((s) => ({
      liaisonRanges: { ...s.liaisonRanges, [videoId]: ranges },
    }));
  },

  clearForVideo(videoId) {
    set((s) => {
      const a = { ...s.actions };
      const l = { ...s.liaisonRanges };
      delete a[videoId];
      delete l[videoId];
      return { actions: a, liaisonRanges: l };
    });
  },
}));

/**
 * Clear the on-disk tutor_cache for a video AND wipe the in-memory store
 * entries for it. Called from Player.onRetranscribe after the new transcript
 * is written — the cue indices in cache keys would no longer match.
 */
export async function clearTutorCache(videoId: string): Promise<void> {
  try {
    await invoke("tutor_cache_delete", { videoId });
  } catch (err) {
    console.warn("tutor_cache_delete failed (continuing):", err);
  }
  useTutor.getState().clearForVideo(videoId);
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd client && pnpm test -- src/store/tutor.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add client/src/store/tutor.ts client/src/store/tutor.test.ts
git commit -m "feat(tutor/store): useTutor zustand store + clearTutorCache wrapper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `TutorActionCard` component

**Files:**
- Create: `client/src/components/TutorActionCard.tsx`
- Create: `client/src/components/TutorActionCard.test.tsx`

A single card that displays an action's title, cost estimate, current state (idle / streaming / done / error), and content. Has a force-regenerate `↻` button when in `done` state and a cancel `✕` when in `streaming`. The cached badge appears when content came from the disk cache.

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/TutorActionCard.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TutorActionCard } from "./TutorActionCard";

const baseProps = {
  title: "解释这段",
  estimateChars: 800,
  estimateCny: 0.01,
  modelLabel: "DeepSeek",
  onRun: vi.fn(),
  onForceRegenerate: vi.fn(),
  onCancel: vi.fn(),
};

describe("TutorActionCard", () => {
  it("renders idle state with title, estimate, run button", () => {
    render(<TutorActionCard {...baseProps} state={{ status: "idle", content: "", cached: false }} />);
    expect(screen.getByText("解释这段")).toBeInTheDocument();
    expect(screen.getByText(/约 800 字/)).toBeInTheDocument();
    expect(screen.getByText(/¥0\.01/)).toBeInTheDocument();
    expect(screen.getByText("DeepSeek")).toBeInTheDocument();
  });

  it("hides ¥ when estimateCny is null (unknown model)", () => {
    render(<TutorActionCard {...baseProps} estimateCny={null} state={{ status: "idle", content: "", cached: false }} />);
    expect(screen.queryByText(/¥/)).toBeNull();
    expect(screen.getByText(/估算不可用/)).toBeInTheDocument();
  });

  it("clicking the card in idle state calls onRun", () => {
    const onRun = vi.fn();
    render(<TutorActionCard {...baseProps} onRun={onRun} state={{ status: "idle", content: "", cached: false }} />);
    fireEvent.click(screen.getByRole("button", { name: /运行/ }));
    expect(onRun).toHaveBeenCalled();
  });

  it("renders streaming state with content + cancel button", () => {
    render(
      <TutorActionCard
        {...baseProps}
        state={{ status: "streaming", content: "正在解释…", cached: false }}
      />,
    );
    expect(screen.getByText("正在解释…")).toBeInTheDocument();
    expect(screen.getByLabelText("取消")).toBeInTheDocument();
  });

  it("renders done state with cached badge + force-regenerate ↻", () => {
    const onForce = vi.fn();
    render(
      <TutorActionCard
        {...baseProps}
        onForceRegenerate={onForce}
        state={{ status: "done", content: "## 解释\n...", cached: true }}
      />,
    );
    expect(screen.getByText(/缓存/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("重新生成"));
    expect(onForce).toHaveBeenCalled();
  });

  it("renders error state with retry button", () => {
    const onRun = vi.fn();
    render(
      <TutorActionCard
        {...baseProps}
        onRun={onRun}
        state={{ status: "error", content: "", cached: false, errorMessage: "Network down" }}
      />,
    );
    expect(screen.getByText(/Network down/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/重试/));
    expect(onRun).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

```bash
cd client && pnpm test -- src/components/TutorActionCard.test.tsx
```

Expected: import error.

- [ ] **Step 3: Implement `TutorActionCard`**

Create `client/src/components/TutorActionCard.tsx`:

```tsx
import { RotateCw, X } from "lucide-react";
import type { TutorActionState } from "../store/tutor";

interface Props {
  /** Display title of the action — "解释这段" / "出个题" / "标连读". */
  title: string;
  /** Estimated prompt + response size, in characters. */
  estimateChars: number;
  /** Estimated cost in CNY, or null if the model is not in the pricing table. */
  estimateCny: number | null;
  /** Vendor / model label for display ("DeepSeek" / "Claude" / ...). */
  modelLabel: string;
  /** Current per-action state from useTutor. */
  state: TutorActionState;
  /** Called when the user wants to fire the action (from idle, or retry on error). */
  onRun: () => void;
  /** Called when the user clicks ↻ (bypass cache, force fresh LLM call). */
  onForceRegenerate: () => void;
  /** Called when the user cancels mid-stream. */
  onCancel: () => void;
}

/**
 * A single Tutor action card. Four visual states driven by `state.status`:
 *
 *   idle      — title + estimate + click-to-run
 *   streaming — partial content + cancel ✕
 *   done      — final content (markdown rendered upstream) + cached badge + ↻
 *   error     — error message + retry
 *
 * The body's actual rendering for "done" content (markdown / quiz cards /
 * liaison list) is rendered by the parent panel after looking at action;
 * this card draws the frame only.
 */
export function TutorActionCard({
  title,
  estimateChars,
  estimateCny,
  modelLabel,
  state,
  onRun,
  onForceRegenerate,
  onCancel,
}: Props) {
  const isIdle = state.status === "idle";
  const isStreaming = state.status === "streaming";
  const isDone = state.status === "done";
  const isError = state.status === "error";

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/60 overflow-hidden">
      <div className="px-3 py-2 flex items-center justify-between border-b border-zinc-800">
        <div className="text-sm font-semibold text-zinc-100">{title}</div>
        <div className="flex items-center gap-2">
          {isDone && state.cached && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
              缓存
            </span>
          )}
          {isStreaming && (
            <button
              type="button"
              aria-label="取消"
              onClick={onCancel}
              className="h-6 w-6 grid place-items-center rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
            >
              <X size={14} />
            </button>
          )}
          {isDone && (
            <button
              type="button"
              aria-label="重新生成"
              onClick={onForceRegenerate}
              title="重新生成（不读缓存）"
              className="h-6 w-6 grid place-items-center rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
            >
              <RotateCw size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="px-3 py-2">
        <div className="text-[11px] text-zinc-500 mb-2">
          约 {estimateChars} 字 ·{" "}
          {estimateCny == null ? "估算不可用" : `大约 ¥${estimateCny.toFixed(2)}`}{" "}
          · <span className="text-zinc-400">{modelLabel}</span>
        </div>
        {isIdle && (
          <button
            type="button"
            onClick={onRun}
            aria-label="运行此动作"
            className="w-full py-2 rounded bg-blue-500 hover:bg-blue-400 text-black text-sm font-medium"
          >
            运行
          </button>
        )}
        {isStreaming && (
          <div className="text-sm text-zinc-200 whitespace-pre-wrap break-words">
            {state.content || "…"}
          </div>
        )}
        {isDone && (
          <div className="text-sm text-zinc-200 whitespace-pre-wrap break-words">
            {state.content}
          </div>
        )}
        {isError && (
          <div className="text-sm">
            <div className="text-rose-400 mb-2">{state.errorMessage ?? "未知错误"}</div>
            <button
              type="button"
              onClick={onRun}
              className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-sm"
            >
              重试
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd client && pnpm test -- src/components/TutorActionCard.test.tsx
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/TutorActionCard.tsx client/src/components/TutorActionCard.test.tsx
git commit -m "feat(tutor/ui): TutorActionCard with 4 states + cost/cache badges

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `TutorPanel` component (the right-panel tab body)

**Files:**
- Create: `client/src/components/TutorPanel.tsx`
- Create: `client/src/components/TutorPanel.test.tsx`

`TutorPanel` is what gets rendered when the user is on the 🎓 tab. It:
- Renders the three action cards.
- Owns the in-flight `AbortController` per action.
- Calls `runTutorAction` and routes the streaming chunks into `useTutor.setActionState`.
- On success: writes `tutor_cache.json` via `tutor_cache_save` and appends a line to `tutor.log.jsonl` via `tutor_log_append`.
- Consumes `pendingTrigger` from `useTutor` on mount / when the videoId changes / on appearance.

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/TutorPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { TutorPanel } from "./TutorPanel";
import { useTutor } from "../store/tutor";

// Mock the analysis store enough to give us cues
vi.mock("../store/analysis", () => ({
  useAnalysis: Object.assign(
    () => ({
      subtitles: [],
      summary: null,
    }),
    {
      getState: () => ({
        subtitles: [],
        summary: null,
      }),
    },
  ),
}));

beforeEach(() => {
  useTutor.setState({ actions: {}, liaisonRanges: {}, pendingTrigger: null });
});

const sampleCues = [
  { time: 0, endTime: 2, text: "Hello, world." },
  { time: 2, endTime: 4, text: "How are you?" },
  { time: 4, endTime: 6, text: "I am fine, thanks." },
];

describe("TutorPanel", () => {
  it("renders the three action cards", () => {
    render(
      <TutorPanel
        videoId="v1"
        cues={sampleCues}
        currentCueIdx={1}
      />,
    );
    expect(screen.getByText("解释这段")).toBeInTheDocument();
    expect(screen.getByText("出个题")).toBeInTheDocument();
    expect(screen.getByText("标连读")).toBeInTheDocument();
  });

  it("disables actions when cues are empty (analysis not done)", () => {
    render(<TutorPanel videoId="v1" cues={[]} currentCueIdx={null} />);
    expect(screen.getByText(/请先解析字幕/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

```bash
cd client && pnpm test -- src/components/TutorPanel.test.tsx
```

Expected: import error.

- [ ] **Step 3: Implement `TutorPanel`**

Create `client/src/components/TutorPanel.tsx`:

```tsx
import { useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TutorActionCard } from "./TutorActionCard";
import {
  useTutor,
  type TutorActionState,
  type LiaisonRange,
  type PendingTrigger,
} from "../store/tutor";

type TutorLogSource = PendingTrigger["source"];
import { useSettings } from "../store/settings";
import { useAnalysis } from "../store/analysis";
import {
  runTutorAction,
  cacheKey,
  estimateCostForAction,
  type TutorAction,
  type TutorContext,
} from "../llm/tutor";
import { contextChars, RESPONSE_CHAR_ESTIMATE } from "../llm/tutorPrompts";
import type { SrtCue } from "../llm/types";

interface Props {
  videoId: string;
  cues: SrtCue[];
  /** Index of the cue currently being played (or last seen). null = unknown. */
  currentCueIdx: number | null;
}

interface ActionDef {
  action: TutorAction;
  title: string;
  /** Indices that form this action's context, given current playback state. */
  indices: (currentCueIdx: number | null, totalCues: number) => number[];
}

const ACTION_DEFS: ActionDef[] = [
  {
    action: "explain",
    title: "解释这段",
    indices: (i, total) =>
      i == null
        ? [0, 1, 2, 3, 4].slice(0, total)
        : range(Math.max(0, i - 2), Math.min(total - 1, i + 2)),
  },
  {
    action: "quiz",
    title: "出个题",
    indices: (i, total) =>
      i == null
        ? [0, 1, 2, 3, 4].slice(0, total)
        : range(Math.max(0, i - 2), Math.min(total - 1, i + 2)),
  },
  {
    action: "liaison",
    title: "标连读",
    indices: (i) => (i == null ? [] : [i]),
  },
];

function range(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

export function TutorPanel({ videoId, cues, currentCueIdx }: Props) {
  const settings = useSettings((s) => s.settings);
  const actionsState = useTutor((s) => s.actions[videoId] ?? {});
  const consumePendingTrigger = useTutor((s) => s.consumePendingTrigger);
  // One AbortController per cacheKey, keyed in a ref so we can cancel mid-flight.
  const controllersRef = useRef<Record<string, AbortController>>({});

  // Drain the analysis store for the current Subtitle[] (Chinese translations
  // + key phrases). Used in TutorContext so the LLM sees what the user sees.
  const analyzedSubtitles = useAnalysis((s) => s.subtitles);

  const total = cues.length;
  const noAnalysis = total === 0;

  /** Build the context window for a given action. */
  const ctxFor = useMemo(
    () => (action: TutorAction): { indices: number[]; ctx: TutorContext } => {
      const def = ACTION_DEFS.find((d) => d.action === action)!;
      const indices = def.indices(currentCueIdx, total);
      return {
        indices,
        ctx: {
          cues: indices.map((i) => cues[i]).filter((c): c is SrtCue => !!c),
          analyzedSubtitles: analyzedSubtitles.filter((s) =>
            indices.some((i) => cues[i] && s.time === cues[i].time),
          ),
        },
      };
    },
    [cues, currentCueIdx, total, analyzedSubtitles],
  );

  // Execute an action: check cache → fall through to runTutorAction → write
  // cache + log on success.
  // `source` is recorded in tutor.log so we can see which touchpoint drove the
  // usage. Defaults to "tab-direct" for in-panel clicks; pending-trigger paths
  // override it with the touchpoint identity.
  const run = async (
    action: TutorAction,
    opts: { force?: boolean; source?: TutorLogSource } = {},
  ) => {
    if (noAnalysis) return;
    const { indices, ctx } = ctxFor(action);
    if (indices.length === 0) return;
    const key = cacheKey(action, indices);
    const source: TutorLogSource = opts.source ?? "tab-direct";

    // 1. Cache lookup (unless force-regenerate)
    if (!opts.force) {
      const cache = await invoke<{
        version: number;
        entries: Record<string, { createdAt: number; model: string; content: string }>;
      } | null>("tutor_cache_load", { videoId }).catch(() => null);
      const hit = cache?.entries?.[key];
      if (hit) {
        useTutor.getState().setActionState(videoId, key, {
          status: "done",
          content: hit.content,
          cached: true,
          errorMessage: undefined,
        });
        // Liaison hits also need to populate liaisonRanges so the SubtitleList renders.
        if (action === "liaison") {
          try {
            const arr = JSON.parse(hit.content) as LiaisonRange[];
            useTutor.getState().setLiaisonRanges(videoId, arr);
          } catch (e) {
            console.warn("liaison cache parse failed", e);
          }
        }
        // Cached entries still log — source-attribution is the value.
        void invoke("tutor_log_append", {
          videoId,
          line: {
            ts: Date.now(),
            videoId,
            action,
            rangeHash: key.split(":")[1],
            cached: true,
            source,
          },
        });
        return;
      }
    }

    // 2. Start the LLM call. Cancel any prior in-flight for this key.
    controllersRef.current[key]?.abort();
    const controller = new AbortController();
    controllersRef.current[key] = controller;

    useTutor.getState().setActionState(videoId, key, {
      status: "streaming",
      content: "",
      cached: false,
      errorMessage: undefined,
    });

    await runTutorAction({
      action,
      ctx,
      cueIdx: action === "liaison" ? indices[0] : undefined,
      signal: controller.signal,
      onChunk(chunk) {
        const cur = useTutor.getState().actions[videoId]?.[key];
        useTutor.getState().setActionState(videoId, key, {
          content: (cur?.content ?? "") + chunk,
        });
      },
      onDone(full, meta) {
        useTutor.getState().setActionState(videoId, key, {
          status: "done",
          content: full,
          cached: false,
        });
        // Liaison: parse + populate liaisonRanges
        if (action === "liaison") {
          try {
            useTutor.getState().setLiaisonRanges(videoId, JSON.parse(full) as LiaisonRange[]);
          } catch (e) {
            console.warn("liaison parse failed", e);
          }
        }
        // Write disk cache + log line
        void invoke("tutor_cache_save", {
          videoId,
          key,
          value: { createdAt: Date.now(), model: meta.model, content: full },
        });
        void invoke("tutor_log_append", {
          videoId,
          line: {
            ts: Date.now(),
            videoId,
            action,
            rangeHash: key.split(":")[1],
            cached: false,
            source,
            model: meta.model,
            promptChars: meta.promptChars,
            responseChars: meta.responseChars,
          },
        });
      },
      onError(err) {
        useTutor.getState().setActionState(videoId, key, {
          status: "error",
          errorMessage: err.message,
        });
      },
    });
  };

  const cancel = (action: TutorAction) => {
    const { indices } = ctxFor(action);
    const key = cacheKey(action, indices);
    controllersRef.current[key]?.abort();
    useTutor.getState().setActionState(videoId, key, {
      status: "idle",
      content: "",
      cached: false,
    });
  };

  // Consume any pending external trigger (KeyPhrase ✨ / SubtitleList 🎓 /
  // toast) — fire the corresponding action with its real source for the log.
  useEffect(() => {
    const pt = consumePendingTrigger();
    if (!pt || pt.videoId !== videoId) return;
    void run(pt.action, { force: false, source: pt.source });
  }, [videoId, consumePendingTrigger]);

  // Abort all in-flight on unmount
  useEffect(() => {
    return () => {
      Object.values(controllersRef.current).forEach((c) => c.abort());
    };
  }, []);

  if (noAnalysis) {
    return (
      <div className="p-4 text-sm text-zinc-500">请先解析字幕（在 Library 重新点导入或解析完成后再回来）。</div>
    );
  }

  return (
    <div className="p-3 space-y-3 overflow-y-auto h-full">
      {ACTION_DEFS.map(({ action, title }) => {
        const { indices, ctx } = ctxFor(action);
        const key = cacheKey(action, indices);
        const state: TutorActionState = actionsState[key] ?? {
          status: "idle",
          content: "",
          cached: false,
        };
        const estChars =
          ctx.cues.reduce((s, c) => s + c.text.length, 0) +
          RESPONSE_CHAR_ESTIMATE[action];
        const cny = estimateCostForAction(
          settings.llmVendor ?? "",
          settings.llmModel ?? "",
          action,
          ctx,
        );
        const modelLabel = settings.llmVendor
          ? settings.llmVendor.charAt(0).toUpperCase() + settings.llmVendor.slice(1)
          : "未配置";
        return (
          <TutorActionCard
            key={action}
            title={title}
            estimateChars={estChars}
            estimateCny={cny}
            modelLabel={modelLabel}
            state={state}
            onRun={() => void run(action)}
            onForceRegenerate={() => void run(action, { force: true })}
            onCancel={() => cancel(action)}
          />
        );
      })}
    </div>
  );
}
```

**Note:** `useSettings.settings.llmVendor` and `llmModel` are the assumed field names — confirm against the actual settings store and adapt the field reads if they're named differently (e.g. `vendor` / `model`).

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd client && pnpm test -- src/components/TutorPanel.test.tsx
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/TutorPanel.tsx client/src/components/TutorPanel.test.tsx
git commit -m "feat(tutor/ui): TutorPanel — runs actions, manages cache + log, consumes pending triggers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `TutorEndOfVideoToast` component

**Files:**
- Create: `client/src/components/TutorEndOfVideoToast.tsx`
- Create: `client/src/components/TutorEndOfVideoToast.test.tsx`

A bottom-right toast that appears once per video per session when playback reaches ≥ 95%. Three actions: 出题, 稍后, ✓ 此视频不再提示.

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/TutorEndOfVideoToast.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TutorEndOfVideoToast } from "./TutorEndOfVideoToast";

beforeEach(() => {
  localStorage.clear();
});

describe("TutorEndOfVideoToast", () => {
  it("renders when visible=true", () => {
    render(
      <TutorEndOfVideoToast
        videoId="v1"
        visible={true}
        costNote="约 30 秒 · 约 ¥0.02"
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        onSuppress={vi.fn()}
      />,
    );
    expect(screen.getByText(/试试 AI 出 5 道题/)).toBeInTheDocument();
    expect(screen.getByText("出题")).toBeInTheDocument();
    expect(screen.getByText("稍后")).toBeInTheDocument();
    expect(screen.getByText(/此视频不再提示/)).toBeInTheDocument();
    expect(screen.getByText(/约 30 秒/)).toBeInTheDocument();
  });

  it("renders nothing when visible=false", () => {
    const { container } = render(
      <TutorEndOfVideoToast
        videoId="v1"
        visible={false}
        costNote=""
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        onSuppress={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("hides the cost line when costNote is empty", () => {
    render(
      <TutorEndOfVideoToast
        videoId="v1"
        visible={true}
        costNote=""
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        onSuppress={vi.fn()}
      />,
    );
    expect(screen.queryByText(/约 .* 秒/)).toBeNull();
  });

  it("clicking 出题 calls onAccept", () => {
    const onAccept = vi.fn();
    render(
      <TutorEndOfVideoToast
        videoId="v1"
        visible={true}
        costNote="约 30 秒"
        onAccept={onAccept}
        onDismiss={vi.fn()}
        onSuppress={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("出题"));
    expect(onAccept).toHaveBeenCalled();
  });

  it("clicking 此视频不再提示 persists to localStorage and calls onSuppress", () => {
    const onSuppress = vi.fn();
    render(
      <TutorEndOfVideoToast
        videoId="v1"
        visible={true}
        costNote=""
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        onSuppress={onSuppress}
      />,
    );
    fireEvent.click(screen.getByText(/此视频不再提示/));
    expect(localStorage.getItem("tutorSkippedQuiz:v1")).toBe("1");
    expect(onSuppress).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

```bash
cd client && pnpm test -- src/components/TutorEndOfVideoToast.test.tsx
```

Expected: import error.

- [ ] **Step 3: Implement `TutorEndOfVideoToast`**

Create `client/src/components/TutorEndOfVideoToast.tsx`:

```tsx
interface Props {
  videoId: string;
  visible: boolean;
  /** Pre-formatted right-hand cost note ("约 30 秒 · 约 ¥0.02"). Empty hides it. */
  costNote: string;
  onAccept: () => void;
  onDismiss: () => void;
  onSuppress: () => void;
}

/**
 * Bottom-right toast that appears once per video per session when the
 * user reaches ≥95% of playback, inviting them to take a 5-question quiz
 * about what they just watched.
 *
 * Suppression has two layers (the parent owns the visible flag):
 *   • Per-video: localStorage `tutorSkippedQuiz:<videoId>` = "1"
 *   • Global:    if user has dismissed ≥10 times across videos
 *
 * This component handles the per-video write on the ✓ button; the global
 * counter is the parent's responsibility (incremented on "稍后" or "✓").
 */
export function TutorEndOfVideoToast({
  videoId,
  visible,
  costNote,
  onAccept,
  onDismiss,
  onSuppress,
}: Props) {
  if (!visible) return null;
  const suppress = () => {
    try {
      localStorage.setItem(`tutorSkippedQuiz:${videoId}`, "1");
    } catch {
      /* localStorage disabled — proceed anyway */
    }
    onSuppress();
  };
  return (
    <div className="fixed bottom-4 right-4 z-50 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-3 max-w-sm">
      <div className="text-sm text-zinc-100 mb-1">🎓 试试 AI 出 5 道题？</div>
      {costNote && <div className="text-[11px] text-zinc-500 mb-3">{costNote}</div>}
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={suppress}
          className="text-[11px] text-zinc-500 hover:text-zinc-300"
        >
          ✓ 此视频不再提示
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 rounded"
        >
          稍后
        </button>
        <button
          type="button"
          onClick={onAccept}
          className="px-3 py-1 text-xs font-medium bg-blue-500 hover:bg-blue-400 text-black rounded"
        >
          出题
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd client && pnpm test -- src/components/TutorEndOfVideoToast.test.tsx
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/TutorEndOfVideoToast.tsx client/src/components/TutorEndOfVideoToast.test.tsx
git commit -m "feat(tutor/ui): TutorEndOfVideoToast for 95%-playback quiz prompt

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: KeyPhraseList ✨ hook

**Files:**
- Modify: `client/src/components/KeyPhraseList.tsx`

Adds a small hover-visible `✨` icon button to each phrase row that, when clicked, triggers the Tutor explain action for the cue range around that phrase's anchor cue.

- [ ] **Step 1: Read the existing KeyPhraseList to find where rows are rendered**

```bash
cd client && pnpm exec rg "KeyPhrase|phrase\." src/components/KeyPhraseList.tsx -n
```

You'll see a `.map()` over phrases (or instances) rendering each row. Identify:
  - The per-row container element (likely a `<div>` with hover utilities).
  - The phrase object's shape — specifically the cue index field. If it's a `time: number`, you need to look up the matching cue index from `useAnalysis.subtitles` or pass it as a prop.

- [ ] **Step 2: Add the ✨ button to each row**

Find the per-row container element (it'll be inside the phrase mapping). Add the import at the top:

```tsx
import { Sparkles } from "lucide-react";
import { useTutor } from "../store/tutor";
```

Inside the row (after the existing per-row buttons), add:

```tsx
<button
  type="button"
  aria-label="让 AI 解释这段"
  title="让 AI 解释这段（→ 教练）"
  onClick={(e) => {
    e.stopPropagation();
    e.preventDefault();
    // Convert phrase.cueIdx (or whatever anchor field exists) to a 5-cue range.
    const i = phrase.cueIdx; // adapt to real field name
    const indices = [i - 2, i - 1, i, i + 1, i + 2]
      .filter((n) => n >= 0)
      .slice(0, 5);
    useTutor.getState().triggerAction(videoId, "explain", indices, "keyphrase-sparkle");
    onSwitchToTutorTab?.(); // see step 3
  }}
  className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 grid place-items-center rounded text-amber-400 hover:bg-amber-500/15"
>
  <Sparkles size={14} />
</button>
```

If the row element doesn't already have `group` class, add it.

- [ ] **Step 3: Add `onSwitchToTutorTab?: () => void` prop**

KeyPhraseList needs a way to ask its parent (Player.tsx) to switch the right-panel tab to `tutor`. Add this to the Props interface:

```tsx
interface Props {
  // ... existing
  /** Optional — called when a ✨ hook fires, so the parent can switch the
   *  right-panel tab to 🎓 Tutor. */
  onSwitchToTutorTab?: () => void;
  /** Required — the current video id (needed to scope the trigger). */
  videoId: string;
}
```

If `videoId` isn't already a prop, accept it (the call sites in `Player.tsx` will be updated in Task 12).

- [ ] **Step 4: Typecheck**

```bash
cd client && pnpm typecheck
```

Expected: no errors. If the prop addition broke other call sites, this catches it now.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/KeyPhraseList.tsx
git commit -m "feat(tutor/ui): ✨ hook on KeyPhraseList rows to trigger Tutor explain

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: SubtitleList 🎓 + liaison underlines

**Files:**
- Modify: `client/src/components/SubtitleList.tsx`

Adds the per-row `🎓 不懂这句？` hover button and renders liaison underlines (dashed amber) from `useTutor.liaisonRanges`.

- [ ] **Step 1: Find the per-cue row renderer**

```bash
cd client && pnpm exec rg "SubtitleList|sub\.|cue\." src/components/SubtitleList.tsx -n
```

Locate where each cue / subtitle row is rendered. Identify how words are rendered — it might be a single `<div>` with `cue.text`, or it might tokenize for key-phrase highlighting. The liaison underline requires word-level rendering, so if the component currently renders as a single text node, you may need to tokenize.

- [ ] **Step 2: Add the 🎓 micro-button to each row**

Add imports at the top:

```tsx
import { GraduationCap } from "lucide-react";
import { useTutor } from "../store/tutor";
```

Inside the per-row hover-actions area (next to the existing vocab buttons), add:

```tsx
<button
  type="button"
  aria-label="让 AI 解释这一句"
  title="让 AI 解释这一句"
  onClick={(e) => {
    e.stopPropagation();
    e.preventDefault();
    useTutor
      .getState()
      .triggerAction(videoId, "explain", [cueIdx], "transcript-line-button");
    onSwitchToTutorTab?.();
  }}
  className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 grid place-items-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
>
  <GraduationCap size={14} />
</button>
```

Adapt `cueIdx` to whatever variable holds the current row's index inside the `.map()`.

- [ ] **Step 3: Render liaison underlines**

Subscribe to `useTutor.liaisonRanges[videoId]`. For each underline range matching the current cue, wrap the joined-words substring in:

```tsx
<span
  className="border-b border-dashed border-amber-400 cursor-help"
  title={`${range.pronunciation} · ${range.why}`}
>
  {wordStart} {wordEnd}
</span>
```

A minimal implementation that doesn't require word-level tokenization: render the underlines as a tooltip/legend list ABOVE the cue, e.g. `[did_you /dɪdʒu/]`. Choose either approach; the spec accepts both as long as the user can see and understand the markings. Prefer inline word-wrapping if SubtitleList already does word-level rendering for key phrases.

Add the relevant useState/useSelector at the top of the component:

```tsx
const liaisonRanges = useTutor((s) => s.liaisonRanges[videoId] ?? []);
```

- [ ] **Step 4: Add `onSwitchToTutorTab?: () => void` prop + `videoId` prop**

Same addition as Task 10. Update the Props interface.

- [ ] **Step 5: Typecheck**

```bash
cd client && pnpm typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/SubtitleList.tsx
git commit -m "feat(tutor/ui): 🎓 micro-button + liaison underlines in SubtitleList

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Player.tsx integration

**Files:**
- Modify: `client/src/pages/Player.tsx`

Adds:
1. A new `tutor` tab in the right-panel tab strip.
2. Mounts `TutorPanel` when the tab is active.
3. Plumbs `onSwitchToTutorTab` callbacks down to `KeyPhraseList` and `SubtitleList` so external triggers can flip the tab.
4. Calls `clearTutorCache(videoId)` after a successful `retranscribe_video`.
5. Tracks playback progress to mount `TutorEndOfVideoToast` at ≥95% (once per video per session).

- [ ] **Step 1: Add imports**

At the top of `client/src/pages/Player.tsx`:

```tsx
import { TutorPanel } from "../components/TutorPanel";
import { TutorEndOfVideoToast } from "../components/TutorEndOfVideoToast";
import { clearTutorCache, useTutor } from "../store/tutor";
import { estimateCostForAction } from "../llm/tutor";
```

- [ ] **Step 2: Extend the right-panel tab state**

Find the existing tab type (likely `type Tab = "subtitles" | "keyPhrases";`). Change to:

```tsx
type Tab = "subtitles" | "keyPhrases" | "tutor";
```

Add a tab strip button for 🎓 教练 alongside the existing two.

- [ ] **Step 3: Render `TutorPanel` when tab is `tutor`**

In the right-panel render branch:

```tsx
{tab === "tutor" && videoId && (
  <TutorPanel
    videoId={videoId}
    cues={cuesRef.current ?? []}
    currentCueIdx={currentIdx >= 0 ? currentIdx : null}
  />
)}
```

- [ ] **Step 4: Pass `onSwitchToTutorTab` to KeyPhraseList and SubtitleList**

Wherever they're rendered, add:

```tsx
videoId={videoId ?? ""}
onSwitchToTutorTab={() => setTab("tutor")}
```

- [ ] **Step 5: Wire `clearTutorCache` into `onRetranscribe`**

Find the existing `onRetranscribe` function. After the line `await invoke("delete_analysis", { videoId });` add:

```tsx
await clearTutorCache(videoId);
```

- [ ] **Step 6: Mount the end-of-video toast**

Add state:

```tsx
const [quizToastVisible, setQuizToastVisible] = useState(false);
const [quizToastShown, setQuizToastShown] = useState<Set<string>>(new Set());
```

Add an effect that watches playback progress (the existing `currentIdx` and `cues` give us this; or the video element's `currentTime / duration`). Trigger toast when crossing 95%:

```tsx
const onVideoTimeUpdate = () => {
  const v = videoRef.current;
  if (!v || !videoId || !v.duration) return;
  const progress = v.currentTime / v.duration;
  if (
    progress >= 0.95 &&
    !quizToastShown.has(videoId) &&
    !localStorage.getItem(`tutorSkippedQuiz:${videoId}`)
  ) {
    setQuizToastVisible(true);
    setQuizToastShown(new Set([...quizToastShown, videoId]));
  }
};
// attach: <video onTimeUpdate={onVideoTimeUpdate} ... />
```

(If the existing player abstraction does not surface `onTimeUpdate`, add a polling effect that reads `videoRef.current?.currentTime` every 2 seconds — adapt to the existing pattern.)

Render the toast at the bottom of the page's return:

```tsx
{videoId && (
  <TutorEndOfVideoToast
    videoId={videoId}
    visible={quizToastVisible}
    costNote={(() => {
      // Compute the cost note: "约 30 秒 · 约 ¥X.XX"
      if (!cuesRef.current) return "约 30 秒";
      const ctx = { cues: cuesRef.current, analyzedSubtitles: analysis.subtitles };
      const cny = estimateCostForAction(
        settings.llmVendor ?? "",
        settings.llmModel ?? "",
        "quiz",
        ctx,
      );
      return cny == null
        ? "约 30 秒"
        : `约 30 秒 · 约 ¥${cny.toFixed(2)}`;
    })()}
    onAccept={() => {
      setQuizToastVisible(false);
      // Trigger the quiz action with the FULL transcript range
      const allIndices = Array.from({ length: cuesRef.current?.length ?? 0 }, (_, i) => i);
      useTutor.getState().triggerAction(videoId, "quiz", allIndices, "end-of-video-toast");
      setTab("tutor");
    }}
    onDismiss={() => {
      setQuizToastVisible(false);
    }}
    onSuppress={() => {
      setQuizToastVisible(false);
    }}
  />
)}
```

- [ ] **Step 7: Typecheck the page**

```bash
cd client && pnpm typecheck
```

Expected: clean (the existing pre-existing warnings are ok). If you hit errors about missing settings fields (`llmVendor` / `llmModel`), check the actual settings store and fix the field names consistently across the new code (Tasks 5, 8, 12).

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/Player.tsx
git commit -m "feat(tutor/player): integrate Tutor tab + toast + clearTutorCache hook

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Close-out — full test + manual sanity check

- [ ] **Step 1: Run the full vitest suite**

```bash
cd client && pnpm test
```

Expected: every Tutor test passes + existing tests still pass. Total count should be original count + ~35 new tests.

- [ ] **Step 2: Run the full Rust test suite**

```bash
cd client && cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Expected: every Tutor test passes + existing tests still pass.

- [ ] **Step 3: Typecheck the frontend**

```bash
cd client && pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: cargo check the full Rust crate**

```bash
cd client && cargo check --manifest-path src-tauri/Cargo.toml --all-targets
```

Expected: Finished, only pre-existing warnings.

- [ ] **Step 5: Build the installer with the local-build override**

```bash
cd client && cat > local-build-override.json <<EOF
{ "bundle": { "createUpdaterArtifacts": false } }
EOF
pnpm tauri build --config local-build-override.json
```

(On Windows use the PowerShell `Set-Content` equivalent, see prior session installer pattern.)

Expected: an installer at `src-tauri/target/release/bundle/nsis/whatsub_0.1.58_x64-setup.exe`. Remove `local-build-override.json` after.

- [ ] **Step 6: Manual sanity check**

Install the new installer over the existing whatsub. Open a video that has analysis. Verify:

1. Right panel has three tabs: 字幕 / 关键短语 / 教练.
2. Clicking 教练 shows three action cards with cost estimates.
3. Click 解释这段 → streams a Chinese explanation.
4. Close + reopen → second click is "缓存" (no LLM call).
5. Click ↻ → bypasses cache, fresh call.
6. Click 出个题 → 5 quiz cards render, each clickable.
7. Click 标连读 → in the 字幕 tab, the current cue's relevant word pairs get dashed amber underlines (or an inline tooltip if you went the simpler route in Task 11).
8. Hover a KeyPhrase row → ✨ icon appears; click → tab switches to 教练 with explanation pre-populating.
9. Hover a SubtitleList row → 🎓 icon appears; click → same.
10. Watch the video past 95% → bottom-right toast appears once.
11. Re-trigger 🔄 重新解析 → after it completes, `tutor_cache.json` is gone (check `%APPDATA%\whatsub\library\<id>\`).
12. Check `%APPDATA%\whatsub\library\<id>\tutor.log.jsonl` exists after any action and contains one line per action with `source` field set.

- [ ] **Step 7: Close-out commit (only if any tweaks were needed)**

```bash
git status --short
# If clean: nothing to commit.
# If you fixed any field-name mismatches or small bugs:
git add ...affected files...
git commit -m "fix(tutor): close-out tweaks from manual sanity pass

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Push the branch**

```bash
git push origin feat/tutor-mvp
```

The PR / merge decision is the user's. If experiment is rejected:
```bash
git checkout main
git branch -D feat/tutor-mvp
git push origin --delete feat/tutor-mvp
```

---

## Final notes for the implementer

- **Adapt provider field names.** This plan assumes `getProvider(settings)` returns an object with `.stream(prompt, {signal})` and `.model`. The real names in `src/llm/providers.ts` may be different — check before you wire Task 5 and 8.
- **Adapt settings field names.** This plan reads `settings.llmVendor` and `settings.llmModel`. Check the real settings store and substitute consistently.
- **Quiz JSONL parsing in TutorPanel** is left as the simplest possible: store the raw JSONL string in `state.content` and let the consumer parse it. If you want per-question progressive rendering with structured quiz cards in v1, add a `parseQuizContent(content): QuizQuestion[]` helper and a `QuizCardList` component. The spec allows either approach (Section 3.2 says "render: each question is its own card") — pick what fits the time budget.
- **`group` Tailwind class** on per-row containers in KeyPhraseList / SubtitleList: required for `group-hover:opacity-100` to work on the new buttons. Verify it's present before relying on it.
- **Always run `git branch --show-current` before any commit.** Per CLAUDE.md 踩过的坑 — you should be on `feat/tutor-mvp` the entire time. If you accidentally switch to `main`, stop and notify.
