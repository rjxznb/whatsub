# whatsub Tutor MVP — Design Spec

**Date:** 2026-05-29
**Status:** Approved (brainstorming)
**Position:** First of three sub-projects in the whatsub "AI Native" pivot.
**Successors (separate specs, future):** `Profile` (user memory/progression), `Curator` (AI search and recommendation).

---

## 1. Overview

Tutor is an in-video AI assistant in the Player page. While watching, the user can trigger three focused, single-shot LLM actions about the dialogue they are watching: get a deeper explanation, take a 5-question quiz, or see where connected speech (liaison) happens.

Every Tutor action is an independent, stateless LLM call — no conversation history, no multi-turn chat. Outputs are cached on disk so re-viewing the same explanation costs zero tokens. Every completed action also appends one line to `tutor.log.jsonl`, the data contract the future `Profile` sub-project will consume read-only.

### Why ship Tutor first

- Zero backend, zero new schemas the user designs ahead of usage, no architectural pivot.
- Cheapest to ship (estimate: 1–2 weeks).
- Each action provides standalone user value — the MVP is shippable even if `Profile`/`Curator` never come.
- Generates the interaction-data substrate `Profile` will sit on top of.

### Constraints carried over from current whatsub

- Multi-vendor LLM (DeepSeek / Claude / Gemini / ...) configured via Settings; **Tutor reuses the existing provider abstraction**, no new provider config UX.
- The user supplies their own LLM key (BYOK). Tutor's actions consume the user's tokens, not whatsub's.
- No new whatsub-license backend endpoints. No iOS counterpart in this MVP.

---

## 2. Out of scope (explicitly cut)

- **Bottom "其他问题…" freeform input box.** Deferred. Re-evaluate after 4–6 weeks of `tutor.log` data shows whether users want open-ended questions.
- **Multi-turn conversational chat panel.** A chat-thread UX where the user converses with an AI tutor that remembers across turns. Deferred until activation data shows users want it.
- **Selection-popover UX on the transcript.** Selecting text in the transcript to pop an action menu. Considered and rejected — UX invention cost is high, the existing right-click `ContextMenu` would conflict, and the three other touchpoints already cover the discoverability need.
- **Voice input or output.**
- **A "history viewer" archive of past AI interactions** in the UI. State is session-only; persistence is only for the cost-cache and the Profile log.
- **"Grammar tree" and "related vocabulary" preset actions.** The first is implicit in 解释这段; the second overlaps with existing keyPhrases + vocab features.
- **`Profile` (user memory layer) and `Curator` (AI search/recommendation).** Future sub-projects.
- **iOS counterpart.** Tutor is desktop-only. The `tutor.log` schema is forward-compatible if Profile later needs cloud sync, but that is not Tutor's concern.

---

## 3. Three actions (the entire MVP)

### 3.1 解释这段 (Explain this passage)

- **Context range:** current cue plus 2 cues before and 2 after (5 cues total). **Fixed for MVP** — no user-adjustable handles.
- **LLM output:** streaming markdown — explains what the dialogue means, cultural / idiomatic context, conversational register, why the translator chose specific Chinese phrasings.
- **Render:** in-place markdown in the action card's result area.

### 3.2 出个题 (Take a quiz)

- **Context range:**
  - When triggered from inside the tab or from a touchpoint scoped to a cue range: same as 解释这段 (current cue ± 2).
  - When triggered from the **end-of-video toast**: entire transcript.
- **LLM output:** JSON Lines, one question per line. 5 total: 2 vocab, 2 comprehension, 1 grammar.
- **Per-question schema:**
  ```json
  {
    "q": "What does '...' mean in this context?",
    "type": "vocab" | "comprehension" | "grammar",
    "options": ["A", "B", "C", "D"],
    "answer": 1,
    "explain": "..."
  }
  ```
- **Render:** each question is its own card. Per-card state: `unanswered → answered → revealed`. Clicking an option marks answered and shows correct/wrong tint immediately. A "Reveal explanation" button shows `explain`.
- **Persistence:** per-quiz state is component-local only. Refresh resets. Only `{quizCorrect, quizTotal}` is appended to `tutor.log.jsonl` when the user completes all 5.

### 3.3 标连读 (Mark liaisons)

- **Context range:** current cue only.
- **LLM output:** JSON array of liaison instances.
- **Schema:**
  ```json
  [
    {
      "cueIdx": 13,
      "wordStart": "did",
      "wordEnd": "you",
      "pronunciation": "/dɪdʒu/",
      "why": "voiced t + y → /dʒ/"
    }
  ]
  ```
- **Render:** in the existing `SubtitleList` per-word rendering, draw a dashed amber underline between the joined words. Hover pops a small card with `pronunciation` and `why`.
- **Persistence:** `useTutor.liaisonRanges[videoId]` in zustand for the session; the cached JSON is also re-loaded on next visit via the action cache (Section 5.3). No separate persistence file.

---

## 4. Discoverability (three touchpoints)

The 🎓 Tutor tab in the Player right panel exists, but most users will not find it on their own. Three independent touchpoints surface Tutor's value where the user already is.

### 4.1 KeyPhrase ✨ Hook

In the existing 关键短语 tab, each phrase row gets a `✨` icon on hover (right-aligned with the existing per-row buttons). Clicking it:

1. Switches the right panel tab to 🎓 Tutor.
2. Pre-fills "解释这段" with context = the cue containing that phrase ± 2 cues.
3. **Auto-fires** the action (skipping the click-to-run step).

### 4.2 字幕条目 🎓 微按钮

In `SubtitleList`, each cue row's hover-actions area (already houses vocab buttons) gets a small `🎓 不懂这句？` button. Clicking it:

1. Switches the right panel tab to 🎓 Tutor.
2. Pre-fills "解释这段" with context = **just this single cue** (narrower than the ✨ hook).
3. Auto-fires.

### 4.3 End-of-video toast

When playback reaches ≥ 95 % of duration, a bottom-right toast appears (at most once per video per session):

```
🎓 试试 AI 出 5 道题？大约 30 秒 · 约 ¥{estimateCost('quiz', fullTranscript)}
   [出题]   [稍后]   [✓ 此视频不再提示]
```

The `¥` figure is computed via `estimateCost` (Section 5.1), the same function that drives the per-action-card estimates. If the user's configured model is missing from the pricing table, the `· 约 ¥…` segment is omitted (just "大约 30 秒"). The `30 秒` figure is a fixed copy estimate of how long the quiz takes to read; not computed.

- **`[出题]`:** switches tab to Tutor + fires 出个题 with context = the entire transcript.
- **`[稍后]`:** dismiss for this session only.
- **`[✓ 此视频不再提示]`:** persists `tutorSkippedQuiz:<videoId>` in `localStorage`. Suppresses future toasts for this video.

**Global suppression heuristic:** if the user has dismissed quiz toasts ≥ 10 times across distinct videos (counter in `localStorage`), assume disinterest and stop showing the toast globally. A Settings flag (`tutorQuizToastEnabled`) can re-enable it.

---

## 5. Cost transparency

### 5.1 Estimate display per action card

Each action card shows below the title:

```
约 800 字 · 大约 ¥0.01 · DeepSeek
```

- **Character estimate:** `promptChars + estimatedResponseChars` (typed constants per action).
- **¥ estimate:** `chars × ¥/1000chars (from the vendor+model pricing table)`, rounded up to the nearest cent (¥0.01).
- **Vendor label:** just the brand name (`DeepSeek` / `Claude` / `Gemini` / …).
- For models not in the pricing table: display `· 估算不可用` and omit the ¥ figure (still show character estimate).

### 5.2 Pricing table (`src/llm/tutorPricing.ts`)

Approximate per-character cost in CNY, derived from public per-1k-token rates assuming ≈ 1 token per 1.5 Chinese chars (or 0.75 English words). Conservative: rounded up to give the user a safe upper bound.

```ts
export const TUTOR_PRICING_CNY_PER_1K_CHARS: Record<string, number> = {
  "deepseek/deepseek-chat":      0.002,
  "deepseek/deepseek-reasoner":  0.004,
  "claude/claude-3-5-sonnet":    0.05,
  "claude/claude-3-5-haiku":     0.012,
  "openai/gpt-4o":               0.04,
  "openai/gpt-4o-mini":          0.003,
  "gemini/gemini-2-flash":       0.005,
};
```

If `provider/model` is not in the table, `estimateCost()` returns `null` and the UI hides the ¥ figure.

### 5.3 On-disk cache

Per video, file at `%APPDATA%/whatsub/library/<videoId>/tutor_cache.json`:

```json
{
  "version": 1,
  "entries": {
    "explain:c12-c14": {
      "createdAt": 1779000000000,
      "model": "deepseek-chat",
      "content": "这段对话讲的是…"
    },
    "quiz:c12-c14": {
      "createdAt": 1779000000000,
      "model": "deepseek-chat",
      "content": "[{...},{...}]"
    },
    "liaison:c13": {
      "createdAt": 1779000000000,
      "model": "deepseek-chat",
      "content": "[{...}]"
    }
  }
}
```

- **Lookup:** in-memory map seeded from disk on first action of the session (`tutor_cache_load`). Cache hit → render instantly, marked `· 缓存` in the card corner.
- **Force regenerate:** every action card has a `↻` icon. Clicking bypasses the cache, calls LLM, overwrites the entry on completion.
- **Invalidation:** the cache is cleared en bloc when `retranscribe_video` succeeds. The TS-side `onRetranscribe` handler calls a new helper `clearTutorCache(videoId)` which invokes `tutor_cache_delete(videoId)`.
- **`rangeHash` format:** lowercase string of cue indices joined with `-`, e.g. `c11-c15`. For single-cue actions (liaison): `c13`. The hash is stable across re-render and is the key portion after the `<action>:` prefix.

---

## 6. Profile data contract — `tutor.log.jsonl`

**This format is locked.** Future `Profile` consumes it read-only. Tutor never reads it back. Changing fields after Tutor ships requires a versioning bump and forward-compat handling — design conservatively now.

### 6.1 File location and format

- One file per video: `%APPDATA%/whatsub/library/<videoId>/tutor.log.jsonl`.
- Append-only. Newline-delimited JSON. One line per **completed** action (cache hit and miss both log; aborted or errored actions do **not** log).

### 6.2 Schema per line

```jsonl
{
  "ts":           1779000000000,
  "videoId":     "NgqKzgtRTL4",
  "action":      "explain" | "quiz" | "liaison",
  "rangeHash":  "c12-c14",
  "cached":      false,
  "source":     "keyphrase-sparkle" | "transcript-line-button" |
                "end-of-video-toast" | "tab-direct",
  "model":      "deepseek-chat",
  "promptChars": 1240,
  "responseChars": 820,
  "quizCorrect": 3,
  "quizTotal":   5
}
```

**Field rules:**

| Field          | Required for non-cached lines | Required for cached lines | Required for non-quiz lines | Required for quiz lines |
|----------------|-------------------------------|----------------------------|------------------------------|--------------------------|
| `ts`           | ✓ | ✓ | ✓ | ✓ |
| `videoId`      | ✓ | ✓ | ✓ | ✓ |
| `action`       | ✓ | ✓ | ✓ | ✓ |
| `rangeHash`    | ✓ | ✓ | ✓ | ✓ |
| `cached`       | ✓ (= `false`) | ✓ (= `true`) | ✓ | ✓ |
| `source`       | ✓ | ✓ | ✓ | ✓ |
| `model`        | ✓ | — (omitted; no call happened) | ✓ | ✓ |
| `promptChars`  | ✓ | — | ✓ | ✓ |
| `responseChars`| ✓ | — | ✓ | ✓ |
| `quizCorrect`  | — | — | — | ✓ (only when user completes all 5) |
| `quizTotal`    | — | — | — | ✓ (only when user completes all 5) |

**Intentionally NOT included** (Profile reconstructs by joining on `videoId` against `library.json`):

- `videoTitle`, `platform`, `sourceUrl`, `durationSec`.

**Intentionally NOT included** (privacy):

- Free-form user text. The 兜底输入框 is cut for MVP, so this is moot; if it ever comes back, only metadata (char counts, source) is logged — never the user's actual question.

### 6.3 Profile's expected use (informational, not part of this spec)

`Profile` will sweep `library/*/tutor.log.jsonl`, build per-user aggregates (weak topics, quiz trends, liaison patterns, touchpoint conversion rates). The Profile sub-project has its own design spec.

---

## 7. Architecture and files

Zero backend, zero new dependencies. Four small new Rust commands.

### 7.1 New TS files

```
src/llm/tutor.ts                       # runTutorAction(action, ctx, opts) — orchestrator
src/llm/tutorPrompts.ts                # Pure prompt builders, one per action
src/llm/tutorPricing.ts                # Vendor/model → ¥/1k chars table + estimateCost
src/components/TutorPanel.tsx          # Right-panel tab content
src/components/TutorActionCard.tsx     # Idle/streaming/done/error states + cost/cache badges
src/components/TutorEndOfVideoToast.tsx# 95% trigger toast
src/store/tutor.ts                     # zustand: pendingAction, liaisonRanges, cache map
```

(No separate `TutorLiaisonOverlay.tsx` — the underlines are rendered inline by `SubtitleList`'s existing per-word rendering. Keeps the layer count low.)

### 7.2 Modified TS files

```
src/pages/Player.tsx              # Right-panel tabs += 'tutor'; 95% playback hook;
                                  # pass pendingAction into TutorPanel; call clearTutorCache in onRetranscribe
src/components/SubtitleList.tsx   # Add 🎓 hover button; render liaison underlines from useTutor
src/components/KeyPhraseList.tsx  # Add ✨ hover button per phrase row
```

### 7.3 New Rust commands

All four follow the existing `paths::video_dir(&video_id)` pattern. No new crates.

```rust
tutor_cache_load(video_id: String)              -> AppResult<Option<Value>>
tutor_cache_save(video_id: String, key: String, value: Value) -> AppResult<()>
tutor_cache_delete(video_id: String)            -> AppResult<()>
tutor_log_append(video_id: String, line: Value) -> AppResult<()>
```

Registered in `src-tauri/src/lib.rs` next to the existing analysis commands.

### 7.4 Modified Rust files

```
src-tauri/src/commands/analysis.rs   # Add the four tutor_* commands above
src-tauri/src/lib.rs                 # Register the four
```

---

## 8. Data flow (per action)

```
[Trigger]                  [useTutor.runAction]                       [Result UI]
─────────                  ────────────────────                       ───────────
Tab card click             ├─ build cacheKey = `${action}:${rangeHash}`
KeyPhrase ✨               ├─ check in-memory cache → hit? render + log
SubtitleList 🎓            ├─ tutor_cache_load → hit? populate mem + render + log
Toast 出题                 ├─ no hit: build prompt (tutorPrompts.ts)
                           ├─ provider = getProvider(settings)
                           ├─ new AbortController
                           └─ runStreaming(provider, prompt, signal,
                                           { onChunk, onDone, onError })
                                                                       ├─ onChunk:    incremental render
                                                                       ├─ onDone:     write in-mem cache +
                                                                       │              tutor_cache_save +
                                                                       │              tutor_log_append
                                                                       └─ onError:    error state, no save, no log
```

---

## 9. Error and edge case handling

| Scenario                                          | Behavior                                                |
|---------------------------------------------------|---------------------------------------------------------|
| User switches action mid-stream                   | abort old; old card returns to idle; no save, no log    |
| Player unmounts mid-stream                        | abort all in-flight; do NOT write cache or log          |
| User clicks ✕ on streaming card                   | abort; card returns to idle; no save, no log            |
| LLM provider not configured                       | card shows "去 Settings 配置 LLM →" link; no request    |
| Network or quota error                            | error state + retry button; retry = new request         |
| `tutor_cache.json` corrupted (parse error)        | treat as empty; `console.warn`; continue                |
| `tutor.log.jsonl` corrupted (line parse fail)     | not Tutor's concern (write-only); Profile handles       |
| Same action triggered while still streaming       | dedup: ignore second click                              |
| Video re-transcribed (`onRetranscribe` succeeded) | `clearTutorCache(videoId)` after retranscribe success   |
| Toast count to dismiss ≥ 10 globally              | suppress toast globally; Settings flag to re-enable     |
| Action triggered on video without analysis        | actions disabled with tooltip "请先解析字幕"            |

---

## 10. Testing

### 10.1 Pure unit tests (vitest)

- `tutorPrompts.ts`: snapshot test each action's prompt builder for representative contexts.
- `tutorPricing.ts::estimateCost`: arithmetic, rounding-up to ¥0.01, `null` return for unknown model.
- `useTutor::rangeHash` (or whichever module owns the hash function): stability (same range → same hash) and variance (off-by-one → different hash).
- Cache key collision tests for adjacent ranges (`c11-c13` vs `c12-c14`).

### 10.2 Component tests (vitest + happy-dom)

- `TutorActionCard`: renders all four states (idle, streaming, done, error).
- "缓存" badge visible iff cached.
- Force-regenerate (`↻`) bypasses cache.
- `TutorEndOfVideoToast`: appears at 95 % playback; dismiss persists `localStorage` key; suppressed when key set.
- Cross-touchpoint trigger: clicking ✨ on a KeyPhrase row switches the active tab and fires the right action.

### 10.3 Integration tests (mocked LLM provider)

- Click action → chunks stream → final render matches expected → cache saved → log line written.
- Mid-stream abort: cache not saved, log not written.
- Re-fire same action after first completes: cache hit, no LLM call, log line still written (with `cached: true`, no model/charcounts).

### 10.4 Out of scope

- E2E (Playwright / Tauri webdriver).
- Real LLM provider tests (use mocks throughout).

---

## 11. MVP success criteria

We will observe `tutor.log` aggregates over 4–6 weeks of free-tier usage to validate the design. Approximate targets:

- **Activation:** a meaningful fraction of weekly-active Player users have triggered at least one Tutor action (validates discoverability). If activation is single-digit %, the touchpoint design is wrong, not the implementation.
- **Per-trigger source breakdown:** identifies which of (✨ hook, 🎓 button, toast, tab direct) drives the most usage. The lowest-converting one is a candidate to cut in the next iteration.
- **Quiz completion rate** (started → completed 5 of 5): a healthy completion rate validates that the 5-question length is right and the questions are valued. Low completion suggests reducing length or improving prompt quality.
- **Cost feedback:** zero or near-zero complaints in support channels about token cost (the per-card estimate worked).

If these signals fail, the design (not the implementation) is the bottleneck and we revisit before starting `Profile`.

---

## 12. Open questions deferred to implementation

The following are tactical and will be settled during implementation; they do not change the spec:

- Exact wording of the preset prompts (will iterate based on quality of LLM outputs).
- Exact toast styling, animation, dismissal interaction.
- Exact liaison underline visual (dashed amber? thickness?).
- Whether `🎓 不懂这句？` is the right wording (vs. `🎓 解释` / `🎓 这句啥意思?`) — dogfood first, A/B if needed.
