# whatsub AI Agent — MVP Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:writing-plans` to turn this spec into an implementation plan; then `superpowers:subagent-driven-development` to execute it.

**Status:** Approved by user (brainstorming session 2026-05-29). Ready for implementation planning.

**Implementation branch:** `feat/ai-agent` — to be cut from current `main` (`26e37fc` or later) when implementation starts. Spec itself ships on `main`.

**Companion archive:** `feat/tutor-mvp` at `34f60aa` is parked as a code archive. See §10 for the salvage table — ~600 lines of prompt builders, cost estimation, and cache helpers come back from there.

---

## 1. Vision

### 1.1 Why this exists

The user described the AI-Native vision as **"an AI that can act on the app via natural language."** Not three single-shot tutoring buttons (that was the parked Tutor MVP — narrower than the user actually wanted). The agent reads what page you're on, what video you're watching, what you just asked, and **calls real app commands** to do the work — search the corpus, open a video, jump to a cue, add to vocab, sync to cloud, retranscribe — with the user staying in the loop for anything destructive.

This is the **first** of three planned sub-projects:

- **v1 (this spec): Agent.** Reactive — answers questions, executes coarse tool chains, asks for confirmation on writes.
- **v1.1: Profile.** Cross-session memory of user preferences, learning weaknesses, recent activity. Injects into agent system prompt.
- **v1.2: Curator.** Proactive recommendations triggered by app events ("you finished X video, want to continue Y?").

Each sub-project ships independently. v1 alone should feel useful.

### 1.2 Locked decisions (brainstorming output)

| Dimension | Decision | Source |
|---|---|---|
| Scope | Full coverage — navigation + library + in-video AI + limited settings | Q1 (full coverage) |
| Tool-call visibility | Summary mode (natural-language results) + click-to-expand cards | Q2 (摘要模式) |
| Panel layout | Floating bottom-right widget, panel 380×560, zero layout cost when closed | Q3 (底部浮窗) |
| Confirmation strategy | Hybrid: LOW=none, MID=inline card + Toast if panel closed, HIGH=system modal | Q4 (混合) |
| Context budget | Light — current page + basic state injected per turn | Q5 (轻度) |
| History | Persistent JSON, manual clear, multi-conversation | Q6 (永久持久化) |
| Cost indicator | NOT in v1 — no ¥ accumulator in InputBox | Q7 (single-pick) |
| Confirm card timeout | NONE — cards hang indefinitely until clicked | Q7 (single-pick) |
| Panel close behavior | INTERRUPTS current stream (not silent background continuation) | Q7 (single-pick) |
| ReAct chain cap | 5 tools per turn | Q8 (5 个) |
| Vocab transparency | Total count + last 5 expressions only (no meanings, no video links) | Q9 (只透总数 + 最近 5 条) |

### 1.3 Non-goals (v1)

Explicitly **out of scope** to prevent scope creep. Adding any of these to v1 requires a spec amendment.

**UX features deferred:**

- Resizable / repositionable / themeable floating panel
- Message search, branch generation, single-message regenerate
- Multimodal input (images, voice)
- Code syntax highlighting (plain `<pre>` is fine)
- Voice output / TTS

**Capability features deferred:**

- Batch operations as dedicated tools (e.g., `sync_all_medical` — done via ReAct loop instead)
- Proactive agent actions (Curator territory — v1.2)
- Cross-session memory (Profile territory — v1.1)
- Plan-then-execute mode (v1.3)
- Global tool-call history search / audit UI
- Multiple agent personalities
- Recursive tool-calling (tools that themselves call tools — flat model only)
- Streaming JSON Lines parser for tool args (buffer whole then parse)
- Web search / external network tools
- Multi-tenant / user account switching

**Specific tools deferred from the 23-candidate list:**

- `change_llm_provider` — blocked on existing vendorKeys stash bug (CLAUDE.md TODO)
- `change_whisper_model` — would trigger 1-2GB silent download; user should manually opt in
- `import_video` proactive search — only consumes URLs the user explicitly provides
- File export tools (4 SRT variants + burned-mp4) — manual UI is faster than tool args
- Login / license / trial — security-sensitive, never exposed to LLM
- `openUrl()` to arbitrary URLs — phishing surface
- Direct subtitle text editing — `analysis.json` is ground truth; let user edit manually

Final v1 tool count: **21**.

---

## 2. Architecture

### 2.1 Component map

```
┌───────────────────────────────────────────────────────────────────┐
│ ChatWidget (right-bottom floating button, always mounted)         │
│                                                                   │
│   [open]                                                          │
│      │                                                            │
│      ▼                                                            │
│ ChatPanel (380×560 anchored floating layer)                       │
│   ├─ ConversationHeader (title dropdown · ⊕ new · ☰ menu · ✕)    │
│   ├─ MessageList                                                  │
│   │    ├─ MessageBubble(user)                                     │
│   │    ├─ MessageBubble(assistant) ← markdown + inline ToolCards  │
│   │    ├─ ToolCallCard ← collapsible by default                   │
│   │    ├─ InlineConfirmCard ← MID-risk action gate                │
│   │    └─ (SystemConfirmDialog rendered separately at app root)   │
│   └─ InputBox (textarea + send)                                   │
└───────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌───────────────────────────────────────────────────────────────────┐
│ AgentRuntime (TS, src/agent/runtime.ts) — the ReAct loop          │
│   ├─ provider.streamWithTools({systemPrompt, history, tools})     │
│   ├─ ToolRegistry — list/get/execute                              │
│   ├─ ConfirmationGate — risk classification + UI orchestration    │
│   ├─ ContextBuilder — per-turn page-state snapshot → text         │
│   └─ HistoryStore — zustand + debounced disk persistence          │
└───────────────────────────────────────────────────────────────────┘
                         │
       ┌─────────────────┼──────────────────┐
       ▼                 ▼                  ▼
   ┌────────┐      ┌─────────────┐    ┌──────────────┐
   │ vendor │      │ Tauri invoke│    │ tauri-plugin-│
   │ adapter│      │ (21 cmds)   │    │ store        │
   │  (3x)  │      │             │    │              │
   └────────┘      └─────────────┘    └──────────────┘
       │
       ▼
   DeepSeek / Claude / Gemini (BYOK)
```

### 2.2 Module ownership

| Module | Path | Responsibility |
|---|---|---|
| Runtime | `src/agent/runtime.ts` | ReAct loop: call LLM → collect tool_calls → gate → execute → feed result back → repeat until stop |
| Registry | `src/agent/registry.ts` | `ToolDef[]` source of truth; `list()` / `get(id)` |
| Tools | `src/agent/tools/<id>.ts` | One file per tool with `parameters`/`execute`/`riskTier` |
| Confirmation Gate | `src/agent/gate.ts` | `classify(toolName) → "LOW"\|"MID"\|"HIGH"`; orchestrates inline card / system modal / Toast |
| Context Builder | `src/agent/context.ts` | `snapshot() → PageSnapshot`; `render(snapshot, libSummary, vocabSummary) → string` |
| History Store | `src/store/agent.ts` | zustand + persisted JSON; conversation CRUD; debounced disk writes |
| Vendor adapter | `src/llm/providers/<vendor>.ts` (extension) | Each existing provider gains `streamWithTools()` returning unified `AsyncGenerator<AgentEvent>` |
| Player state bridge | `src/store/playerState.ts` (new) | Tiny zustand: Player.tsx writes `currentIdx`/`currentTime`; agent context reads |
| UI shell | `src/components/agent/` | `ChatWidget` / `ChatPanel` / `MessageBubble` / `ToolCallCard` / `InlineConfirmCard` |
| Rust persistence | `src-tauri/src/commands/agent.rs` (new) | `agent_history_load` / `agent_history_save` — path-injectable, tempdir-friendly tests |

### 2.3 Rust footprint

Deliberately tiny. **99% of tools** are TS-side `invoke()` of commands that already exist (`corpus_browse`, `library_sync_to_cloud`, `vocab_add`, `retranscribe_video`, etc.).

**Only new Rust:**

- `src-tauri/src/commands/agent.rs` — two commands + four path-injectable helpers + ~6 tests.
- Registration line in `src-tauri/src/lib.rs::invoke_handler`.

LLM HTTP and tool execution scheduling stay in TS (per existing CLAUDE.md architectural rule).

### 2.4 ReAct loop vs Plan-then-Execute

v1 picks **ReAct**: LLM streams text and tool_calls interleaved; runtime executes each tool_call as it lands, feeds the result back, lets LLM continue. Standard pattern, all four vendors support it natively, simplest implementation.

Coarse tool granularity (21 tools, most user requests = 1-3 calls) makes ReAct's "think-act-think-act" rhythm a fit. Plan-then-execute (LLM emits a plan, user approves, then executes) is deferred to v1.3 for complex multi-step requests like "sort my medical videos by completion %".

### 2.5 Why this Rust-light shape

| Decision | Why |
|---|---|
| LLM HTTP in TS | TS has `fetch` + Web Streams natively; matches existing `runAnalysis` pipeline; lets vendor adapters use plain `fetch` rather than Rust `reqwest`. |
| Tool execution scheduling in TS | LLM streams chunks arrive in TS; routing them to gates/registry then back into the message bubble is a single async loop. Bouncing through Rust adds no value. |
| Vendor adapters in TS | Three providers' SDKs (or hand-rolled HTTP) already live in `src/llm/providers/`. Add `streamWithTools()` next to existing `stream()`. |
| History persistence in Rust | Matches `settings.rs` / `library.rs` / `vocabulary.rs` pattern — structured user data goes through Rust for atomic write + size cap enforcement. |

---

## 3. Tool inventory (v1: 21 tools)

Risk tiers drive confirmation UI:

- **LOW**: read-only or navigation. No confirm. Direct execute.
- **MID**: writes that are easily undoable. Inline confirm card in chat; Toast if panel closed.
- **HIGH**: irreversible / destructive. System modal dialog (blocks app).

Every tool has a `description` (English, agent-facing), a JSON Schema for `parameters`, an `availableOn(page) → boolean` (for page-filtering to save tokens), and an `execute(args, ctx) → Promise<unknown>`.

### 3.1 Discovery / Query (LOW)

| ID | Description (LLM-facing, abbrev) | Wraps |
|---|---|---|
| `corpus_browse` | Search public corpus by tag list (intersection AND) and optional keyword | existing `corpus_browse` |
| `corpus_phrase_detail` | Get full detail of a corpus phrase including example instances | existing `corpus_phrase_detail` |
| `list_library` | List user's library entries, optional filter by scene/status/syncedAt | existing `library_list` + TS filter |
| `list_vocab` | List user's vocabulary, optional filter by videoId/recency | existing `vocab_list` + TS filter |

### 3.2 Navigation (LOW)

| ID | Description | Wraps |
|---|---|---|
| `open_video` | Navigate to /player/:id, optional `?t=<sec>` deep-link target | `navigate()` |
| `open_page` | Navigate to /library / /vocab / /corpus / /settings | `navigate()` |
| `seek_to_time` | On Player page only: set videoRef.currentTime | `videoRef.currentTime = sec` |
| `jump_to_cue` | On Player page only: jump to Nth subtitle cue | existing `jump(time)` |

`seek_to_time` and `jump_to_cue` have `availableOn(page) === pathname.startsWith("/player/")`.

### 3.3 In-video AI (LOW — billed but non-destructive)

These call the user's LLM a second time within a single agent turn. Counted against the ReAct 5-tool cap.

| ID | Description | Salvaged from |
|---|---|---|
| `explain_passage` | Chinese explanation of a cue range. Streams. | `tutorPrompts::buildExplainPrompt` |
| `generate_quiz` | 5-question multiple choice quiz from a cue range. JSON Lines output. | `tutorPrompts::buildQuizPrompt` |
| `mark_liaisons` | Connected-speech / liaison analysis of a single cue. JSON array output. | `tutorPrompts::buildLiaisonPrompt` |
| `translate_phrase` | Standalone Chinese translation of arbitrary English text, no cue context | new (small prompt) |

These tools are LOW risk because their effect (a text response shown to user) is reversible — no app state changes.

### 3.4 Vocabulary writes (MID, with single-add exception)

| ID | Description | Wraps |
|---|---|---|
| `vocab_add` | Add expression(s) to vocabulary, optional videoId+time | `vocab_add` |
| `vocab_remove` | Remove vocabulary entry by id | `vocab_remove` |
| `vocab_update_note` | Update note on existing entry | `vocab_update_note` |

**Special rule for `vocab_add` confirmation:** implemented via `getRisk(args)` (see §3.8):

- 1-2 entries → **LOW** (execute immediately, no confirm) + post-action Toast "已添加 N · 撤回" (5s timeout, click to call `vocab_remove`).
- ≥3 entries in one call → **MID** (inline confirm card listing the batch).

Rationale: confirming every single add is annoying; batches deserve a sanity check.

### 3.5 Library management — MID (inline confirm)

| ID | Description | Wraps |
|---|---|---|
| `sync_to_cloud` | Push local video + analysis to cloud, also iOS sync target | `library_sync_to_cloud` |
| `materialize_from_cloud` | Pull a cloud-only entry to local disk | `library_materialize_from_cloud` |
| `import_video` | Import a new video from a YouTube/Bilibili URL the user provides | `import_video` |

### 3.6 Library management — HIGH (system modal)

| ID | Description | Wraps |
|---|---|---|
| `delete_video` | Delete local video; optional `alsoCloud: boolean` to also unsync | `library_delete` (+ `library_unsync_from_cloud` if alsoCloud) |
| `unsync_from_cloud` | Remove from cloud only; local stays | `library_unsync_from_cloud` |
| `retranscribe_video` | Re-run whisper + LLM analysis. Overwrites existing `analysis.json`. | `retranscribe_video` |

Why `retranscribe` is HIGH (not MID): overwrites existing `analysis.json`, losing any hand-curated key phrases / translations. Player UI's "重新解析" button already uses a system confirm — reuse that copy and dispatch flow.

### 3.7 The `change_whisper_model` and `change_llm_provider` tools

**Not in v1.** Reasoning:

- `change_whisper_model` would trigger a 1-2GB silent model download. Agent shouldn't initiate that without user's deliberate "yes, download" action — and that action is best done in Settings, not via chat.
- `change_llm_provider` is blocked on the vendorKeys-stash bug noted in CLAUDE.md TODO; fixing that is a separate ticket.

Re-add to v1.x once those concerns are addressed.

### 3.8 ToolDef interface (canonical)

```ts
// src/agent/registry.ts
import type { JSONSchemaType } from "ajv";

export type RiskTier = "LOW" | "MID" | "HIGH";

export interface PageContext {
  pathname: string;
  videoId?: string;
  cueIdx?: number | null;
}

export interface ExecuteContext {
  /** AbortSignal for cancellation. Tools that talk to network should honor it. */
  signal: AbortSignal;
  /** Confirmation gate. Tools should NOT call this directly — runtime handles it. */
  // (kept here as type doc, never passed in v1)
}

export interface ToolDef<TArgs = unknown, TResult = unknown> {
  id: string;
  description: string;             // English, agent-facing
  parameters: JSONSchemaType<TArgs>;
  /**
   * Static risk tier. Most tools use this. For tools whose risk depends on
   * args (e.g., vocab_add: 1 entry = LOW, ≥3 entries = MID), provide
   * `getRisk(args)` instead, which is checked first by the gate.
   */
  riskTier: RiskTier;
  getRisk?: (args: TArgs) => RiskTier;
  availableOn: (page: PageContext) => boolean;
  /** Chinese label shown in the ToolCallCard while the call is in flight. */
  runningLabel: string;
  /** Chinese label shown in the folded "done" state. Receives the execute() result. */
  doneLabel: (result: TResult) => string;
  execute: (args: TArgs, ctx: ExecuteContext) => Promise<TResult>;
}

export interface ToolRegistry {
  list(filter?: { page?: PageContext }): ToolDef[];
  get(id: string): ToolDef | undefined;
}
```

### 3.9 Tool description token budget

22 candidate tools × ~60 token descriptions = ~1300 tokens of pure tool-list overhead per LLM request. **Page-filtering** trims that:

| Page | Tools visible | Tokens (approx) |
|---|---|---|
| Library | 17 | ~1020 |
| Player | 21 (all) | ~1260 |
| Vocab | 16 | ~960 |
| Corpus | 16 | ~960 |
| Settings | 16 | ~960 |

Worth-it for a default-on optimization. `availableOn(page)` returns false for `seek_to_time` / `jump_to_cue` / `explain_passage` / `generate_quiz` / `mark_liaisons` when not on a Player page.

Side effect: user asks "explain this passage" while on Library page → LLM doesn't see `explain_passage` → naturally responds "I'd need to open a video first" and calls `open_video` first. Two-turn chain works as intended.

---

## 4. LLM multi-vendor abstraction

### 4.1 Unified event stream

The single contract between runtime and any vendor:

```ts
// src/llm/providers/types.ts (extension)
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call_start"; callId: string; name: string }
  | { type: "tool_call_args"; callId: string; deltaJson: string }
  | { type: "tool_call_end"; callId: string }
  | { type: "stop_reason"; reason: "end_turn" | "tool_use" | "max_tokens" }
  | { type: "error"; message: string };

export interface StreamWithToolsOpts {
  systemPrompt: string;
  history: ChatMessage[];                  // user/assistant/tool array
  tools: ToolDef[];                        // adapter formats per-vendor
  signal: AbortSignal;
}

export interface AgentProvider {
  streamWithTools(opts: StreamWithToolsOpts): AsyncGenerator<AgentEvent>;
}
```

Runtime consumes `AgentEvent` only. Doesn't know if it's talking to DeepSeek, Claude, or Gemini.

### 4.2 Per-vendor adapter notes

**OpenAI-compatible** (DeepSeek, OpenAI, Kimi, Qwen via `openai-compatible` provider):

- Request: `tools: [{type:"function", function:{name, description, parameters: JSONSchema}}]`
- Response: stream chunks contain `delta.content` for text and `delta.tool_calls[].function.{name, arguments}` where `arguments` is a **streaming JSON string** that needs concatenation across deltas.
- Adapter logic: accumulate `arguments` deltas per `tool_calls[i].id` (which itself arrives in the first delta of that index). When `finish_reason === "tool_calls"`, emit `tool_call_end` events for each accumulated call.
- **DeepSeek quirk** flagged in §4.5.

**Claude** (Anthropic):

- Request: `tools: [{name, description, input_schema: JSONSchema}]`
- Response: content blocks streamed via `content_block_start` / `content_block_delta` / `content_block_stop`. `tool_use` block has structured `input` populated incrementally via `input_json_delta`.
- Adapter logic: detect `tool_use` blocks; concatenate `input_json_delta`s; emit unified events on `content_block_stop`.
- Supports **multiple parallel tool_use blocks** in one assistant turn. Runtime executes them sequentially (v1) — concurrency not required for coarse tools and avoids race conditions on shared state.

**Gemini** (Google):

- Request: `tools: [{functionDeclarations: [{name, description, parameters: JSONSchema}]}]`
- Response: `candidates[0].content.parts[].functionCall: {name, args}` — args arrive **atomically** (no streaming for tool args).
- Adapter logic: detect `functionCall` parts; emit `tool_call_start` + single `tool_call_args` + `tool_call_end` events together.
- One `functionCall` per turn (Gemini's current behavior). Multi-call requires multiple ReAct iterations.

### 4.3 JSON Schema source of truth

Each ToolDef carries `parameters: JSONSchemaType<TArgs>`. Adapters translate to vendor format **without modification** to the schema content — names match, structures match. The wrapper differs:

```
                                        ToolDef.parameters: { type: "object", properties: {...} }
                                                            │
                       ┌────────────────────────────────────┼────────────────────────────────────┐
                       ▼                                    ▼                                    ▼
            OpenAI: function.parameters            Claude: input_schema             Gemini: functionDeclarations[].parameters
```

### 4.4 Args validation with ajv

Runtime validates each completed `tool_call`'s args against the registered ToolDef's schema **before** dispatching to `execute()`. Schema fail → synthesize a `tool_result` message with `status: "error"`, message: `"Invalid args: <ajv error path + reason>"`. LLM sees and corrects.

`ajv` weighs ~100KB minified — acceptable add. If already in `package.json` (via `tauri-plugin-store` transitive deps?), confirm at implementation time.

### 4.5 `tool_choice` behavior quirks

Standard: `tool_choice: "auto"` = LLM decides whether to call a tool.

Verified normal: OpenAI, Claude, Gemini.

**DeepSeek (some versions)** reportedly treats `"auto"` as **required**, forcing a tool call even when LLM has nothing useful. Workaround:

- System prompt explicitly says "If no tool is needed, respond in plain text directly."
- Adapter never sends `tool_choice` to DeepSeek by default — let DeepSeek's own default behave naturally.

If DeepSeek still force-calls tools in practice during impl, fall back to: register a synthetic `respond_in_text(message)` tool whose `execute()` is a no-op returning `{ok: true}` — gives DeepSeek a tool to "pick" when it has nothing else.

### 4.6 Cost of vendor abstraction

Three adapters × ~120 lines + unified types ~30 lines + runtime consumption ~80 lines = **~470 LOC** total for the abstraction. Trade-off worth it because:

- Adding a new vendor (Mistral, Qwen variant, etc.) = write one ~120-line adapter.
- Runtime / tools / UI never change when vendors do.
- Each adapter is independently testable with recorded stream fixtures.

---

## 5. Conversation persistence

### 5.1 Storage location

- Windows: `%APPDATA%/whatsub/agent_history.json`
- Mac: `~/Library/Application Support/whatsub/agent_history.json`

Sits alongside `settings.json`, `library.json`, `vocabulary.json`. Same trust boundary, not encrypted.

### 5.2 Write strategy

- **In-memory:** zustand `useAgent` store.
- **Disk persistence:** TS-side debounce 500ms after last change → `invoke("agent_history_save", { history })`.
- **Rust side:** atomic write via `.tmp` + rename (matches `settings.rs`).
- **Load on app start:** `invoke("agent_history_load")` once during App.tsx mount, hydrates the store.

JSON-file integral rewrite (not JSONL append). Typical file <100KB for normal usage. Append complexity not warranted.

### 5.3 Size cap (5 MB hard limit)

Enforced in `agent_history_save_to` (path-injectable helper, before write):

1. Serialize `AgentHistory` to JSON.
2. If size > 5 MB:
   - Sort conversations by `updatedAt` ascending.
   - Pop oldest until total serialized size ≤ 5 MB.
   - Never partial-delete messages within a conversation (would break LLM context).
3. Write the trimmed result.

User-facing: when cap triggers, a one-time toast notifies "AI 助手历史已达上限，已删除最早 N 条会话腾出空间。" Then never again until the next trip-over.

### 5.4 Rust commands

```rust
// src-tauri/src/commands/agent.rs
const AGENT_HISTORY_MAX_BYTES: usize = 5 * 1024 * 1024;
const AGENT_HISTORY_VERSION: u32 = 1;

// Path-injectable helpers (tests use std::env::temp_dir() — CLAUDE.md rule)
fn agent_history_load_from(path: &Path) -> AppResult<AgentHistory> { ... }
fn agent_history_save_to(path: &Path, mut history: AgentHistory) -> AppResult<usize> {
    enforce_size_cap(&mut history)?;          // returns dropped-conversation count
    write_atomic_json(path, &history)?;
    Ok(/* trimmed count */)
}

#[tauri::command]
pub fn agent_history_load() -> AppResult<AgentHistory> {
    let path = paths::agent_history_path()?;
    agent_history_load_from(&path)
}

#[tauri::command]
pub fn agent_history_save(history: AgentHistory) -> AppResult<usize> {
    let path = paths::agent_history_path()?;
    agent_history_save_to(&path, history)
}
```

Per CLAUDE.md "tests must NEVER use `paths::*_path()`" rule: tests target `tempdir().join("agent_history.json")` and call `_to`/`_from` directly. Production commands call `paths::agent_history_path()`.

### 5.5 Schema (TypeScript)

Rust mirrors this with serde (snake_case ↔ camelCase). All `id` fields are `sha256(now_secs || now_nanos)[..10]` strings (no UUID crate added).

```ts
// src/types/agent.ts
export interface AgentHistory {
  version: 1;
  activeConversationId: string | null;
  conversations: Conversation[];
}

export interface Conversation {
  id: string;
  title: string;                       // auto-derived from first user message, ≤30 chars
  createdAt: number;                   // ms epoch
  updatedAt: number;                   // ms epoch
  pageContextAtStart: PageSnapshot;
  /** Cached summary of messages older than the 20-msg sliding window. */
  summaryUpToMsgId: string | null;
  summary: string | null;
  messages: Message[];
}

export interface PageSnapshot {
  pathname: string;                    // "/library" | "/player/<id>" | "/vocab" | "/corpus" | "/settings"
  videoId?: string;
  videoTitle?: string;
  cueIdx?: number;
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface UserMessage {
  role: "user";
  id: string;
  ts: number;
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  id: string;
  ts: number;
  blocks: AssistantBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" | "cancelled";
  usage?: { promptChars: number; responseChars: number; cnyEstimate: number | null };
  vendor: string;                      // "deepseek" | "claude" | "gemini" | ...
  model: string;
}

export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown };

export interface ToolMessage {
  role: "tool";
  id: string;
  ts: number;
  callId: string;                      // matches AssistantBlock.tool_call.callId
  name: string;                        // tool id, denormalized for UI rendering
  status: "ok" | "error" | "cancelled_by_user";
  result?: unknown;
  errorMessage?: string;
  durationMs: number;
  confirmDecision?: "auto" | "inline_yes" | "inline_no" | "modal_yes" | "modal_no" | "panel_closed";
}
```

### 5.6 Multi-conversation UI

Top of panel:

```
┌──────────────────────────────────────────┐
│ ▼ 解释这一段 NHS GP        ⊕ 新对话 ☰  │
└──────────────────────────────────────────┘
```

- `▼` dropdown: list conversations sorted by `updatedAt` desc, each row `{title, "5 分钟前" relative time, ×}`. Click row = switch active. Click × = delete that conversation (no confirm — undoable from Settings? no, deleted is gone; trust user).
- `⊕ 新对话` = create + activate new conversation. Empty conversation deletes itself on panel close if no messages were sent.
- `☰ menu`:
  - 清空当前会话 (just empties messages, keeps the conversation row)
  - 清空所有 AI 历史 (system modal confirm; nukes all conversations)
  - 导出为 JSON (writes raw `agent_history.json` to user-chosen path via `save()` dialog)

Settings page also gets a "清空 AI 助手历史" button as a discoverability backup.

### 5.7 Context window strategy (the real cost control)

LLM-side: history can't grow unbounded. ContextBuilder, before each request, walks the active conversation:

1. **Recent 20 messages** copy verbatim into the request `messages` array.
2. **Earlier messages** (if any): use cached `Conversation.summary` if `summaryUpToMsgId` covers them; otherwise generate a new summary via a separate LLM call ("Summarize the following conversation in ≤200 Chinese chars: user's prefs, key tools called, unresolved threads"). Cache and reuse until ≥10 new messages added.
3. **Tool result truncation**: if `ToolMessage.result` JSON-serialized > 5 KB, send first 5 KB + `"...[truncated, full result in local history]"` to LLM. Local store keeps full result.

This caps any single LLM request body at ~5K input tokens regardless of total conversation length.

### 5.8 Privacy notes

- `agent_history.json` is plaintext, same trust domain as `vocabulary.json`. No encryption (consumer app self-encryption is security theater).
- Tool `args` and `result` **never** contain API keys (keys live in `settings.json`; provider HTTP code injects them at request time, agent never reads them).
- "Export as JSON" gives the user the raw file — no sanitization. User owns their data.

---

## 6. UI components

### 6.1 ChatWidget — the floating button

Specs:

- 56×56 px circular button.
- Position: `fixed; bottom: 20px; right: 20px;`.
- z-index: `50` — above Toast notifications (`z-40`), below ContextMenu/system modal (`z-50+`).
- Always rendered (every page including full-screen video).
- Background: `bg-blue-500/95 backdrop-blur-sm`, hover `bg-blue-400`.
- Icon: 🤖 (lucide-react `Bot` icon, 28px).
- **Red dot** (8×8 absolute top-right) shows if there's an "unread" agent message — fired when an `assistant` message lands while panel was closed.

Click → opens ChatPanel.

### 6.2 ChatPanel — the floating layer

Specs:

- 380×560 px, **fixed size** (not resizable).
- Position: anchored to ChatWidget, expanding **up-and-left**. `bottom: 84px; right: 20px;`.
- Background: `bg-zinc-900/95 backdrop-blur-xl border border-zinc-800 rounded-lg shadow-2xl`.
- Animation: fade-in + slight upward slide (0.2s, ease-out).
- Click outside / press Esc / click ✕ → close.

Layout:

```
┌──────────────────────────────────────┐ Header 40px
│ ▼ <title>     ⊕  ☰  ✕                │
├──────────────────────────────────────┤
│                                      │
│   MessageList (flex-1, scroll-y)     │
│                                      │
├──────────────────────────────────────┤ InputBox 56px
│ ┌──────────────────────────┐  ⊳     │
│ │ 问点什么…                │        │
│ └──────────────────────────┘        │
└──────────────────────────────────────┘
```

### 6.3 MessageBubble — three variants

#### 6.3.1 User

```
                                  ┌──────────────────┐
                                  │ 找几个 medical    │
                                  │ 场景的视频         │
                                  └──────────────────┘
                                  Right-aligned
                                  bg-blue-500/15 border-blue-500/30
                                  text-zinc-200 text-sm rounded-lg p-2.5
```

Markdown disabled — user input is plain text.

#### 6.3.2 Assistant text

```
🤖
   找到 12 个 medical 场景的视频，包含 'NHS GP
   预约'、'言语跟读' 等。你要哪个？

   ▸ 查看详情 (12)        ← ToolCallCard folded
```

Left-aligned. Markdown rendered (bold, italics, lists, code via `<pre>`, inline code via `<code>`). Streaming: tail blinking cursor `▍` while LLM is still generating.

#### 6.3.3 Tool call card — collapsible

4 visual states driven by `ToolMessage.status` + runtime flags:

```
[1] queued (< 100ms before becoming "running" — rarely seen)
┌──────────────────────────────────┐
│ ▸ 准备调用 corpus_browse         │
└──────────────────────────────────┘

[2] running
┌──────────────────────────────────┐
│ ⟳ 正在查询语料库…                │   ← natural-language label per tool
└──────────────────────────────────┘     (not tool id; each ToolDef has a runningLabel)

[3a] done OK — DEFAULT FOLDED
┌──────────────────────────────────┐
│ ✓ 已查询语料库 (12 条)        ▸ │   ← click ▸ to expand
└──────────────────────────────────┘

[3a expanded]
┌──────────────────────────────────────┐
│ ✓ corpus_browse                   ▾ │
│ ─────────────────────────────────── │
│ Args:                                │
│ { tags: ["medical"],                 │
│   scope: "public" }                  │
│ ─────────────────────────────────── │
│ Result:                              │
│ [                                    │
│   { phrase: "NHS GP appointment",    │
│     ...                              │
│   }, ... 11 more                     │
│ ]                                    │
│ 230ms                                │
└──────────────────────────────────────┘

[3b] failed — DEFAULT EXPANDED (errors must be visible)
┌──────────────────────────────────────┐
│ ✗ corpus_browse failed              │
│ Network: timeout after 30s          │
│ [↻ Retry]   [▾ Details]             │
└──────────────────────────────────────┘

[3c] cancelled by user
┌──────────────────────────────────┐
│ ⊘ 已取消                         │
└──────────────────────────────────┘
```

Each ToolDef carries presentation metadata in addition to the LLM-facing description:

```ts
interface ToolDef {
  // ... existing
  runningLabel: string;            // "正在查询语料库…"
  doneLabel: (result: unknown) => string;  // "已查询语料库 (12 条)"
}
```

### 6.4 InlineConfirmCard — MID-risk gate inside the chat thread

```
🤖
   要把这 3 个生词加到你的生词本吗？

   ┌──────────────────────────────────────┐
   │ ⚠ 请确认                              │
   │ ─────────────────────────────────── │
   │ • NHS GP appointment                 │
   │ • symptoms vocabulary                │
   │ • appointment booking                │
   │ ─────────────────────────────────── │
   │            [取消]  [确认添加]         │
   └──────────────────────────────────────┘
   bg-amber-500/10 border-amber-500/40 rounded-lg p-3
```

State: card stays in `awaiting_confirmation` indefinitely **while panel is open** (no timeout, per locked decision).

**Closing the panel cancels the card.** This is the locked "panel close = interrupt" reconciliation — chosen over the earlier brainstorming sketch of a "right-bottom Toast asking you to come back". Rationale: with no timeout, a Toast-driven persistent card creates an "agent waiting on you" state that the user must remember to dismiss. Hybrid model is cleaner — close = explicit user disengagement; card resolves as `cancelled_by_user` with `confirmDecision: "panel_closed"`.

Side effect: if the runtime had already started a HIGH-tier system modal before the panel close, the modal is owned by `ConfirmDialog` and stays up; the panel close only affects in-panel state.

### 6.5 SystemConfirmDialog — HIGH-risk

**Reuse the existing `src/components/ConfirmDialog.tsx`.** Same component that backs SyncButton confirm, delete-video flow, etc.

Tool's execute() calls:

```ts
const confirmed = await openSystemConfirm({
  title: "AI 助手要删除这个视频",
  message: `"${videoTitle}"\n\n会从本地永久删除。${alsoCloud ? "云端同步也会一起取消。" : ""}`,
  confirmLabel: "删除",
  cancelLabel: "取消",
  danger: true,
});
if (!confirmed) throw new Error("cancelled_by_user");
```

Throws on cancel → caught by runtime → ToolMessage(status="cancelled_by_user").

### 6.6 InputBox

```
┌──────────────────────────────────────┐
│ ┌──────────────────────────┐   ⊳    │
│ │ 问点什么…                 │   send │
│ └──────────────────────────┘   btn   │
└──────────────────────────────────────┘
- Textarea, auto-resize 1-4 rows, max-h-24
- Enter = send · Shift+Enter = newline
- Send button: enabled when textarea non-empty AND no in-flight stream
- During streaming: send button replaced by ⏹ stop button (calls AbortController)
- placeholder copy varies: "问点什么…" idle, "agent 正在思考…" streaming, "AI 助手未配置 LLM" no-vendor
```

### 6.7 No-vendor state (no LLM configured)

ChatPanel still opens, but MessageList shows:

```
🤖

  AI 助手需要先配置 LLM。
  支持 DeepSeek / Claude / Gemini / OpenAI 等。

  [打开设置]
```

InputBox is disabled with placeholder "请先配置 LLM 后再使用".

### 6.8 Empty state (no conversations yet)

First-time user opens panel:

```
🤖

  AI 助手能帮你：
  • 查公共语料库找视频
  • 加生词本 / 同步到云
  • 在视频里解释一段 / 出题 / 标连读
  • ……更多见 ☰ 帮助

  ▶ 试试: "找几个 medical 场景的视频"
  ▶ 试试: "把这一段加生词本"
```

The `▶ 试试` lines are clickable — fill the InputBox with that text.

### 6.9 Single agent turn — state machine

```
[user presses Enter]
  ▼
runtime.runTurn(userMessage)
  ▼
state = streaming
  ▼
provider.streamWithTools() yields events:
  - "text" → append to current AssistantMessage.blocks (textual)
  - "tool_call_start/args/end" → finalize one tool_call → enqueue
  ▼
On "stop_reason"="tool_use":
  for each enqueued tool_call:
    gate = ConfirmationGate.classify(toolDef, toolCall.args)   // dispatches getRisk(args) if defined, else static riskTier
    ├─ LOW  → execute() immediately
    │        ToolMessage(ok/error) appended
    ├─ MID  → render InlineConfirmCard, await user click
    │        ├─ confirm   → execute() → ToolMessage
    │        ├─ cancel    → ToolMessage(cancelled_by_user, confirmDecision="inline_no")
    │        └─ panel ✕   → ToolMessage(cancelled_by_user, confirmDecision="panel_closed")
    └─ HIGH → openSystemConfirm()
             ├─ confirm → execute() → ToolMessage
             └─ cancel  → ToolMessage(cancelled_by_user)
  ▼
Check ReAct cap: if (this turn's tool_call count >= 5) → finalize turn,
  inject system note "已达本轮工具调用上限 (5)，请用户补充信息后继续。"
  Break loop.
  ▼
Loop back: re-invoke provider.streamWithTools() with the ToolMessages
  appended to history.
  ▼
On "stop_reason"="end_turn" or "max_tokens" or error:
  finalize turn, state = idle.
```

---

## 7. System prompt and context

### 7.1 Static identity block (constant every turn)

```
你是 whatsub Agent —— whatsub 桌面 app 的内置 AI 助手。
默认用中文回答；用户明确要求英文，或讨论英文细节时（如发音、用法）才用英文。

⟨能力边界⟩
你可以：导航、查公共语料、管理库与生词本、触发视频内 AI 动作（解释/出题/连读）。
你不能：导出文件、改 LLM 配置、动登录与许可证、上网、直接改字幕文本。
碰到能力外的请求，告诉用户该去 app 哪个地方手动操作。

⟨行为约束⟩
1. 简洁。两句能说清就别说五句。
2. 用户表达模糊时，先调 list_library / corpus_browse / list_vocab 查实际状态，再回答。
   别基于自己的猜想说"你库里应该有 X"。
3. 工具有风险等级：
   • LOW (查、跳转、解释)：直接调，无需确认。
   • MID (加/删/同步)：app 会弹"内联确认卡"，调用前在文本里**一句话**说明你要做什么，
     让用户知道在确认什么。卡片本身的取消/确认按钮 app 自己渲染，你不要再问"要继续吗？"
   • HIGH (删本地视频、取消云同步、重新解析视频)：app 会弹系统模态对话框。同上，调用前一句话说明。
4. 工具失败时读错误信息再决定：重试 / 换参数 / 改问用户。绝不盲目用同样参数重试。
5. 用户请求不需要任何工具（如"这个英语短语什么意思"、"解释一下连读"），直接回答即可。
6. 一次响应里串调到 3 个工具还没收敛就停下来问用户，别无脑链式调用。
7. 如果不需要工具，直接回答用户，不要硬塞一个工具调用进去。
```

(Behavior constraint #6 says "3" but the runtime caps at 5; the prompt nudge is intentionally lower to encourage early-stop.)

### 7.2 Dynamic context block (rebuilt every turn)

Output of `ContextBuilder.render(snapshot, libSummary, vocabSummary)`:

```
⟨当前上下文⟩
位置: /player/abc123
当前视频: "NHS GP 预约对话" (15:43 总时长，已观看 42%)
字幕游标: 第 47 句 ("So you've been having these symptoms for...")
最近视频内动作: 用户 3 分钟前对第 23 句调了 explain_passage
库内: 156 个视频 (medical 23 · job 18 · dining 12 · 其他 103，已云同步 12)
生词本: 89 条 (最近 5 条：appointment, symptoms, GP, prescription, referral)
当前 LLM: deepseek-chat (用户 BYOK)
```

Why text not JSON: LLMs concentrate ~30% better on natural-language summaries than structured objects (empirical).

### 7.3 Per-turn snapshot composition

```ts
// src/agent/context.ts
export interface ContextSnapshot {
  page: PageSnapshot;
  library: { total: number; bySceneTop3: Array<[string, number]>; otherCount: number; syncedCount: number };
  vocab: { total: number; recentTop5: string[] };
  llm: { vendor: string; model: string };
  recentAgentActivity: Array<{ tool: string; minutesAgo: number; cueIdx?: number }>;
}

export function snapshot(): ContextSnapshot {
  const pathname = window.location.pathname;
  const settings = useSettings.getState().settings;
  const library = useLibrary.getState().library;
  const vocab = useVocabulary.getState().entries;
  // ...
}

export function render(s: ContextSnapshot): string {
  // Template string with optional sections
  // (if Player page, include cueIdx/videoTitle; if Library, skip)
}
```

### 7.4 The Player-state bridge (new requirement)

Player.tsx's `currentIdx` comes from `useVideoSync(videoRef, subtitles)` — a hook local to the component. The agent needs to read it from the outside.

**New module**: `src/store/playerState.ts`:

```ts
import { create } from "zustand";

interface PlayerStateStore {
  videoId: string | null;
  currentIdx: number | null;          // -1 sentinel → null for clarity
  currentTime: number | null;
  videoTitle: string | null;
  setActive(args: { videoId: string; videoTitle: string }): void;
  setCue(args: { currentIdx: number | null; currentTime: number | null }): void;
  clear(): void;
}

export const usePlayerState = create<PlayerStateStore>((set) => ({
  videoId: null, currentIdx: null, currentTime: null, videoTitle: null,
  setActive: (args) => set({ videoId: args.videoId, videoTitle: args.videoTitle }),
  setCue: (args) => set({ currentIdx: args.currentIdx, currentTime: args.currentTime }),
  clear: () => set({ videoId: null, currentIdx: null, currentTime: null, videoTitle: null }),
}));
```

Player.tsx integration (minimal):

- On mount with valid videoId: `setActive({ videoId, videoTitle })`.
- On `currentIdx` change: `setCue({ currentIdx: currentIdx >= 0 ? currentIdx : null, currentTime: videoRef.current?.currentTime ?? null })` — throttled to 500ms to avoid zustand thrash.
- On unmount: `clear()`.

ContextBuilder reads via `usePlayerState.getState()`.

### 7.5 Token budget

| Segment | Approx tokens |
|---|---|
| Static identity block | ~400 |
| Dynamic context block | ~150-300 (varies with library size) |
| Tools list (page-filtered, ~15-21 tools) | ~900-1260 |
| Recent 20 history messages | ~1500-3000 |
| Earlier-history summary (cached) | ~200 |
| **Sum (system + history)** | **~3150-5160** |
| User's current message | ~50-200 |

Per-turn input tokens ≈ **3.5-5.5K**. Output ≈ 200-1000.

At DeepSeek pricing (¥0.002/1k input, ¥0.008/1k output): **~¥0.01-0.02 per turn**. 100 turns/day ≈ ¥1-2.

### 7.6 Edge cases

- **First message of new conversation:** `pageContextAtStart` is captured at conversation creation (frozen). The dynamic context block uses the **current** pathname (which may have changed). LLM sees both: "you started in /library, now you're on /player/xyz". Natural.
- **Empty data states:** Library empty → "库内: 0 个视频 (空)". Don't omit fields — silence is ambiguous; "0" is explicit.
- **Cross-vendor switch mid-conversation:** New vendor's adapter formats the **same** ToolDef list. System prompt static block is vendor-agnostic. Risk: old assistant messages' `vendor`/`model` no longer match the in-flight provider — runtime ignores and uses the current provider. Known limitation in §11.

---

## 8. Error handling

10 categories, each with explicit recovery path. Core principle: **errors the LLM can handle → feed back to LLM**. Errors the LLM cannot handle → surface to user.

### 8.1 Tool execution failure (most common)

Rust command returns `Err`, or TS execute throws.

```
runtime catches → ToolMessage(status="error", errorMessage="<raw>")
  → appended to history → fed back as tool result
  → LLM sees error and decides next step
```

**Error message passed verbatim**, not translated. LLMs handle English Rust errors well; they also handle structured error tags (`quota_exceeded`, `video_too_long {duration: 2400, limit: 1200}`) intelligently — extracting numbers, mapping to user-facing copy.

Tools with their own internal retry (yt-dlp's GFW retry, agent_history_save's atomic write) don't get an outer retry wrapper.

### 8.2 Unknown tool name

```
event.type === "tool_call_end" with name not in registry
  → DO NOT execute
  → ToolMessage(status="error", errorMessage="Unknown tool: <name>. Available tools listed in system prompt.")
  → LLM corrects on next iteration
```

Counts as 1 step against the ReAct 5-cap.

### 8.3 Malformed tool args

ajv validation fails:

```
ToolMessage(status="error", errorMessage="Invalid args for <name>: <ajv path>: <reason>")
  → LLM retries with corrected args
```

### 8.4 LLM stream mid-interrupt (network / timeout)

```
fetch reader.read() throws (non-AbortError)
  → AssistantMessage stopReason = "error"
  → Last bubble appended "⚠ 连接中断 [重试]"
  → Click [重试] = re-run runTurn with current history (NOT auto-retry)
```

**Exception**: vendor returns 429 (rate limit) → auto-backoff retry 1 time (sleep 2-10s based on `Retry-After` header). If still fails, surface as above.

### 8.5 Vendor auth failure (401/403)

Cannot recover programmatically. Surface to user:

```
🤖
   ⚠ DeepSeek 返回 401 鉴权失败
   你的 API key 可能失效或余额耗尽。
   [打开设置] [关闭]
```

`[打开设置]` → `navigate("/settings")` + close panel.

### 8.6 User stop (Stop button / panel close)

```
runtime.abort(reason: "user_stop" | "panel_closed")
  → AbortController.abort()
  → fetch reader throws AbortError → swallow
  → in-flight tools: their .execute()'s AbortSignal fires
    - Network-aware tools (LLM-calling sub-tools, sync_to_cloud) abort cleanly
    - Rust commands already started (file ops mid-flight) complete; result discarded
  → AssistantMessage stopReason = "cancelled"
  → Append "已停止当前响应（之前的操作可能仍在后台完成）" hint
```

### 8.7 Single-tool timeout

`Promise.race([execute(args), timeoutAt(60s)])`:

```
ToolMessage(status="error", errorMessage="Tool <name> timed out after 60s")
  → LLM sees and decides
```

Special-cased "long-running" tools (`retranscribe_video`, `import_video`): execute() returns immediately with `{started: true, watchAt: "/library"}` — fire-and-watch pattern. Progress lives in Library's existing background-task widget. Tool args validated → enqueue → return; the long work happens out-of-band. LLM tells user "已启动重新解析，进度看 Library"

### 8.8 Semantic errors

LLM gives schema-valid args that don't match reality ("delete video xyz" but xyz doesn't exist) → tool internal validation throws → Path 8.1.

### 8.9 Unserializable tool result

`safeSerialize(result)`:

```ts
function safeSerialize(v: unknown): unknown {
  try {
    JSON.parse(JSON.stringify(v));
    return v;
  } catch {
    return String(v);  // fallback to coerced string
  }
}
```

Never throws back to runtime. LLM always sees something.

### 8.10 Vendor returns malformed response

(e.g. invalid SSE chunk, JSON parse failure in adapter)

Adapter throws → runtime treats as Path 8.4 (mid-stream interrupt).

---

## 9. Testing strategy

### 9.1 Vitest unit tests (CI on every PR)

**Per tool** (`src/agent/tools/<id>.test.ts`):

- Valid args → execute succeeds → returns expected shape
- Invalid args → schema validation fails (ajv path)
- Mocked `invoke` returns error → execute propagates error
- `availableOn(page)` returns expected boolean for each test page

**ContextBuilder** (`src/agent/context.test.ts`):

- Snapshot composition with mocked stores
- Render output stable across re-renders (no random ordering)
- Empty-data states render "0 (空)" not blanks

**ConfirmationGate** (`src/agent/gate.test.ts`):

- `classify(toolName)` returns correct tier for every registered tool
- `vocab_add` with `entries.length === 1` returns "LOW" (special-case)
- `vocab_add` with `entries.length >= 3` returns "MID"

**Vendor adapters** (`src/llm/providers/<vendor>.test.ts`):

- `formatTools(toolDefs)` produces correct vendor-specific JSON
- `parseStream(fixtureStream)` emits expected AgentEvent sequence
- Error: vendor-specific malformed chunk → adapter throws / yields error event

**Runtime ReAct loop** (`src/agent/runtime.test.ts`):

- Single-turn: text-only response → AssistantMessage with one text block, stopReason=end_turn
- Single-tool turn: 1 tool_call → execute → result → LLM continues with text → end_turn
- Multi-tool chain: 3 tool_calls in one stream → execute sequentially → loop
- Chain cap: forced 5 tool_calls → 5th executes, then turn finalizes with cap message
- Cancellation: signal.abort() mid-stream → stopReason=cancelled

**History store** (`src/store/agent.test.ts`):

- createConversation → setActive → addMessage → switchConversation → previous still intact
- clearAll → empty
- Title auto-derivation from first user message
- Conversation auto-delete on panel close if no messages sent

### 9.2 Vitest integration tests

End-to-end with recorded vendor stream fixtures:

```
src/agent/__fixtures__/
├── deepseek_simple_text.txt          (recorded one-shot text response)
├── deepseek_one_tool_call.txt        (text → tool_call → text)
├── deepseek_three_tool_chain.txt
├── claude_multi_tool_block.txt
├── gemini_function_call.txt
└── deepseek_rate_limit_429.txt       (error scenario)
```

Test feeds fixture as stream, asserts AssistantMessage shape + tool call execution sequence.

### 9.3 Rust tests (`cargo test`)

- `agent_history_save_to` / `_load_from` round-trip with `tempdir()`
- Size cap: pre-fill 6MB → save → assert oldest conversation dropped + returned count
- Corrupt JSON: write invalid → load_from → returns empty AgentHistory (tolerant)
- Concurrent save (simulate two debounced writes 50ms apart): no corruption (atomic rename)

Per CLAUDE.md rule: tests **must not** call `paths::agent_history_path()`. Use tempdir explicitly.

### 9.4 Manual pre-release checklist

Before any agent feature ships, manually run through these in dev build:

```
□ Open ChatWidget on Library page · panel opens 380×560 right-bottom
□ Send "你好" → LLM responds in Chinese (system prompt working)
□ Send "查我库里 medical 视频" → list_library called → text result
□ Send "把第二个加生词本" → vocab_add MID confirm card → confirm → toast
□ Send 3 vocab adds in one prompt → batch inline confirm
□ Send "删掉这个视频" → delete_video HIGH system modal → cancel → cancelled_by_user
□ On Player page send "解释这一段" → explain_passage tool fires (LOW) → streaming text
□ On Player page send "出 5 道题" → generate_quiz → JSONL response
□ Open Library page send "解释这一段" → LLM says "需要先打开视频" → open_video next turn
□ Force chain >= 5: ask agent to enumerate 6 things → 5th tool fires + cap message
□ Mid-stream press Stop → message marked cancelled · partial text preserved
□ Disconnect network mid-stream → stream interrupts → [Retry] button works
□ Close panel mid-MID-confirm → reopen → card shows ⊘ 已取消 (panel_closed)
□ Close panel mid-stream → stream aborts → reopen shows cancelled · partial text preserved
□ Create new conversation, send 1 message, close panel without sending more → conversation persists
□ Create new conversation, close panel without sending → auto-deleted
□ Switch conversation in ▼ dropdown → message list swaps
□ ☰ Export JSON → file saved · open in editor, schema looks like §5.5
□ ☰ Clear all → system modal confirm → history wiped · next conversation is new
□ Toggle LLM provider with no key set → panel opens but shows "未配置 LLM" state
□ Open panel on every page (Library, Player, Vocab, Corpus, Settings) — tools filter correctly
```

---

## 10. Code reuse from `feat/tutor-mvp`

Parked branch `feat/tutor-mvp` (HEAD `34f60aa`) is not merged but its content is salvageable. Net imports during agent implementation:

| Source file (on tutor-mvp) | Target on feat/ai-agent | Notes |
|---|---|---|
| `src/llm/tutorPrompts.ts::buildExplainPrompt` | `src/agent/tools/explain_passage.ts` (prompt body) | Verbatim copy — already takes a `TutorContext`-like shape |
| `src/llm/tutorPrompts.ts::buildQuizPrompt` | `src/agent/tools/generate_quiz.ts` | Verbatim |
| `src/llm/tutorPrompts.ts::buildLiaisonPrompt` | `src/agent/tools/mark_liaisons.ts` | Verbatim, plus the cueIdx threading |
| `src/llm/tutorPricing.ts` whole file | `src/agent/cost.ts` | Move + rename; identical contents |
| `src/llm/tutor.ts::rangeHash` / `cacheKey` | `src/agent/cache.ts` | If the agent grows a per-conversation tool-result cache later. v1 may not need. |
| `src-tauri/src/commands/analysis.rs::tutor_cache_*` | Keep as-is or rename | If reused for tool-result caching. v1 unlikely to need. |
| `tutor.log.jsonl` schema concepts | `agent_history.json` (already designed differently) | Schema redesigned in §5.5; no direct reuse |

Salvage procedure: per-file `git checkout feat/tutor-mvp -- <path>` after creating `feat/ai-agent` from current main. Adjust imports + tests as needed.

Total LOC salvageable: ~600 (prompts ~250 + pricing ~50 + helpers ~50 + tests for above ~250).

---

## 11. Known limitations (write into release notes)

1. **Panel close discards in-flight tool results.** Rust commands continue executing (e.g., a `library_sync_to_cloud` PUT in progress), but the result never returns to the LLM. App state still mutates; chat history doesn't reflect it. Workaround: refresh Library to see actual state. (§7 J.1, §8.6)
2. **System modal blocks app.** During HIGH-risk confirm, all other app interaction is blocked. This is by-design of existing ConfirmDialog; reused as-is. (§6.5)
3. **ReAct hard-capped at 5 tools per turn.** Beyond 5, runtime injects a "limit reached" message and finalizes. (§6.9, §2.4)
4. **Tool args not streamed.** Full args buffer accumulated before validation/execute — adds latency on Claude content blocks. Acceptable for coarse tools where args are typically <1KB. (§4.1)
5. **Long-running tools are fire-and-watch.** `retranscribe_video` / `import_video` return "started, watch Library". The LLM cannot directly observe completion. (§8.7)
6. **Vendor switch mid-conversation can desync.** Old assistant messages were generated against one vendor's view of tools; if user switches LLM mid-thread, the new vendor sees a list it didn't co-author. Workaround: new conversation. (§7.6)
7. **5 MB hard cap deletes oldest entire conversations.** Mid-conversation truncation is avoided (would break LLM context) — instead the oldest conversations are popped wholesale. (§5.3)
8. **No cost transparency UI.** Per locked decision, the InputBox doesn't accumulate ¥ per turn. Users see their LLM spend via their vendor's dashboard.
9. **InlineConfirmCard has no timeout while panel is open.** Closing the panel cancels any awaiting cards with `confirmDecision: "panel_closed"`. No background Toast nudge — close means user disengaged. (§6.4)
10. **Settings-level tools deliberately omitted.** `change_whisper_model` and `change_llm_provider` excluded; users adjust those via Settings UI.

---

## 12. Future evolution

Each phase ships independently as its own spec → plan → branch.

### v1.1 — Profile

Cross-session memory injected into system prompt's identity block. Datasource: aggregation over `agent_history.json` + (if Tutor-MVP content is ever merged) `tutor.log.jsonl`.

- User preferences: "用户偏好看 medical 场景", "用户用 DeepSeek"
- Learning weaknesses: "phrasal verbs 弱", "连读不熟"
- Style preferences: "用户喜欢长回答 / 短回答"

Implementation sketch: nightly background LLM call computes a `profile.json` summary; loaded once per conversation start and injected before §7.2 dynamic block.

### v1.2 — Curator

Proactive agent triggers. Fires automatically on app events:

- App launch → "你昨晚在 NHS GP 看到 60%，要不要继续？"
- Video finished → "刚那条 referral 是新词，要加生词本吗？"
- Recent activity skewed → "最近 5 条生词都是 medical，换个 dining 场景练练？"

UI: ChatWidget red-dot + auto-open panel on first user interaction; the panel's first message is the proactive offer.

### v1.3 — Plan-then-execute

For complex multi-step requests:

- User: "整理我所有 medical 视频按学习进度排，未读完的放右下"
- LLM emits a structured plan: 5 steps with names, args, expected effects.
- User reviews + approves the whole plan as a system modal.
- Runtime executes sequentially with progress UI.
- Useful when 5-tool ReAct cap is hit too often.

### v1.4 — Voice

whatsub is an English learning app — voice IO is a natural fit.

- Voice input: hold-to-talk on the panel, Whisper transcribes locally
- Voice output: piped through Azure TTS (already used for character voice setup) — optional toggle

Lower priority than v1.1/v1.2 because it doesn't expand capabilities, just changes input mode.

---

## Appendix A — Adding a new tool (5-step procedure)

```
Step 1: Declare the ToolDef in src/agent/tools/<id>.ts
        export const myTool: ToolDef<{...}, {...}> = {
          id: "my_tool",
          description: "...",
          parameters: { type: "object", properties: {...}, required: [...] } as const,
          riskTier: "LOW" | "MID" | "HIGH",
          runningLabel: "正在 ...",
          doneLabel: (result) => `已 ... (${result.count})`,
          availableOn: (page) => page.pathname.startsWith("/..."),
          execute: async (args, ctx) => { ... },
        };

Step 2: Register in src/agent/registry.ts
        import { myTool } from "./tools/my_tool";
        export const TOOLS: ToolDef[] = [...existing, myTool];

Step 3: If a new Rust command is needed, follow settings.rs pattern:
        - path-injectable helper (test with tempdir)
        - #[tauri::command] wrapper
        - register in src-tauri/src/lib.rs::invoke_handler

Step 4: Tests
        - src/agent/tools/my_tool.test.ts: valid args, invalid args (schema), execute success, execute failure
        - If Rust new: cargo test for the helper

Step 5: Manual verification (pnpm tauri dev)
        - Open chat panel on the page where availableOn returns true
        - Prompt agent to use the tool (or use a debug "force tool" mode if added)
        - Verify args, execute, confirmation UI per riskTier
```

---

## Appendix B — Glossary

| Term | Definition |
|---|---|
| Agent | The LLM driven by user chat. Calls tools, reads results, continues. |
| Tool | A typed action with JSON Schema params. Maps to a Tauri invoke OR a pure-TS action. |
| Tool definition (ToolDef) | The TS object declaring a tool's id, params, riskTier, execute. |
| Tool call | One invocation of a tool by the LLM in a single agent turn. |
| Tool result | The return value of execute(), serialized and fed back to the LLM. |
| Agent turn | One user message + the resulting LLM stream + any tool calls + final assistant message. Ends on stop_reason=end_turn or max_tokens or error or user stop. |
| ReAct | The interleaved "think (LLM text) → act (tool call) → observe (tool result) → repeat" loop. |
| Conversation | A thread of messages persisted as a single entry in agent_history.json. |
| Risk tier | LOW / MID / HIGH classification controlling confirmation UI. |
| Confirmation gate | The runtime component that, given a tool call, decides which confirmation UI (if any) to show. |
| ContextBuilder | The runtime component that produces the dynamic system prompt block from app state. |
| Vendor adapter | The provider-specific layer that translates between vendor protocol and unified AgentEvent. |
| Page context | A small snapshot {pathname, videoId?, cueIdx?} used by tool `availableOn` filters and ContextBuilder. |

---

*Spec end. Implementation planning next: invoke superpowers:writing-plans to expand into bite-sized tasks.*
