# Get Video Client — Architecture

Tauri 2 desktop app for English subtitle learning. Pipeline: import (yt-dlp / local) → ffmpeg audio extract → whisper.cpp transcribe → user-configured LLM (DeepSeek / Claude / Gemini / etc.) for Chinese translation + key-phrase highlighting → bilingual player.

**Companion repo:** [`rjxznb/whatsub-license`](https://github.com/rjxznb/whatsub-license) (private) — Hono + node-postgres on the existing Eversay Aliyun ECS at `https://whatsub.eversay.cc`. Desktop POSTs once to `/api/license/activate`, then runs fully offline. Migrated 2026-05-09 from Cloudflare Workers + D1 (mainland latency 5–10s → <200ms).

**See also:**
- [`CLAUDE-PITFALLS.md`](./CLAUDE-PITFALLS.md) — bugs we've already paid for; consult before changing UI/drag/sidecar/release code.
- [`CLAUDE-FEATURES.md`](./CLAUDE-FEATURES.md) — implementation detail on Library folders, caption styling, scrubber preview, Materialize, Delete cascade, Corpus field shapes, and the Release workflow.

## Stack

Tauri 2 · React 19 + TS + Vite · Tailwind v3 · zustand · React Router v6 · lucide-react · framer-motion (Library reorder FLIP) · @fontsource/charis-sil · Vitest. Sidecars: `yt-dlp`, `ffmpeg`, `whisper-cli`, `node`. LLM HTTP is hand-rolled SSE per provider (no vendor SDKs). License + trial + corpus HTTP runs in Rust via `reqwest` (NOT WebView fetch — see [`CLAUDE-PITFALLS.md`](./CLAUDE-PITFALLS.md#network)). Tag-chip browse cache uses `tauri-plugin-store` (LazyStore). Bridge module (`bridge/`) was deleted 2026-05-18 — plugin + desktop now both talk to `whatsub-license` directly; no localhost peer-to-peer sync.

## Layout

```
client/
├── src-tauri/                     # Rust backend (commands, pipeline, core)
│   ├── binaries/                  # bundled sidecars + companion DLLs/dylibs
│   ├── tauri.conf.json            # Win-shaped base
│   ├── tauri.macos.conf.json      # Mac overlay (frameworks list)
│   └── capabilities/default.json  # scoped shell:execute per sidecar
├── src/                           # React frontend
└── public/data/ipa-en-us.json     # 3 MB offline IPA dict (125k entries)
```

Sidecar resolution is by **basename only** (`sidecar("yt-dlp")`, NOT `"binaries/yt-dlp"` — Tauri strips the prefix). Tauri renames externalBin entries to `<name>-<target_triple>{.exe}` at build time, so runtime resolution has to try both bare + triple-suffixed names.

## Storage layout

`%APPDATA%/whatsub/` (Win) / `~/Library/Application Support/whatsub/` (Mac):

```
settings.json · library.json · vocabulary.json · license.json · trial.json
auth.json                          # 30-day session bearer from auth_from_license
agent_history.json                 # AI Agent conversations (5 MB cap, see "AI Agent")
yt-cookies-jar.json                # per-site cookies jar populated via CDP (Edge/Chrome login)
sites-browser/                     # isolated Edge/Chrome profile dir for cookie login flow
sites-browser-port                 # last-known CDP debug port (so repeat logins skip respawn)
bin/yt-dlp{.exe}                   # user-updated yt-dlp via Settings → 更新 yt-dlp. Pipeline
                                     # prefers this over the bundled sidecar — see "yt-dlp
                                     # resolution order" below.
models/ggml-<size>.bin             # settings.modelsDir overrides for new downloads only
library/<video_id>/
  source.mp4 · audio.wav · transcript.srt · thumb.jpg · analysis.json · info.json
```

`videoDir` per library entry is **frozen at import time** — changing `settings.libraryDir` doesn't orphan old entries. `library_freeze_paths` patches legacy entries before any libraryDir change. `assetProtocol.scope` covers `$DATA/whatsub/**` + `$LOCALDATA/whatsub/**` + `**/*.{mp4,jpg,...}` so custom paths still load.

`library.json` schema (since 2026-05-20): `{ videos: LibraryEntry[], folders: LibraryFolder[], topLevelOrder: LibraryItemRef[] }`. Legacy `{ videos: [...] }` auto-upgrades on first read (Rust `read_index` synthesises `topLevelOrder` from `videos` when missing). Folders are virtual — no filesystem analog; `folder.videoIds` references entries by id. See Library folders detail in [`CLAUDE-FEATURES.md`](./CLAUDE-FEATURES.md#library-folders--drag-to-merge).

`settings.json` caption-style fields (2026-05-20): `captionFontColor` / `captionFontScale` / `captionFontOpacity` / `captionBackgroundColor` / `captionBackgroundOpacity` / `captionHighlightsEnabled`. All optional, defaults applied via `mergeWithDefaults`. Caption box X/Y offset (drag-to-move) is deliberately NOT persisted — every Player remount starts at (0,0).

## Pipeline event stream

`emit("pipeline-event", PipelineEvent)`. Variants in `core/progress.rs`. Per-import sequence:

```
Started → Preparing{step}* → Downloading{percent}* → ExtractingAudio
        → Transcribing{percent}* → BackendDetected (once) → Transcribed
        (Failed at any step)
```

`Preparing{step}` fires once per detected yt-dlp stderr phase transition, mapping a stable `step` ID to a Chinese UI label (`fetching-webpage` → 获取视频信息, `fetching-player` → 获取播放器, `solving-signature` → 解算签名 (常是最慢的一步), `fetching-manifest` → 获取清晰度列表, `format-selected` → 格式已选). Each step also gets a redundant `Log` entry "准备中 → <label>". Detection in `pipeline/ytdlp.rs::detect_prepare_step` — pattern-matches on `[youtube]` / `[info]` lines.

Side streams: `ModelDownload` (model fetch), `Uploading{video_id,percent}` (OSS transcode + upload), `Exporting → Exported` (burn-in), `Log` (raw stderr passthrough plus `[whatsub] ...` lifecycle markers).

## Key architecture decisions

- **Rust does subprocess + filesystem; TS does HTTP/LLM.** TS gets browser fetch + Web Streams; Tauri's externalBin handles binary distribution.
- **JSON Lines streaming for LLM output.** Each cue arrives as one line → UI streams cue-by-cue. Two-phase analysis: phase 1 = per-batch cues; phase 2 = single global summary across ALL cues.
- **Cancellation = AbortController.** Stop button aborts → phase=paused → partial save persists. Continue resumes from `subtitles.length` with `previouslyAnalyzed` so the summary phase still sees the full transcript.
- **Vendor preset layer over protocol.** 3 internal protocols (`openai-compatible` / `claude` / `gemini`) cover wire format; 10 user-facing vendors combine protocol + preset baseUrl + suggested models. `inferVendorId()` reverse-maps legacy settings.
- **Offline IPA dict (3 MB, 125k entries).** Render-time only — never stored in `analysis.json`, so old analyses gain IPA without re-running the LLM.
- **License gate is one-time, online only at activation; pure offline forever after.** No periodic verification, no JWT — just a presence check on `license.json`. Trade-offs: refunds not supported (sold as 数字商品), cracking the local file is trivial. Protection is the one-time `/activate` call enforcing the 3-device limit per key. Fingerprint = `sha256(machine_uid || ":whatsub:v1")`. `ACTIVATE_ENDPOINT` is hard-coded into the binary.
- **24h trial mode (TRIAL_ACTIVE).** First launch with no license: POST `/api/license/trial/start` returns `expiresAt` (server-authoritative — same fingerprint always gets the SAME expiresAt, so wiping `trial.json` doesn't farm new trials). App fully usable but `TrialBanner` countdown at top.
- **License + trial HTTP runs in Rust, NOT WebView fetch.** Both endpoints (`license_activate_http` / `license_trial_start_http` in `commands/license.rs`) wrap `reqwest::Client::builder().timeout(30s)`, bypassing WebView2's network stack quirks. On error, Rust returns prefixed strings (`timeout:` / `connect:` / `tls:` / `http <N>:`) which `store/license.ts::friendlyNetworkMessage()` maps to actionable Chinese copy.

## License-key → session auto-login

Desktop never asks for an email/OTP. `LicenseSessionGate` (mounted once at app root) fires-and-forgets `useAuth.authFromLicense(licenseKey)` on mount — Rust command `auth_from_license` POSTs `/api/auth/from-license` with the activated license key, gets back a 30-day sessionToken, persists to `app_data_dir/auth.json`. Subsequent corpus calls (`corpus_browse` / `corpus_mine` / `corpus_tags` / `corpus_phrase_detail` / `corpus_versions`) attach the bearer.

`LicenseSessionGate` is **non-blocking by design** — if the server call fails or the user is offline, the app still renders normally. Only the `/corpus` page reads `useAuth.status` and shows a 「登录后可用」 inline UI when the session isn't ready.

### Identity is decoupled from the unlock mode (in-app account login, 2026-06-25)

The cloud **identity** (a session = one email) is now separable from the app **unlock mode** (`ACTIVE` license / `SUB_ACTIVE` / `TRIAL_ACTIVE`). Three ways to get a session, all minting the same 30-day bearer keyed to ONE email: ① `auth_from_license` (auto, existing) ② **email-OTP login** (`useAuth.sendCode`/`verifyCode` → `auth_send_code`/`auth_verify_code` → `/auth/send-code`+`/auth/verify-code`; the backend already had this for mobile/web) ③ device-pairing (not built). The OTP login is surfaced in-app via `components/AccountLoginDialog.tsx` (portaled themed modal) from two places: Settings → 账户 (a 试用 user logs into their mobile account; a 买断 user without a sub gets 「切换/绑定订阅账号」) and the `/corpus` gate (「登录账号」 replacing the old license-only 「重试」).

**Why this exists:** corpus + cloud-sync gate on session presence (`useAuth.status==='authed'`), not on license/subscription. A trial/free user previously had no way to obtain a session, so 云同步/语料库 were unreachable even though the backend grants every authenticated email a **free-tier quota** (sync 3 / corpus 50, `hasActiveSubscription ? 50 : 3`). Logging in with their mobile email makes sync-to-phone work (same identity across ends) under that free quota. A 买断 user who subscribed under a *different* email logs in with the sub email to pull Pro to the desktop.

**The invariant that keeps this from being a subscription-sharing hole:** identity is always the single logged-in email — entitlement is NEVER summed across emails (no account-linking / union). So this is an identity *switch*, not a merge: logging into email B makes B the active cloud library + entitlement; A's data becomes inactive (still on the server, just not the current identity). Sharing a login = sharing the whole account (one library, one quota) → self-limiting, unlike a union which would let one sub feed N accounts. `LicenseSessionGate`'s `if (status==='authed') return` guard means a manual login is NOT clobbered by license auto-login on next launch; it reverts to the license email only if the manual session expires (30 d). No backend change — purely surfacing the existing OTP flow + decoupling the gate from license/sub.

## AI Agent

Conversational agent mounted globally over every route. ReAct loop with a 24-tool registry, multi-vendor streaming, persisted history, page-aware context injection. Framed as a **private tutor** (not just a tool-caller): the per-turn context surfaces the learner's weak patterns and the agent recommends specific video timestamps to review them (see "Private-tutor loop" below).

**Three-state ChatBar:** `icon` (40×40 logo button) ↔ `bar` (600×50 input strip) ↔ `panel` (full chat surface). Mode is module-level zustand state + localStorage (`agentBarMode`); position likewise (`agentIconPos` / `agentBarPos`, viewport-clamped on load and on resize). `pageDefaultMode(pathname)` returns `icon` on `/player/*`, `bar` elsewhere. Navigation auto-nudges to page default UNLESS the user explicitly opened the panel (panel is sticky across nav). Closing the panel steps **down** to `bar`, not back to the page default — bidirectional step-down. **The reverse collapse animation (bar → icon) was deliberately removed**: a stale `setTimeout` could survive a mid-animation dep change (e.g. nav adjusting iconPos), leaving the bar stuck mounted at icon size — visually a gray square instead of the whatsub logo. Collapsing to icon is now a plain JSX swap.

**Files:**
- `src/components/agent/` — `AgentRoot` (router/auth-aware shell, mounts once in `App.tsx` inside `Router`), `ChatBar` (icon/bar/panel state machine, draggable, persists position), `InputBox` (textarea + typewriter placeholder + ↑/↓ history nav), `ConversationHeader`, `MessageList` / `UserBubble` / `AssistantBubble`, `ToolCallCard`, `InlineConfirmCard` / `InlineConfirmList`, `markdown.tsx` (hand-rolled — supports GFM-style pipe tables + `[text](url)` links opened via tauri-opener), `EmptyState` (noLlm copy + suggestion chips).
- `src/agent/` — `runtime.ts` (ReAct loop, 5-tool cap per turn; `STATIC_SYSTEM_PROMPT` carries the 私教 identity + `⟨私教职责⟩` block; calls `prepareWireHistory` before each provider call), `types.ts` (`AgentEvent` AsyncGenerator, ToolDef, PageContext, message shapes), `context.ts` (per-turn page state injection — see below), `history.ts` (wire-history reduction — see "Wire history"), `registry.ts` (24-tool static list), `slash.ts` / `mention.ts` (pure parse/expand for `/commands` + `@references`), `tools/<id>.ts` (one file per tool + its `.test.ts`), `nav.ts` (router-bridge — global `setNavigator(fn)` so tools can route without prop-drilling), `gate.ts` (per-page tool availability filter), `cost.ts`, `_promptBuilders.ts` (system-prompt assembler).
- `src/store/agent.ts` — zustand store: `history` (versioned, persisted), `streaming` state, `runInBackground` (single-flight background job per importQueue/Library tool), conversation CRUD (`createConversation` / `switchActive` / `deleteConversation` / `clearAll` / `exportHistory`).
- `src/store/agentConfirms.ts` — pending HIGH-risk tool confirmation requests rendered inline as cards.
- `src/store/playerState.ts` — global player time + cue refs so `seek_to_time` / `jump_to_cue` tools can read/write without prop-drilling.
- `src/components/agent/ToolsPopover.tsx` — the wrench button in `InputBox` opens this; lists every registered tool grouped by capability with risk badges. Membership/count read from the registry (any unmapped tool falls into 其它, never hidden); portaled to body to escape the panel's `overflow-hidden`.
- `src/llm/llmIdentity.ts` — vendor adapters (OpenAI / Claude / Gemini); each emits a unified `AgentEvent` stream so the runtime is vendor-agnostic.
- `src-tauri/src/commands/agent.rs` — `agent_history_load` / `agent_history_save` (5 MB cap, version field, corrupt-file → default-empty). Tests use injectable paths under `std::env::temp_dir()` per the `paths::*` rule.
- `src-tauri/src/commands/auth.rs::get_session_token` — exposes the bearer to TS so `lib/api/quota.ts` and `store/importQueue.ts` can `fetch` with auth (same pattern as `librarySync.ts`).

**24-tool registry** (`src/agent/registry.ts`) — grouped by risk + capability:
- discovery (read-only): `corpus_browse`, `corpus_phrase_detail`, `list_library`, `read_video_analysis`, `list_vocab`, `youtube_search`, `recommend_review`
- navigation: `open_video`, `open_page`, `seek_to_time`, `jump_to_cue`
- tutor entry points: `start_lesson`, `start_roleplay`, `start_remediation`, `query_learner_profile` (these replaced the old in-video AI tools `explain_passage` / `generate_quiz` / `mark_liaisons` / `translate_phrase`)
- vocab write: `vocab_add`, `vocab_remove`, `vocab_update_note`
- library write: `sync_to_cloud`, `materialize_from_cloud`, `import_video`
- library HIGH (require user confirm): `delete_video`, `unsync_from_cloud`, `retranscribe_video`

**Tool-arg path safety (2026-06-05):** the LLM supplies tool args, so any tool whose arg becomes a filesystem path is an injection surface. `delete_video` → `library_delete` → `paths::video_dir(id)` → `fs::remove_dir_all` would, for an id not matching a stored entry, fall back to `library_dir().join(id)` with no normalization — an id like `../../../Users/x/Documents` escaped the library dir and got recursively deleted (the same unvalidated id also reaches `load_analysis` / `load_transcript` / `retranscribe_video`). Fixed centrally: **`paths::video_dir` rejects any id containing a path separator, `..`, or an absolute path** before joining, so every caller is covered. Keep this guard when adding any tool that routes an LLM-supplied id into a path.

`ToolDef.availableOn(page: PageContext)` lets each tool gate itself — e.g. `seek_to_time` only surfaces on `/player/*`. The runtime's tool list per turn is `listTools(currentPage)`, so the LLM only ever sees the tools it can actually invoke from the current page.

**Page-context injection (`agent/context.ts`):** every turn's system prompt receives a fresh `PageContext` snapshot — pathname, active video id + currentTime + currentCueIdx (from `playerState`), library count, vocab count, and (when the learner profile is hydrated with data) the top weak patterns as `水平 B1 · 薄弱点: 过去式不规则×7 · 冠词缺失×5`. So "解释一下这一段" knows which cue the user is staring at, and "我哪儿弱" gets a grounded answer without the user spelling anything out.

**Private-tutor loop:** the learner profile (`tutor/types.ts` `LearnerProfile`, Rust-persisted) accumulates `ErrorEvent`s during lessons/roleplay — each carries `source.videoId` + `cueIdx`. The agent closes the loop with:
- **Weak-pattern awareness** — `context.ts` injects the top weak patterns each turn (above); `AgentRoot` hydrates the profile at mount so the sync snapshot has data.
- **`recommend_review` tool** — resolves the user's OWN past mistakes back to `{video, MM:SS, sentence, your error → correction}` by loading each error's `load_analysis` and reading `subtitles[cueIdx].time`. Dedups by spot, skips resolved/deleted, honors a limit. The agent narrates the items and offers `open_video(videoId, atSec)` or `start_remediation`.
- This is **review-anchored** (re-visit where you actually erred). A complementary "learn new examples" source — scanning the library for *unseen* cues that teach a weak pattern — is NOT built; it needs a pattern→cue index (grammar patterns can't be reliably matched to arbitrary cues without one, ideally tagged at analysis time).

**Input affordances** (`InputBox.tsx` action row): the panel input is a rounded card (text on top, action row below). Left of the outline-only send button: a ⌘ tools button → `ToolsPopover` (every tool grouped + risk badges; clicking a row inserts that tool's prompt template), a 🎤 voice toggle (moved here from the header), and a `ContextRing` (estimated tokens ÷ `modelContextBudget`; blue arc + %, amber + 建议开新会话 at ≥80%, click → new conversation). Two in-input launchers, both portaled with `data-agent-popover` (so a click doesn't trip the panel's click-outside collapse) and keyboard-driven from `InputBox`:
- **`/` slash commands** (`SlashMenu` + `store/slashCommands.ts`, localStorage): user-defined reusable prompt templates with `$ARGUMENTS`. Typing `/` autocompletes the name; on send `expandSlash` substitutes args before the message reaches the agent (the "workflow" is just the prompt — no new engine). Inline create/edit/delete; ships seed commands.
- **`@` references** (`AtMenu` + `agent/mention.ts`): reference a Library video; picked videos become chips above the input, and on send `composeWithRefs` prepends a machine-readable anchor `[引用·库视频] "title" (videoId=...)`. Chips carry zero-typing quick actions (总结 / 找类似 / 出题). The agent acts on the id via `read_video_analysis` (subtitle full-text + key phrases — the piece that makes "summarize this video" possible) / `youtube_search` / etc.

**Wire history** (`agent/history.ts`): the messages actually sent to the LLM each turn are reduced from the full stored conversation WITHOUT mutating the store. (#3) Large tool results from PAST turns are folded to a short placeholder (current-turn results stay full for the ReAct loop) — stops re-sending e.g. the youtube_search JSON every turn. (#1) Token-budget cap, not message count: a cheap CJK/latin token heuristic; when over `modelContextBudget(model)` (DeepSeek/Gemini ~1M, Claude ~200k, else 128k; 15% headroom) drop the OLDEST messages, then strip any leading orphan tool message. `ContextRing` shows this same usage to the user.

**Typewriter placeholder** (`InputBox.tsx`): 6 example Chinese prompts cycled char-by-char in the textarea placeholder when idle. Pauses (state preserved) on focus, resumes on blur. The auto-resize useLayoutEffect has an empty-text fast path returning 36px without measuring scrollHeight — during the icon→bar stretch animation, the textarea is briefly ~40px wide and `scrollHeight` reports the wrapped placeholder height (~80–100px), which would persist as inline `height` after the bar widens. Without the fast path, the bar paints too tall until the user types.

**Persistence model:** `agent_history.json` stores all conversations (active + past). `useAgent.hydrate()` reads it once at AgentRoot mount; writes go through `useAgent.persist()` debounced. Conversations carry `pageContextAtStart` (pathname only, used to title untitled conversations like "在 /library 的对话") + `summaryUpToMsgId` / `summary` so long conversations can be checkpoint-summarized without losing context.

**Tests:** every tool + adapter + the runtime + the store has a `.test.ts`. Vendor adapter fixtures are raw `.txt` files of recorded SSE streams under `src/agent/__fixtures__/`. `AgentRoot.test.tsx` covers mode persistence, page-default switching, panel stickiness across nav, and the nav-tool wiring.

**⚠️ Release-only pitfall — CSP forbids `eval`/`new Function`, so codegen libs (ajv) silently kill a turn (2026-06-14).** Symptom: in the **packaged build only** (not `tauri dev`), any agent reply that calls a tool freezes at "准备调用 `<tool>`" with **no loading spinner and no error** — the tool never runs. Root cause: the ReAct runtime validated tool args with **ajv**, which compiles JSON schemas via **`new Function()`** (codegen). The production WebView CSP (`tauri.conf.json` → `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' …`, **no `'unsafe-eval'`**) throws `EvalError`, which propagated out of `runTurn` and aborted the whole turn **before** executing the tool. `tauri dev` ships a relaxed CSP that allows eval, so it works in dev and ONLY breaks in release — invisible to dev testing and to vitest (Node allows eval). Fixes applied: (1) `runtime.ts` validates args **best-effort** — `getValidator`/`validate` wrapped in try/catch; if codegen is CSP-blocked it skips validation and runs the tool (tools handle their own args; path-safety is Rust-side in `paths::video_dir`). (2) `runtime.ts` executes tool_calls whenever the assistant message has any, regardless of the provider's `stop_reason` (some OpenAI-compatible providers/the whatSub relay return `finish_reason:"stop"` with tool_calls). **Rules:** do NOT "fix" CSP-eval errors by adding `'unsafe-eval'` to the CSP — it re-opens XSS over LLM/corpus output; instead make the eval-using code non-fatal or eval-free. Anything using `eval`/`new Function`/codegen (ajv, some template/expr libs) is invisible in dev — **always smoke-test agent/tool changes in a real `pnpm tauri build`, not just dev**. Diagnosing this kind of release-only freeze needs in-app logging (the WebView console isn't reachable in a packaged build): a temporary `agent_debug_log` Tauri command + `dbg()` instrumentation in `runtime.ts` (tracing stop_reason / calls / exec-start/ok/error / caught throws → `%APPDATA%/whatsub/agent-debug.log`) is what pinpointed it. That instrumentation was removed after the fix — recover it from git history (the 0.1.60–0.1.62 commits) if a similar release-only freeze recurs.

## Corpus page — multi-tag chip browse

`/corpus` (`pages/Corpus.tsx`) replaces the older fixed-18-scene tree with a flat multi-tag chip model that mirrors the server's `tags.list[]` storage.

```
[← Library | 语料库 | ↻]
[公共 / 我的]                              (tab strip)
[chip1] [chip2] [chip3] ... [清除(N)]      (tag chip wrap, scope-aware)
[phrase list]      | [phrase detail + YouTube embed + 例句出处]
```

- `CorpusTagChips` pulls tags from `useCorpusTags(scope)` which invokes `corpus_tags` Rust command (`/api/corpus/tags?scope=public|mine`). 18 official scenes pinned in canonical order, custom tags after a divider. Multi-select AND.
- `useCorpusList(scope)` SWR-style cache: reads server version via `corpus_versions`, compares to `tauri-plugin-store`-cached version, refetches only when stale. Scope tags participate in cache key.
- `CorpusPhraseList` shows row title + meaning + inline tag chips. The `mine` variant renders a `个人语料 used/limit` header via `lib/api/quota.ts::corpusQuota()` → `GET /api/corpus/quota` (`limit = hasActiveSubscription ? 1000 : 50`, server-authoritative).
- `CorpusPhraseDetail` shows `📚 公共例句出处` + `⭐ 我的例句出处` lists. Each instance has a clickable `▶ MM:SS` button (resolved via `instance.source.timestampSec ?? parseYouTubeUrl(url).startSec`) that re-seeks the embedded YouTube iframe.
- `YouTubeEmbed` uses `youtube-nocookie.com/embed/...` + `allow="encrypted-media; picture-in-picture; clipboard-write"`. No autoplay — WebView2 blocks unmuted autoplay.

**Three layout modes (2026-06-26), shared by BOTH lists** — a header toggle (`BrowseLayout = 'flat' | 'source' | 'tag'`, persisted per scope in localStorage `corpus.{mine,browse}.layout`; legacy mine `'grouped'` migrates to `'source'`):
- **平铺 (flat)** — one phrase per row (the classic list).
- **按视频来源 (source)** — the list becomes a *source picker* (one row per source, keyed by `groupKey(source)` = `yt:<id>` | `lib:<id>` | `url:<host>` | `manual`; YouTube is keyed by the individual video id parsed from the watch URL, since curator sources carry only `url`, no `youtubeId`). Clicking a row opens **`CorpusVideoDetail`** in the center: ONE player on top + every phrase from that source below, each a `▶ MM:SS` button that re-seeks the *single* player (YouTube → `YouTubeEmbed`; personal LOCAL Library `lib:` source → `PhrasePlayer` local playback; non-video → no player, phrase list with 🔗 source links). Re-seek = remount the player via a `key` that includes a nonce.
- **按场景/标签 (tag)** — group by tag; the 18 official scenes pinned in `SCENE_ORDER`, custom tags after, tagless under 未分类; a phrase appears under each of its tags.

  `CorpusPhraseList` reports its current layout up (`onLayoutChange`) and the picked source (`onSelectSource`, by group key — NOT a video id, so non-video sources don't fall into a re-select loop); `Corpus.tsx` tracks each list's layout + the shared `selectedSource` and routes the center panel (`CorpusVideoDetail` for the active list's source mode, else `CorpusPhraseDetail`). The public-browse `source` field is supplied server-side by `aggregateCuratorDataByPhrase` (most-recent curator contribution's source per phrase) — see whatsub-license.

Cache storage: `corpus_cache.json` via `tauri-plugin-store` LazyStore (see `lib/corpusCache.ts`). Field-shape notes for `/api/corpus/lookup?withScope=true` and `/api/corpus/versions` are in [`CLAUDE-FEATURES.md`](./CLAUDE-FEATURES.md#corpus-page-detail--apicorpuslookupwithscopetrue-field-shape).

## Library cloud sync (☁️ → whatsub-license backend → iOS app)

Each Library card (incl. inside opened folders) has a `SyncButton` overlay that pushes the analyzed video to the cloud so the iOS companion app can read it. Three Rust commands in `src-tauri/src/commands/library_sync.rs`, authed via `crate::auth::get_auth(&app)`:

- `library_sync_to_cloud(app, id)` — reads `{video_dir}/transcript.srt` + `analysis.json`, **downscales `thumb.jpg` → 320px JPEG via the ffmpeg sidecar → base64**, and `POST`s `{id, youtubeId, sourceUrl, title, durationSec, thumbUrl, transcriptSrt, analysisJson, thumbData}` to `POST /api/library/sync`. Also transcodes + uploads a 720p mp4 to OSS, emitting `Uploading{video_id,percent}` events. Returns `SyncOk.videoUploaded`; sets `sync_error="video_upload_failed"` on upload failure (entry still synced to cloud metadata). OSS PUT timeout = 30 min.
- `library_unsync_from_cloud(app, id)` — `DELETE /api/library/sync/:id` + clears local `syncedAt`. Backend DELETE also removes the OSS video object.
- `library_list_synced(app)` — `GET /api/library/list`. **Reconciles** the local index: clears `synced_at`/`sync_error` for local videos no longer in the cloud list (i.e. deleted from the iOS app). Local source files KEPT (desktop is master). Called on Library page mount.

`LibraryEntry` carries `syncedAt?: number` + `syncError?: string`; `SyncButton` renders idle/syncing/synced(✓)/error(✗). Both YouTube AND non-YouTube URL sources sync (Bilibili etc.); only local-file sources are excluded. The downscaled thumb is why the iOS list shows covers without a VPN — `i.ytimg.com` is GFW-blocked, so the backend serves the synced thumb from `whatsub.eversay.cc/api/library/thumb/:id` instead.

**Quota badge:** the 云同步详情 dialog shows `配额 used/limit` (amber when at/over cap), `GET /api/library/quota`. `limit` is server-authoritative (`hasActiveSubscription ? 50 : 3` — counts iOS subs AND Alipay/web 时段会员).

**Per-video size + duration cap (2026-05-28):** mirrors backend caps (free 100MB/20min, sub 500MB/60min). `library_sync_to_cloud` fetches `/quota` (now includes a `limits` object) and threads it into `upload_video`:
1. Duration pre-check BEFORE transcode — `entry.duration_sec > limits.maxVideoSeconds` → bail with `video_too_long`. Saves ~30s–2min of FFmpeg CPU.
2. Size check AFTER transcode — `bytes.len() > limits.maxVideoBytes` → cleanup mobile.mp4 + bail with `video_too_large`.
3. `contentLength` + `durationSec` sent in `/upload-url` body — backend can early-fail 413.

`upload_video` returns `Result<Option<String>, String>` — `Ok(Some(key))` = uploaded, `Ok(None)` = best-effort failure (transcode fail / network → captions-only sync), `Err(msg)` = hard error. `SyncButton.tsx` has dialog branches for `video_too_large` / `video_too_long` / `quota_exceeded`, all deep-linking the "前往订阅" CTA to `https://whatsub.eversay.cc/mobile#pro`.

## Import queue — desktop auto-poll worker

When the iOS app encounters a caption-less YouTube video — OR **any non-YouTube URL** (Bilibili etc.) — it pushes the URL to the backend queue (`POST /api/library/import-queue`). The desktop picks it up and runs the full local pipeline headlessly. yt-dlp handles Bilibili natively; `core/ids.rs::id_from_bilibili_url` extracts the BV id (else sha256 fallback). `library_sync_to_cloud` is source-agnostic.

- `src/lib/api/importQueue.ts` — `enqueueImport`, `listPending`, `setStatus` — `fetch` wrappers to `GET/POST /api/library/import-queue*` using the session bearer.
- `src/store/importQueue.ts` — module-level `setInterval` poll loop (~30 s, single-flight, only while authed). Per pending item: **atomically `claimItem(id)`** (backend `POST /import-queue/:id/claim`, conditional `pending→processing`; multi-desktop double-pick is prevented) → `invoke("import_video", ...)` → `load_transcript` + parseSrt → `runInBackground(...)` → await ready → `library_sync_to_cloud(videoId)` → `setStatus(id, 'done')`. Concurrency = 1.
- Rust command `get_session_token` returns the bearer from `auth.json` so the TS poll loop can authenticate its `fetch` calls natively.
- Wiring: loop started from `App.tsx` `useEffect` on auth ready.

## yt-dlp resolution order

`pipeline/ytdlp.rs::download()` resolves yt-dlp at runtime in priority order:

1. **`<app_data>/bin/yt-dlp{.exe}`** — user-updated copy from Settings → 更新 yt-dlp (`commands::yt_dlp::yt_dlp_update`). Downloaded via reqwest from `https://github.com/yt-dlp/yt-dlp/releases/latest/download/`, written to `.downloading`, atomic-renamed. `chmod +x` on unix.
2. **Bundled sidecar** (`binaries/yt-dlp-<target_triple>{.exe}`) — what `pnpm tauri build` ships. CI workflow input `yt_dlp_tag` (default `latest`) controls which yt-dlp release gets bundled.

The AppData path uses `pipeline/spawn.rs::run_external_with_callback` because Tauri shell plugin's `sidecar()` only accepts whitelisted basenames, not arbitrary paths. The bundled fallback uses `run_sidecar`.

Why this split: yt-dlp upstream ships multiple times/week chasing YouTube's player JS changes. Bundling means weeks-long lag when extractors break. Users hit Settings → 更新 yt-dlp to get the current latest within seconds.

## Foreground vs background yt-dlp retry budgets

`pipeline/ytdlp.rs::download(background: bool)`:

| flag | foreground | background |
|---|---|---|
| `--socket-timeout` | 5s | 20s |
| `--retries` (per HTTP req) | 1 | 10 |
| `--fragment-retries` | 1 | 10 |
| `--retry-sleep` | 2s | 5s |
| Process-level retry attempts | 1 | 3 (only on `is_transient_yt_dlp_error()`) |

Foreground goal: **fail fast (~25-50s)** so user sees actionable error dialog. Background goal: **patient (~3 min)** so transient blips recover without user supervision. ⚠️ These knobs only control TCP-connect + HTTP retries; they do NOT bound yt-dlp's player-JS sigsolver time — long YouTube videos with large DASH manifests can still take minutes in "准备中".

**Stall watchdog (2026-06-25).** The retry budgets above only fire when yt-dlp *exits with an error*. A long-video download that **hangs** mid-stream (downloaded half, then a fragment trickles/freezes — process alive, no exit) produced no error, so nothing retried → stuck forever in "准备中" with a half `.part`. Fix: a stall watchdog in `pipeline/spawn.rs` (`run_sidecar_env` + `run_external_with_callback`, both spawn paths). The download's stderr callback bumps a shared `StallCounter` (`Arc<AtomicU64>`) on each parsed progress line; the spawn loop runs a 15s `tokio::time::interval` and, **only once the counter has first moved** (so the legitimately-silent sigsolver/准备中 phase is never killed), kills the child if the counter doesn't advance for 8 ticks (~120s) and returns a `"stalled"` error. `download()` in `ytdlp.rs` treats `"stalled"` as its own recoverable case with a larger budget (`STALL_MAX_RETRIES = 5`, applied even in foreground since resume is cheap), re-spawning with `--continue` so each attempt resumes from the `.part` and progress accumulates. The watchdog is opt-in via the `Option<StallCounter>` param (None for ffmpeg/other sidecars, so their long quiet stretches aren't affected).

**Whisper reuses the same watchdog + auto-restart (2026-06-25).** A laptop that sleeps mid-transcription leaves whisper-cli wedged on wake (suspended process / lost Vulkan context) — the import hung forever at "转录中". `transcribe()` now passes a `StallCounter` (bumped per progress line) so the spawn loop kills a no-progress whisper after ~120s. whisper.cpp has no mid-file resume, so the single attempt is factored into `run_whisper_once()` and `transcribe()` wraps it in a retry loop: a `"stalled"` error re-runs from scratch on the same `audio.wav` (no re-download / re-extract; the GPU is healthy again after wake), up to `WHISPER_STALL_RETRIES = 2`, logging "自动重新转录 (N/2)" and resetting the bar to 0 each restart, then surfacing a real error (→ the Player's 重新转录 backstop). Cancellation + the GPU device-pinning/inventory logic are preserved across retries.

## whisper.cpp build

Built from whisper.cpp v1.8.4 in `.github/workflows/release.yml`. Win = Vulkan + CPU fallback (VS 2022 + Vulkan SDK + cmake). macOS arm64 = Metal + CPU fallback (Metal shaders embedded into `libggml-metal` since v1.7+; no separate `.metallib`).

Critical: Win cmake passes `-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=OFF -DGGML_AVX512=OFF -DGGML_FMA=OFF -DGGML_F16C=ON` — without this conservative SIMD baseline, CI's AVX-512 Xeon bakes incompatible SIMD into `ggml-cpu.dll` → end-user CPUs hit `STATUS_ILLEGAL_INSTRUCTION` even when Vulkan is the active backend (mel-spectrogram preprocessing runs on CPU SIMD).

`pipeline/whisper.rs` parses the first `ggml_<backend>: 0 = <gpu>` stderr line, persists as `settings.whisperBackend` so Settings shows "GPU 加速" status.

**Discrete-GPU selection on hybrid laptops (2026-06-21).** whisper.cpp's Vulkan backend defaults to Vulkan **device 0**, which on a dual-GPU laptop is almost always the integrated GPU — so transcription ran on the iGPU instead of the faster dGPU. Fix is **learn-on-first-run**: `transcribe()` parses ALL `ggml_vulkan: <i> = <name> … | uma: <u>` device lines (`parse_vulkan_device`; `discrete = uma != 1`, with a name-heuristic fallback) and emits a `GpuDevices` pipeline event after any *unfiltered* run. The frontend (`App.tsx` BackendListener) persists that inventory to `settings.whisperGpus`. On the **next** run, `gpu_preference()` reads `settings.preferDiscreteGpu` (default true) + the cached inventory and, if a discrete card sits at index ≠ 0, pins it via `GGML_VK_VISIBLE_DEVICES=<idx>` (injected through `spawn::run_sidecar_env`, a thin env-capable wrapper over `run_sidecar`). A pinned run only sees its 1 selected device, so we DON'T re-emit `GpuDevices` then (would clobber the full list). Net: first transcribe after install uses the iGPU + logs "已检测到独立显卡 … 下次自动启用"; every run after uses the dGPU. Settings → 显卡加速 shows the device list + a "优先使用独立显卡转录" toggle (only on machines that actually have the choice). Escape hatch: toggle off → whisper's default device 0. Staleness caveat: if the cached index later points at a missing device (hardware/driver change), that run may fall back to CPU — user toggles off/on to re-learn.

## Build / dev

```bash
pnpm install
pnpm tauri dev          # First cargo build 5–15 min; incremental ~10s
pnpm test               # Vitest
pnpm typecheck          # tsc --noEmit
pnpm tauri build        # → src-tauri/target/release/bundle/

cd src-tauri && cargo test    # safe: tests use temp paths only
```

> Dev mode: Tauri puts sidecars at `target/debug/<basename>.exe` (no triple). If you delete those during cleanup, dev spawn fails with `os error 2`.

### Fresh checkout on a new machine (sidecars are NOT in the repo)

`src-tauri/binaries/` is **gitignored** (`.exe`/`.dll`/`.dylib`/`.metallib` excluded — only `README.md` is committed). So a fresh `git clone` has an EMPTY `binaries/` and `pnpm tauri dev`/`build` fails until you populate it with: `yt-dlp` / `ffmpeg` / `ffprobe` / `node` / `whisper-cli` (all `-x86_64-pc-windows-msvc.exe` on Win) + the whisper/ggml DLLs (`whisper.dll`, `ggml*.dll`). The 3 MB IPA dict (`public/data/ipa-en-us.json`) IS committed; whisper models (`ggml-*.bin`) are downloaded in-app, not bundled. The app talks to the public prod backend (`whatsub.eversay.cc`) — no local backend/secrets needed for dev.

**Windows bootstrap:** `scripts/setup-windows.ps1` checks prereqs (Git / Node / pnpm / Rust+MSVC), clones (or reuses the repo it's in), **downloads** the standard sidecars (yt-dlp/ffmpeg/ffprobe/node), **extracts** the custom whisper DLLs from a `whisper-win-bits.zip` placed next to it (the Vulkan-built `whisper.dll`/`whisper-cli`/`ggml*.dll` — these can't be auto-downloaded; zip them from a working machine's `binaries/`), then `pnpm install`. Fallback when downloads are GFW-blocked: copy the whole `client/src-tauri/binaries/` folder from a working machine and just run `pnpm install`. A release `pnpm tauri build` additionally needs the signing key (`%USERPROFILE%/.tauri/whatsub.key` + `TAURI_SIGNING_PRIVATE_KEY`); plain `tauri dev` does not. The CI (`.github/workflows/release.yml`) is the source of truth for which sidecar versions ship.

## Release workflow

Three-repo dual-publish (private source / GitHub mirror / JiHu mirror) with minisign-signed updater. Step-by-step instructions, signing key handling, JiHu setup, and Updater UX live in [`CLAUDE-FEATURES.md`](./CLAUDE-FEATURES.md#release-workflow). The non-negotiables:

- **Never lose the private signing key** (public key shipped in app; rotation breaks all installed clients).
- **Never make source repo public** without rotating the local backup key.
- **Never delete a release users installed from** — breaks signature chain for subsequent updates.
- **Never commit `.msi` / `.sig`** — release assets only.
- **Before any release `git commit`, run `git branch --show-current` and confirm it's `main`** (see [`CLAUDE-PITFALLS.md`](./CLAUDE-PITFALLS.md#build--release--git)).

## Known limitations / TODO

- All OpenAI-compatible vendors share one API-key slot — switching DeepSeek ↔ Kimi may lose the prior key (vendorKeys stash exists but switch logic isn't fully wired).
- `settings.modelsDir` change does NOT migrate existing `.bin` files.
- ARM64 Windows / Intel Mac not built.
- ffprobe bundled but yt-dlp can't reach it (see [`CLAUDE-PITFALLS.md`](./CLAUDE-PITFALLS.md#sidecars--subprocess)).
- Burn-in export = libx264 only, no NVENC. 1–2× realtime CPU.
- Tauri updater plugin doesn't disk-cache across app restarts — close mid-download + reopen + click = re-download from byte 0.
- No way to shorten yt-dlp's player-JS sigsolver time.
- Personal-corpus 我的 tab loads via cached SWR but doesn't show a global "正在同步" state.
