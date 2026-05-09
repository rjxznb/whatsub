# Get Video Client — Architecture

Tauri 2 desktop app for English subtitle learning. Pipeline: import (yt-dlp / local) → ffmpeg audio extract → whisper.cpp transcribe → user-configured LLM (DeepSeek / Claude / Gemini / etc.) for Chinese translation + key-phrase highlighting → bilingual player.

> **Companion repo:** [`rjxznb/whatsub-license`](https://github.com/rjxznb/whatsub-license) (private) — a separate Hono + node-postgres backend running on the existing Eversay Aliyun ECS, exposed at `https://whatsub.eversay.cc`. The two communicate only via `POST https://whatsub.eversay.cc/api/license/activate` (one-time per device). After activation the desktop app runs fully offline. Migrated 2026-05-09 from a Cloudflare Workers + D1 setup (mainland-China latency dropped from 5-10s to <200ms by moving off CF's GFW-throttled edge). The old in-repo `license-server/` directory was retired.

## Stack

Tauri 2 · React 19 + TS + Vite · Tailwind v3 · zustand · React Router v6 · lucide-react · @fontsource/charis-sil · Vitest. Sidecars: `yt-dlp`, `ffmpeg`, `whisper-cli`. LLM HTTP is hand-rolled SSE per provider (no vendor SDKs).

## Layout

```
client/
├── src-tauri/                     # Rust backend
│   ├── src/                       # commands, pipeline, core
│   ├── binaries/                  # bundled sidecars + companion libs (Win DLL + Mac dylib)
│   ├── tauri.conf.json            # base config (Windows-shaped resources)
│   ├── tauri.macos.conf.json      # Mac overlay: bundle.macOS.frameworks for dylibs
│   ├── capabilities/default.json  # plugin perms + scoped shell:execute for the 3 sidecars
│   └── build.rs                   # copies sidecar companion libs to target/{profile}/
├── src/                           # React frontend
├── public/data/ipa-en-us.json     # 3 MB offline IPA dict (125k entries)
└── ...
```

## Rust modules (`src-tauri/src/`)

| File | Role |
|------|------|
| `lib.rs` | Tauri Builder + 22 invoke handlers |
| `core/paths.rs` | `%APPDATA%/whatsub/` resolution. `video_dir(id)` consults library.json's per-entry `videoDir` first (frozen at import). Adds `vocabulary_path()` |
| `core/ids.rs` | sha256 / YouTube ID / URL hash for `video_id` |
| `core/srt.rs` | SRT parser |
| `core/progress.rs` | `PipelineEvent` enum + `emit()`. Variants: Started, Downloading (+ optional `speed`/`eta`/`total` fields, populated from yt-dlp's pipe-separated `--progress-template`), ExtractingAudio, Transcribing, Transcribed, Failed, ModelDownload, Log, BackendDetected, **Exporting** + **Exported** (burn-in flow) |
| `commands/settings.rs` | `get/save_settings` (Value-based; schema-agnostic) |
| `commands/library.rs` | list/get/upsert/delete/set_status/rename/reorder/freeze_paths/reveal_in_explorer |
| `commands/analysis.rs` | save/load_analysis, load_transcript, video_source_path, **write_text_file** (SRT/CSV export), **export_burned_video** + **cancel_export** (ffmpeg burn-in pipeline; `ExportState` held in Tauri `.manage()`) |
| `commands/vocabulary.rs` | `vocab_list/add/remove`. Storage: `vocabulary.json` at app data root. Dedupe by id = `expression.toLowerCase().trim()` |
| `commands/license.rs` | License device-fingerprint + local persistence. 4 invokes: `license_get_device_info` (fingerprint = sha256 of `machine_uid` + `:whatsub:v1` salt; deviceLabel from `whoami::devicename`), `license_read_state` (parses `<app-data>/license.json`; returns null if missing or corrupt), `license_save_state` (writes after server-side activation succeeds), `license_clear_state` (user clicks "release this device"). Network calls to the activate endpoint live on the JS side using fetch — Rust just provides hardware introspection + persistence. Salt namespaces our fingerprint so the same hardware activating a different product doesn't collide on shared license servers |
| `commands/models.rs` | whisper_model_status / download |
| `commands/import.rs` | `import_video` orchestrator |
| `pipeline/spawn.rs` | `run_sidecar()` — spawn + stderr tail for error diagnostics. "terminated abnormally" branch includes captured stderr + Mac-specific dyld hint. **Windows-only**: prepends `<resource_dir>/binaries/` to the child process's PATH so whisper-cli resolves its companion DLLs (whisper.dll, ggml*.dll). bundle.resources puts those DLLs at `<install>/resources/binaries/` which isn't in Windows' default DLL search order — without this fix whisper-cli exits with `STATUS_DLL_NOT_FOUND` (-1073741515) on every fresh MSI install |
| `pipeline/ytdlp.rs` | URL → source.mp4 + thumb.jpg + info.json (reads `cookiesFile` from settings). Resolves bundled `ffmpeg` and `node` sidecars at runtime and passes `--ffmpeg-location` + `--js-runtimes node:<path>` so yt-dlp finds both (without ffmpeg → "ffmpeg not found"; without node → YouTube n-challenge fails → "Requested format not available"). System-path scan kept as dev fallback. Always passes `--no-playlist` — YouTube URLs copied from inside a playlist carry `&list=...&index=N` and yt-dlp would otherwise download the whole list, repeatedly overwriting source.mp4 + thumb.jpg and bailing on the first unavailable item. `yt_dlp_format(quality)` maps user-facing quality preset (`low`/`standard`/`high`/`best` → 480/720/1080/1080) to a **4-tier `-f` selector preferring `avc1+m4a`** for Mac WKWebView/AVFoundation compatibility (Opus-in-MP4 / VP9-in-MP4 are hard-rejected by the in-app `<video>` tag), with progressive fallback: avc1+m4a → any mp4 video + m4a → any video + any audio → best muxed. `best` is **capped at 1080p** because YouTube only ships VP9/AV1 above 1080p. Belt-and-suspenders: `--postprocessor-args "Merger:-c:v copy -c:a aac -b:a 192k"` re-encodes audio to AAC during merge if the chain falls through to a non-m4a stream (video stream is still copied — no re-encode cost) |
| `pipeline/ffmpeg.rs` | extract_audio_wav (16 kHz mono PCM), extract_thumbnail |
| `pipeline/whisper.rs` | transcribe via whisper-cli; model download (`.partial` → atomic rename, hf-mirror.com URLs); parses `ggml_<backend>: 0 = <name>` to emit `BackendDetected` |

### Tauri config

- `tauri.conf.json` (base / Windows): `productName: "whatsub"`, `identifier: "com.whatsub.app"` (drives MSI UpgradeCode + macOS bundle ID); `externalBin` lists 4 sidecar basenames (`yt-dlp`, `ffmpeg`, `whisper-cli`, `node`); `bundle.resources` ships the Vulkan whisper DLLs; assetProtocol scope = `$DATA/whatsub/**`, `$LOCALDATA/whatsub/**`, `**/*.{mp4,jpg,...}`.
- `tauri.macos.conf.json` (overlay): `bundle.macOS.frameworks` lists the 6 dylibs whisper-cli @rpaths against (`libwhisper.1.dylib`, `libggml.0.dylib`, `libggml-{base,blas,cpu,metal}.0.dylib`).
- `capabilities/default.json`: scoped `shell:allow-execute` per sidecar.

### Pipeline event stream

`emit("pipeline-event", PipelineEvent)`. Frontend listens via Tauri's event bus.

```
Started{video_id} → Downloading{percent}* → ExtractingAudio → Transcribing{percent}*
  → Transcribed{srt_path, duration_sec}        (Failed{error} at any step)
ModelDownload{progress, total_mb, downloaded_mb}    (model fetch, separate stream)
BackendDetected{name}                                (once per transcribe; persisted into settings)
Exporting{video_id, percent}* → Exported{video_id, output_path}    (subtitle burn-in)
```

## whisper.cpp build

| Platform | Backend | DLLs / dylibs in `binaries/` |
|----------|---------|------------------------------|
| Windows x64 | **Vulkan** + CPU fallback | `whisper-cli.exe`, `whisper.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml-vulkan.dll` |
| macOS arm64 | **Metal** + CPU fallback | `whisper-cli`, `libwhisper.1.dylib`, `libggml.0.dylib`, `libggml-{base,blas,cpu,metal}.0.dylib` (Metal shaders embedded into libggml-metal — no separate `.metallib` since whisper.cpp v1.7+) |

Built from whisper.cpp v1.8.4 in CI (`.github/workflows/release.yml`). Windows uses VS 2022 + Vulkan SDK + cmake with **conservative SIMD baseline** (`-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=OFF -DGGML_AVX512=OFF -DGGML_FMA=OFF -DGGML_F16C=ON`) — without these the CI runner's AVX-512 Xeon would bake incompatible SIMD into ggml-cpu.dll and end-user CPUs hit `STATUS_ILLEGAL_INSTRUCTION` (-1073741795) even when Vulkan is the active backend (mel-spectrogram preprocessing still runs on CPU SIMD). macOS arm64 uses Metal (`-DGGML_METAL=ON`) and is naturally portable across all M-series chips.

`pipeline/whisper.rs` parses the first `ggml_<backend>: 0 = <gpu name>` stderr line to recognize the active accelerator (`Vulkan / NVIDIA RTX 4090`, `Metal / Apple M2 Pro`, etc.) and emits `BackendDetected` once per run. CPU-only fallback case explicitly emits `BackendDetected{ name: "CPU" }`.

## Frontend modules (`src/`)

| File | Notes |
|------|------|
| `App.tsx` | Routes (/library, /player/:id, /vocab, /settings); mounts `BackendListener` at root |
| `pages/Library.tsx` | Card grid; drag-drop reorder; right-click menu; OS file drop → ImportModal; status badges; header has ⭐ vocab + ⚙ settings links |
| `pages/Player.tsx` | Resizable split (localStorage %); left video, right tabs `[字幕 \| 重点短语]`. Owns LLM analysis effect with AbortController + StrictMode dedup. Reads `?t=<sec>` deep-link and seeks on `loadedmetadata`. Throttled partial-save of analysis.json every 800 ms while streaming. **Export menu**: SRT en/zh/both + burn-in mp4 via `ExportVideoModal`. **Caption overlay toggle** + **auto-scroll toggle** + **edit mode toggle** (in subtitle tab header). On videoId change, synchronously calls `useAnalysis.getState().reset()` before the async load to avoid showing the previous video's cues during the await window |
| `pages/Settings.tsx` | VendorSection (preset → autofill base URL); SecretField/DirField/FileField; Whisper model dropdown + download progress; **GPU 加速 status** (read from `whisperBackend`) |
| `pages/Vocab.tsx` | Sort modes (按视频/最近/最早/字母); flat or grouped view; CSV export via `write_text_file` (RFC4180 escape + BOM); per-entry deep link to `/player/:id?t=<cueTime>` |
| `components/VideoPlayer.tsx` | YouTube-like controls; hold ←/→ = 2x boost; speed 0.5–2x; panel toggle; bilingual caption overlay toggle (renders `CaptionOverlay`) |
| `components/CaptionOverlay.tsx` | Cinema-style EN+ZH overlay anchored at `bottom-20` over the video. Same highlight splice as SubtitleList but plain `<span>` (no tooltip); the whole layer is `pointer-events-none` so it never intercepts player clicks |
| `components/SubtitleList.tsx` | View mode: auto-scroll to current cue with **two unified freeze sources OR'd together** — (1) `hoveringHighlight` boolean held while cursor is on a `[data-highlight="true"]` span (English HighlightWord OR Chinese translation span — both tagged), no expiry while hovering; (2) `interacting` 2s timer bumped by wheel/scroll/touchmove **and by mouseout from a highlight** (so leaving doesn't immediately snap back — gives 2s grace, any further scroll resets). `interacting` state is in the effect's deps so timer expiry reliably re-triggers the snap on a paused video. The ref'd container always renders even when subtitles is empty so the listener-attaching effect (`[]` deps) doesn't fire with `listRef.current === null` during fresh streaming. `programmaticScrollRef` discriminates our own `scrollIntoView` from user scrolls. Edit mode (`editing` prop): per-row `EditableRow` with text/timestamp `<input>` + Plus/Trash2 + GripVertical drag handle; **only the grip is `draggable=true`** (avoids HTML5 drag conflicts with input/textarea text-selection); on each mutation calls `onChanged` which schedules a partial save in Player. Drop target uses **capture-phase `onDragOverCapture` + unconditional `preventDefault`** so child textareas don't claim the dragover with native text-drop (otherwise cursor stuck on "forbidden") |
| `components/ExportVideoModal.tsx` | 4-phase modal (config / running / done / failed). 3 checkboxes (en / zh / 高亮) + **画质 dropdown** (高/标准/流畅 → CRF 18/22/26 + slow/medium/fast preset, only shown when at least one subtitle is selected; stream-copy mode skips re-encode so quality is irrelevant). Empty ASS string → backend stream-copies the original (label switches to "导出原视频", filename suffix `copy` vs `subtitled`). On start, generates ASS via `subtitlesToAss`, calls `export_burned_video` with `quality`. Subscribes to `Exporting` + `Log` events for live percent + ffmpeg stderr tail (debug visibility). Cancel button calls `cancel_export` |
| `components/KeyPhraseList.tsx` | Phrase cards (amber expr + IPA + 🔊 + ⭐ + meaning + usage); voice dropdown; install hint if no English voices; resolves first source cue per phrase to seed StarButton's deep-link |
| `components/HighlightWord.tsx` | Inline yellow span with `data-highlight="true"`; hover/click → keyNote tooltip |
| `components/StarButton.tsx` | Toggle (filled/outlined) — calls `useVocabulary.toggle(...)` |
| `components/ImportModal.tsx` | URL/local tabs; live phase checklist via `pipeline-event` with **per-tier ETA** (lookups `MODEL_TIERS` for friendly tier name + estimated seconds-per-10min). **画质 dropdown** on URL tab (low/standard/high/best → 480/720/1080/源画质) passes `quality` into `import_video` invoke. Cookies-tutorial help panel is internally scrollable (`max-h-[60vh] overflow-y-auto` + sticky close button); window-level Esc closes the **error-detail dialog** → help panel → whole modal in priority order. Each fail-mode in help lists the exact yt-dlp error keyword (cookies "Sign in to confirm you're not a bot" flagged 🌟 最常见). Errors rendered as a single-line clickable `⚠️ <fe.title>` row (truncate-ellipsis); click opens a **separate top-layer (z-60) scrollable dialog** with title + suggestion + 复制详情 + bounded `<pre>` for the full stderr — keeps the long stderr from pushing the parent modal past 90vh and dominating the screen |
| `components/ProgressBanner.tsx` | Phases: downloading/extracting/transcribing/analyzing/**paused**/error. **停止/继续** buttons (paused). Calls Player's onStop/onContinue |
| `components/FirstRunGate.tsx` | Welcome if no LLM key OR no Whisper model. Two-card layout: ① 翻译服务 (vendor dropdown defaults to deepseek for fresh installs but respects `settings.vendorId` if user previously picked a different vendor), ② 字幕识别引擎. Card ② **auto-promotes any already-downloaded tier** to `settings.whisperModel` on mount (prefer largest) so a reinstall with leftover `ggml-*.bin` doesn't force re-download. Per-tier badge shows live `下载中 X%` for the active download (uses `pct` state) instead of the stale paused-snapshot from `partialPct` |
| `components/LicenseGate.tsx` | **Outermost gate in App.tsx** — wraps the BrowserRouter so until `useLicense().mode === 'ACTIVE'`, no routing / FirstRunGate / UpdateChecker / BackendListener mounts. Renders 3 states: `INITIALIZING` (loading spinner), `NEEDS_KEY` (full-screen activation form), `ACTIVE` (children pass through). Activation form posts to `ACTIVATE_ENDPOINT` constant (`https://whatsub.eversay.cc/api/license/activate` — Aliyun, mainland-direct); 30s timeout retained from the CF era as a safety margin, but typical activation latency is now <200ms. Three error states displayed with distinct UI: `invalid_key`, `device_limit` (lists currently-active devices with fingerprint tail so user identifies which is which), `network` (mentions Cloudflare reachability) |
| `hooks/useTauriEvent.ts` | `listen()` wrapper with cleanup |
| `hooks/useVideoSync.ts` | rAF binding video.currentTime → cue index |
| `hooks/useSpeech.ts` | Web Speech API; voice persistence; auto-cancel on new utterance |
| `store/settings.ts` | Settings + load/save; deep merge for partial legacy files |
| `store/library.ts` | Library list + optimistic reorder/rename |
| `store/analysis.ts` | phase, progressPercent, subtitles[], summary, error. `appendSubtitle` dedupes by `(time, endTime, text)`. Includes `paused` phase + cue edit ops (update/delete/insert/reorder) |
| `store/vocab.ts` | entries[], reload/add/remove/toggle/has |
| `store/license.ts` | License gate state machine (`INITIALIZING` → `NEEDS_KEY` ↔ `ACTIVE`). `init()` reads local license.json + device info via Rust invokes. `activate(key)` POSTs to ACTIVATE_ENDPOINT with key/fingerprint/deviceLabel and routes server response into typed `ActivateError` (invalid_key / device_limit / network / bad_request / unknown). `deactivate()` clears local license.json (server-side slot release requires admin) |
| `llm/types.ts` | Subtitle, KeyPhrase, AnalysisResult, SrtCue |
| `llm/vendors.ts` | 10 vendor presets (DeepSeek/OpenAI/Kimi/智谱/Qwen/SiliconFlow/Ollama/Claude/Gemini/Custom); `inferVendorId()` for legacy settings |
| `llm/prompts.ts` | SYSTEM_PROMPT (踩过的坑 rules) + `buildUserPrompt` / `buildContinuationPrompt` (per-cue, no summary) / **`buildSummaryPrompt(Subtitle[])`** (final global pass) |
| `llm/parseSrt.ts` | SRT → `SrtCue[]` |
| `llm/batchSubtitles.ts` | 50-cue batches |
| `llm/streamingJson.ts` | `JsonLineParser.feed/flush` — tolerates malformed lines |
| `llm/analyze.ts` | **Two-phase**: phase 1 = per-batch cue analysis (no summary); phase 2 = single global summary call across all cues (incl. `previouslyAnalyzed` from resume). AbortSignal threaded through; phase 2 failure logged but doesn't fail the run |
| `llm/providers/{openaiCompatible,claude,gemini}.ts` | SSE stream parsers; `signal` forwarded to fetch |
| `llm/phonetic.ts` | Lazy `/data/ipa-en-us.json`; multi-word looked up by token |
| `types/{settings,library,vocab}.ts` | Interfaces + defaults; `whisperBackend` field on Settings |
| `utils/srt.ts` | `subtitlesToSrt(en|zh)` + `sanitizeFilename` (used by export) |
| `utils/ass.ts` | `subtitlesToAss(subs, opts)` for video burn-in. Two ASS styles (EN: Arial 42, ZH: Microsoft YaHei 38), bottom-anchored. Highlights wrapped in `{\c&H00FFFF&}…{\r}` (BGR yellow). Centisecond time format rounded once to dodge fp loss. Vitest covers escapes + highlight splice |
| `utils/time.ts` | `formatTime` (mm:ss / h:mm:ss for display) + `formatEditTime` / `parseEditTime` (m:ss.ms format used by SubtitleList edit mode) |
| `utils/friendlyError.ts` | `friendlyError(raw, phase)` — translates yt-dlp / ffmpeg / whisper-cli stderr fragments (`Sign in to confirm you're not a bot`, `STATUS_DLL_NOT_FOUND`, `illegal instruction`, `Members-only video`, `getaddrinfo failed`, etc.) into `{ title, suggestion, details }` for non-technical users. Phase context disambiguates network-vs-transcribe failures. New patterns slot in by precedence (specific → generic) |

## Storage layout (`%APPDATA%/whatsub/` on Windows, `~/Library/Application Support/whatsub/` on macOS)

```
settings.json              # always at default path
library.json               # always at default path; videos[] include absolute thumbnailPath + videoDir
vocabulary.json            # ⭐ saved phrases (cross-video)
license.json               # { key, fingerprint, deviceLabel, activatedAt }; presence = ACTIVE state
models/ggml-<size>.bin     # default; settings.modelsDir overrides for new downloads only
library/<video_id>/
  source.mp4 · audio.wav · transcript.srt · thumb.jpg · analysis.json · info.json
```

`videoDir` per entry is **frozen at import time** so changing `settings.libraryDir` doesn't orphan old entries. `library_freeze_paths` patches legacy entries before any libraryDir change.

## Data flow

### Import (URL or local)

```
ImportModal.submit() → invoke('import_video', {sourceKind, sourceValue, whisperModel})
  Rust commands::import:
    sha256 / YouTube ID / URL hash → video_id; out_dir = paths::video_dir(id)
    emit Started → URL: ytdlp::download (cookies + percent events) | Local: copy + ffmpeg::extract_thumbnail
    library_upsert(status=Analyzing, videoDir=out_dir)
    emit ExtractingAudio → ffmpeg::extract_audio_wav (-ac 1 -ar 16000 -c:a pcm_s16le)
    emit Transcribing → whisper::transcribe (emits Transcribing{percent} + BackendDetected once)
    emit Transcribed
  Modal → navigate(/player/:videoId)
```

### LLM analysis (Player mount)

```
1. invoke('load_analysis')
   - cached complete (cleanedCues.length >= cues.length): setSubtitles + setSummary + phase=complete
   - cached partial (some cues, not all): setSubtitles + phase=PAUSED (don't auto-resume; wait for 继续)
   - no cache: continue
2. analysis.startFor(videoId); load transcript; parseSrt → cuesRef
3. startAnalysisFrom(0): new AbortController; phase=analyzing; provider = getProvider(settings)
4. runAnalysis({cues=remaining, previouslyAnalyzed=store.subtitles.slice(), signal}):
   - Phase 1: for batch i in batches: stream JSON-lines → onCue → appendSubtitle (throttled save)
   - Phase 2: provider.stream(buildSummaryPrompt(allAnalyzedCues)) → onSummary → setSummary
     · phase 2 failure: console.warn, cues stay intact, run completes
5. save_analysis (final) + library_set_status(ready); phase=complete
```

Stop button: `abortRef.current.abort()`; phase=paused; force-flush partial save. Continue: `startAnalysisFrom(store.subtitles.length)`.

### Subtitle rendering

`SubtitleList` walks each cue text left-to-right, splicing `HighlightWord` at each `highlightWords[i]` substring. Translation gets amber spans for `highlightTranslations`. Highlight hover → `data-highlight="true"` → event-delegated freeze of auto-scroll until mouseleave.

`KeyPhraseList`: `lookupPhonetic` per phrase via `Promise.all` on mount; `useMemo` builds `expression → first source cue` map (matches `highlightWords` includes; falls back to text substring) so StarButton can save deep-link context.

## Key design decisions

1. **Rust does subprocess + filesystem; TS does HTTP/LLM.** Cleanest separation; TS gets browser fetch + Web Streams; Tauri's externalBin handles cross-platform binary distribution. Sidecar resolution is by basename only (`sidecar("yt-dlp")`, NOT `"binaries/yt-dlp"` — Tauri strips the prefix).
2. **External binaries bundled, Whisper model lazy-downloaded.** ~280 MB Win installer / similar Mac. Models pull from hf-mirror.com with `.partial → fs::rename` atomic semantics.
3. **JSON Lines streaming for LLM output.** Each cue arrives as one line → UI streams cue-by-cue. Robust to model variation. Two-phase: phase 1 = cues only; phase 2 = single global summary call (sees the WHOLE transcript, not just last batch).
4. **Cancellation = AbortController.** `runAnalysis` accepts `signal`; threaded into provider fetch. Stop button aborts → phase=paused → partial save persists. Continue resumes from `subtitles.length` with `previouslyAnalyzed` so summary phase still sees full transcript.
5. **All asset paths absolute in library.json.** `videoDir` frozen per entry; changing `settings.libraryDir` never orphans old entries.
6. **Asset protocol scope:** `$DATA/whatsub/**` covers Windows + macOS defaults; `$LOCALDATA/whatsub/**` covers macOS variant; `**/*.mp4` etc. allow custom paths.
7. **Web Speech API for TTS.** Cross-platform, zero deps. Hint shown if no English voices installed (Windows users → 时间和语言 → 语音 → 添加).
8. **Offline IPA dict (3 MB JSON, 125k entries).** Lazy-loaded on first KeyPhrase view; cached forever in renderer. Render-time only — never stored in `analysis.json`, so old analyses gain IPA without re-running LLM.
9. **Vendor preset layer over protocol.** 3 internal protocols (`openai-compatible` / `claude` / `gemini`) cover wire format; 10 user-facing vendors (`llm/vendors.ts`) combine protocol + preset baseUrl + suggested models + console link. `inferVendorId()` reverse-maps legacy settings.json.
10. **Vocabulary deep links + sort modes.** Star saves cue context (cueTime + cueText). Vocab page sort: 按视频分组 / 最近 / 最早 / 字母. Click vocab entry → `/player/:id?t=<sec>` → seek video.
11. **Tauri 2 platform overlay** (`tauri.macos.conf.json`) keeps Mac config (frameworks list) out of the base file so Windows builds don't reference missing dylibs.
12. **License gate is one-time, online only at activation; pure offline forever after.** No periodic verification, no revocation, no JWT — just a presence check on `license.json`. Once activated the app never phones home again. Trade-offs: (a) refunds aren't supported (we tell buyers "数字商品售出不退" upfront), (b) cracking the local file or patching the gate is trivial — the protection mechanism is the ONE-TIME network call enforcing the 3-device limit per key, plus the unfair effort/reward ratio for casual sharers. The fingerprint is `sha256(machine_uid || ":whatsub:v1")`, server-side stored as opaque hex. ACTIVATE_ENDPOINT is hard-coded into the binary so users can't redirect the activation call to a fake server via settings. Companion server lives in [`rjxznb/whatsub-license`](https://github.com/rjxznb/whatsub-license) (Hono + Postgres on Aliyun, separate repo).

## Build / dev

```bash
# Frontend (run from client/)
pnpm install
pnpm tauri dev          # First cargo build 5–15 min; incremental ~10s
pnpm test               # Vitest, ~32 unit tests (incl. ASS generator, time parsing, providers)
pnpm typecheck          # tsc --noEmit
pnpm tauri build        # → src-tauri/target/release/bundle/

# Rust unit tests (from src-tauri/)
cargo test              # paths, ids, srt, ytdlp, whisper, library, settings,
                        # commands::analysis::extract_time_field (ffmpeg progress parser)
                        # NB: library + settings tests pollute real %APPDATA%/whatsub/
```

> Dev mode: Tauri puts sidecars at `target/debug/<basename>.exe` (no triple). If you delete those during cleanup, dev spawn fails with `os error 2 (file not found)` — copy them back from `binaries/` or rebuild.

## Release workflow

**Three repos, dual-publish:**
- Source: `rjxznb/whatsub` on GitHub (private)
- Release mirror A (international + GitHub-native UX): `rjxznb/whatsub-releases` on GitHub (public)
- Release mirror B (China-direct, no proxy needed): `rjxznb-group/whatsub-release` on **JiHu GitLab** `jihulab.com` (public, project id 335658)

**Updater endpoints (in `tauri.conf.json`, tried in order):**
1. `https://jihulab.com/rjxznb-group/whatsub-release/-/releases/permalink/latest/downloads/latest.json` — preferred. JiHu is fully reachable from mainland China without VPN; international users can also hit it.
2. `https://github.com/rjxznb/whatsub-releases/releases/latest/download/latest.json` — fallback. If JiHu is ever down, updater tries GitHub.

The `permalink/latest` URL on JiHu is GitLab's "newest release by `released_at`" alias; resolves to the most recent release tag with an asset link whose `direct_asset_path: "/latest.json"` matches the URL suffix.

**Why dual-publish (vs single):** Tauri-plugin-updater's reqwest client doesn't read OS-level proxy settings (only `HTTPS_PROXY` env var). On Mac/Win, even with system proxy enabled, requests bypass it. GitHub's release-assets CDN (Azure Blob) is intermittently unreachable from mainland China without a working VPN at the IP level, manifesting as `error sending request`. Hosting on JiHu — a domestic GitLab instance — sidesteps the GFW issue entirely so the in-app update flow Just Works.

**Same minisign key for both mirrors.** Signature bytes are identical for the same artifact, so we don't have to maintain two key pairs. Only the `url` field inside `latest.json` differs between the two mirror manifests.

Private signing key in repo secret `TAURI_SIGNING_PRIVATE_KEY` (also `secrets/whatsub.key` locally for backup). Public key embedded in `tauri.conf.json` `plugins.updater.pubkey`. JiHu API auth via secret `GITLAB_TOKEN` (Personal Access Token with `api` scope, owner-level access to the project).

Releases are **automated via `.github/workflows/release.yml`** — `workflow_dispatch` only, no auto-trigger on push. The workflow has three jobs: `build-windows` (windows-latest), `build-macos` (macos-14, Apple Silicon), and `publish` (ubuntu-latest, downloads both artifacts and stitches `latest.json`).

### Per-release checklist

1. Bump version in 3 places: `client/package.json`, `client/src-tauri/tauri.conf.json`, `client/src-tauri/Cargo.toml` (must match).
2. Commit + push to `main`.
3. GitHub Actions UI → **Release** → Run workflow. Inputs:
   - `targets`: `both` / `windows` / `macos` (build only one platform when iterating; the un-rebuilt platform's manifest entry is carried over from the most recent existing release so `latest.json` stays complete)
   - `release_notes`: shown in the in-app update toast
   - `whisper_tag`: defaults `v1.8.4`
   - `vulkan_sdk_version`: defaults `1.4.309.0` (LunarG removes older versions periodically — bump to a known-available version if download 404s)
   - `node_version`: defaults `22.11.0` (bundled into the installer for yt-dlp's YouTube n-challenge solver)
   - `dry_run`: `true` to upload artifacts to the run page only, skip publishing
4. Workflow runs ~5–25 min depending on cache hit (see "CI caching" below). On success, `v$VERSION` release on the public repo gets `.msi` + `.msi.sig` + `.dmg` + `.app.tar.gz` + `.app.tar.gz.sig` + `latest.json`.
5. Verify: `curl https://github.com/rjxznb/whatsub-releases/releases/latest/download/latest.json` returns the manifest with both platforms. (Note: fastly CDN can lag 5–30 min behind a fresh upload — re-upload `latest.json --clobber` if stale, or wait.)
6. Test upgrade flow on a machine running the prior version.

### CI caching

The workflow caches several things to keep re-runs fast:

| Cache | Key | Skips when hit |
|------|-----|----------------|
| Whisper Win sidecar + DLLs | `whisper-windows-{whisper_tag}-vk{vulkan_sdk_version}-cpu-avx-only-v1` | clone + cmake build + Vulkan SDK install (~5–8 min). Suffix bumped when build flags change (e.g. SIMD baseline) |
| Vulkan SDK install dir | `vulkan-sdk-{vulkan_sdk_version}` | LunarG download + silent install (~2–3 min). Only consulted on whisper miss |
| Whisper Mac sidecar + dylibs | `whisper-macos-{whisper_tag}` | clone + cmake build + install_name_tool + ad-hoc codesign (~3 min) |
| Node sidecar (Win + Mac) | `node-{platform}-{node_version}` | nodejs.org download + extract |
| Cargo target + registry (per-platform) | via `Swatinem/rust-cache@v2` | ~half of cargo compile time |

Caches invalidate automatically when their input version changes. Net: a no-op release re-build drops from ~25 min Win + 5 min Mac (cold) to ~5–8 min Win + 2–3 min Mac (warm).

### macOS bundle

The workflow runs `pnpm tauri build` on a macos-14 runner with `tauri.macos.conf.json` overlay supplying `bundle.macOS.frameworks` for the 6 `.dylib`s. dylibs are `install_name_tool`'d to use `@rpath/...` (with `LC_RPATH` covering both `@executable_path/` and `@executable_path/../Frameworks/` so dev + prod layouts both resolve), then `codesign --force --sign -` re-signs everything. The `.app` is then re-signed `--deep --sign -` post-build. **Apple Developer ID signed + notarized** in CI (env vars `APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` provided as repo secrets) — `.dmg` is submitted to `notarytool`, polled until accepted (50 min cap), then `stapler staple`'d. The `.app.tar.gz` is repackaged from the stapled `.app` so the auto-updater serves the notarized version.

**bundle_dmg.sh retry**: Tauri's create-dmg wrapper relies on AppleScript + hdiutil + diskimages-helper, all of which intermittently fail on macos-14 runners with a generic 4-second `failed to bundle project` error. The Tauri build step is wrapped in a 3x retry loop (`for attempt in 1 2 3; do pnpm tauri build; ...`) with `hdiutil detach -force /Volumes/whatsub*` + `pkill -9 diskimages-helper` + 8s sleep between attempts to clear the residue. Hard-fails after 3 attempts since the downstream notarization stapler step requires the `.dmg`. Cargo + vite caches make retries cheap (~2 min each).

### User-facing update behavior

- Auto-check on launch (3s after window opens, silent on network fail).
- Bottom-right toast if newer version found: 「立即更新」 (download + verify + install + restart) / 「稍后」 (session-only) / 「✓ 不再提醒此版本」 (persists in `localStorage["skippedUpdateVersions"]`; still notifies on next version).
- Manual: Settings → 应用版本 → 「检查更新」 (ignores skip list).
- Windows: `plugins.updater.windows.installMode = "basicUi"` so msiexec shows progress + UAC pops normally (default `passive` swallowed UAC silently). `useUpdater.ts` does NOT call `relaunch()` after `downloadAndInstall` — that would spawn a new instance pointing at the OLD exe, file-locking msiexec out of the install dir. msiexec handles its own restart.

### Safety

- **Never lose the private key.** Public key is embedded in shipped app; rotation breaks all installed clients.
- **Never make source repo public** without rotating the unprotected signing key in `secrets/`.
- **Never commit .msi / .sig** — release assets only.
- **Never delete a release users have installed from** — breaks their signature chain for subsequent updates.

## 踩过的坑 (avoid repeating)

- **yt-dlp 没有 `--ffprobe-location` flag**. The flag does NOT exist — passing it makes yt-dlp exit 2 with `no such option: --ffprobe-location`. yt-dlp only has `--ffmpeg-location` and auto-discovers ffprobe by literal name (`ffprobe` / `ffprobe.exe`) in the same directory as the resolved ffmpeg. Our sidecars are renamed to `ffprobe-<triple>{.exe}` by Tauri's externalBin pipeline, so yt-dlp can't find them — bundled ffprobe is currently unreachable. To make it usable: at first run, copy `ffprobe-<triple>` to `<user_data>/sidecar/ffprobe<.exe>` (bare name) and pass `--ffmpeg-location <user_data>/sidecar/`. Note: writing to `Program Files/whatsub/binaries/` requires admin on Windows, hence the user-data detour.

- **yt-dlp default behavior on `&list=...&index=N` URLs is to download the WHOLE playlist**. YouTube's "share" link from inside a playlist always carries `&list=PLxxx&index=N`, which silently turns a single-video import into a playlist crawl: every video gets written into the same `source.mp4` (each overwriting the last) and every thumbnail into the same `thumb.jpg` — visible in the log as `WARNING: Replacing existing file ".../thumb.jpg"` repeated dozens of times. Worse, if any item in the playlist is unavailable (channel terminated, region locked, etc.) the whole batch errors out with `ERROR: [youtube] <id>: Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated.` even when the URL the user pasted is fine. Fix: pass `--no-playlist` always — we never want playlist semantics in this app, the URL identifies a single video.

- **Opus-in-MP4 / VP9-in-MP4 won't play in the in-app `<video>` tag on Mac** (silent black frame, no error, no "play anyway" prompt). Tauri WebView on Mac is WKWebView → AVFoundation, which **hard-rejects** these codec/container combinations. QuickTime is more forgiving (warns "incompatible portions" but plays via software fallback), so Win developers won't notice this — Win Media Foundation also tolerates Opus-in-MP4. Naive yt-dlp format selectors like `bv*[ext=mp4]+ba` pick mp4 video but unconstrained "best audio" — YouTube's DASH default audio is Opus-in-WebM, which yt-dlp then muxes into the requested mp4 container. Fix: format selector must constrain BOTH video (`vcodec^=avc1` for H.264) AND audio (`ext=m4a` for AAC), with progressive fallback chain. As belt-and-suspenders, also pass `--postprocessor-args "Merger:-c:v copy -c:a aac -b:a 192k"` so any audio stream that does fall through gets transcoded to AAC during merge (video stream stays copied, no re-encode cost).

- **Cloudflare Workers from China without VPN: first TCP handshake takes 5-10s** (subsequent connections on the same socket are 500ms). GFW does TCP-level throttling on Cloudflare's edge — not a hard ban, just RST-on-SYN that forces retry until a fallback POP responds. Empirical test from a Chinese ISP: first activation request 6320ms, subsequent calls 460-686ms. **Implication for the LicenseGate:** must use a generous fetch timeout (we use 30s), and the activation modal's spinner copy explicitly says "首次可能需要 10-15 秒" so the user doesn't think the app froze. A 5s timeout would kill many legit first-activations. After activation the desktop app runs fully offline so this only bites once per device.

## Known limitations / TODO

- All OpenAI-compatible vendors share one API-key slot (`settings.openaiCompatible`) — switching DeepSeek ↔ Kimi loses prior key.
- `settings.modelsDir` change does NOT migrate existing `.bin` files in old dir.
- Rust tests pollute real `%APPDATA%/whatsub/` (library / settings tests). Should use temp dir.
- ARM64 Windows / Intel Mac not built.
- ffprobe bundled but yt-dlp can't reach it (triple-suffixed naming) — see 踩过的坑 above. Most YouTube downloads work without ffprobe; fragmented DASH/HLS streams will fail with "ffprobe not found".
- Burn-in export uses libx264 only (no NVENC). ~1–2x realtime CPU; would need a NVENC-enabled ffmpeg build to accelerate.
- Updater endpoint via fastly CDN can lag 5–30 min behind a fresh upload — known GitHub release behavior, no fix on our side.
- Tauri updater plugin doesn't disk-cache downloaded installers across app restarts — `update.downloadAndInstall()` keeps bytes in memory, so cancelling the OS installer + relaunching the app forces a re-download. Splitting into `download()` + `install()` with our own cache layer would fix it but adds ~80 lines of validation logic; not worth the engineering until users complain.

## Quick map

| Task | File |
|------|------|
| Add LLM vendor preset | `src/llm/vendors.ts` |
| Tweak SYSTEM prompt | `src/llm/prompts.ts` |
| Add pipeline phase / progress event | `src-tauri/src/core/progress.rs` + `commands/import.rs` + `components/ImportModal.tsx` |
| Add invoke command | `src-tauri/src/commands/<area>.rs` + register in `lib.rs` |
| Style player controls | `src/components/VideoPlayer.tsx` |
| Vendor / API plumbing | `src/llm/providers/<vendor>.ts` |
| Library card behavior | `src/pages/Library.tsx` |
| Subtitle highlight logic | `src/components/SubtitleList.tsx` |
| Cookies / yt-dlp args | `src-tauri/src/pipeline/ytdlp.rs` |
| Whisper download / transcribe / GPU detection | `src-tauri/src/pipeline/whisper.rs` |
| License gate UI / error states | `src/components/LicenseGate.tsx` |
| License state machine | `src/store/license.ts` |
| Device fingerprint algorithm | `src-tauri/src/commands/license.rs` (function `compute_fingerprint`) |
| Activation endpoint URL | `src/types/license.ts` (constant `ACTIVATE_ENDPOINT`) |
| License server (Hono + pg on Aliyun, separate repo) | [github.com/rjxznb/whatsub-license](https://github.com/rjxznb/whatsub-license) |
| Asset protocol issue (video won't load) | `src-tauri/tauri.conf.json` `assetProtocol.scope` |
| Sidecar permission errors | `src-tauri/capabilities/default.json` `shell:allow-execute.allow` |
| Mac binary build / dylib swap | `.github/workflows/build-mac-binaries.yml` + `tauri.macos.conf.json` |
| Caption overlay rendering / styling | `src/components/CaptionOverlay.tsx` |
| Subtitle edit mode UI / drag-reorder | `src/components/SubtitleList.tsx` (`EditableRow`) + edit mutators in `src/store/analysis.ts` |
| Video burn-in export (ASS / ffmpeg) | `src/utils/ass.ts` + `src/components/ExportVideoModal.tsx` + `src-tauri/src/commands/analysis.rs` (`export_burned_video`, `cancel_export`, `extract_time_field`) |
| Cross-platform release pipeline | `.github/workflows/release.yml` (single-platform via `targets` input; cache-aware; Mac dmg has 3x retry) |
| User-facing error message wording | `src/utils/friendlyError.ts` (yt-dlp / whisper-cli stderr → friendly title + suggestion) |
| Auto-scroll freeze logic | `src/components/SubtitleList.tsx` (`hoveringHighlight` boolean ‖ `interacting` 2s timer; `bumpInteraction()`) |
| Onboarding tier auto-detect / vendor default | `src/components/FirstRunGate.tsx` |
| Whisper SIMD baseline / dmg retry | `.github/workflows/release.yml` (cmake flags + Mac retry loop) |
