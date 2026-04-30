# Get Video Client — Architecture

Tauri 2 desktop app for English subtitle learning. Pipeline: import (yt-dlp / local) → ffmpeg audio extract → whisper.cpp transcribe → user-configured LLM (DeepSeek / Claude / Gemini / etc.) for Chinese translation + key-phrase highlighting → bilingual player.

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
| `core/paths.rs` | `%APPDATA%/Get_Video/` resolution. `video_dir(id)` consults library.json's per-entry `videoDir` first (frozen at import). Adds `vocabulary_path()` |
| `core/ids.rs` | sha256 / YouTube ID / URL hash for `video_id` |
| `core/srt.rs` | SRT parser |
| `core/progress.rs` | `PipelineEvent` enum + `emit()`. Variants: Started, Downloading, ExtractingAudio, Transcribing, Transcribed, Failed, ModelDownload, Log, **BackendDetected** |
| `commands/settings.rs` | `get/save_settings` (Value-based; schema-agnostic) |
| `commands/library.rs` | list/get/upsert/delete/set_status/rename/reorder/freeze_paths/reveal_in_explorer |
| `commands/analysis.rs` | save/load_analysis, load_transcript, video_source_path, **write_text_file** (used for SRT/CSV export) |
| `commands/vocabulary.rs` | `vocab_list/add/remove`. Storage: `vocabulary.json` at app data root. Dedupe by id = `expression.toLowerCase().trim()` |
| `commands/models.rs` | whisper_model_status / download |
| `commands/import.rs` | `import_video` orchestrator |
| `pipeline/spawn.rs` | `run_sidecar()` — spawn + stderr tail for error diagnostics |
| `pipeline/ytdlp.rs` | URL → source.mp4 + thumb.jpg + info.json (reads `cookiesFile` from settings) |
| `pipeline/ffmpeg.rs` | extract_audio_wav (16 kHz mono PCM), extract_thumbnail |
| `pipeline/whisper.rs` | transcribe via whisper-cli; model download (`.partial` → atomic rename, hf-mirror.com URLs); parses `ggml_<backend>: 0 = <name>` to emit `BackendDetected` |

### Tauri config

- `tauri.conf.json` (base / Windows): `externalBin` lists the 3 sidecar basenames; `bundle.resources` ships the Vulkan whisper DLLs; assetProtocol scope = `$DATA/Get_Video/**`, `$LOCALDATA/Get_Video/**`, `**/*.{mp4,jpg,...}`.
- `tauri.macos.conf.json` (overlay): `bundle.macOS.frameworks` lists the 6 dylibs whisper-cli @rpaths against (`libwhisper.1.dylib`, `libggml.0.dylib`, `libggml-{base,blas,cpu,metal}.0.dylib`).
- `capabilities/default.json`: scoped `shell:allow-execute` per sidecar.

### Pipeline event stream

`emit("pipeline-event", PipelineEvent)`. Frontend listens via Tauri's event bus.

```
Started{video_id} → Downloading{percent}* → ExtractingAudio → Transcribing{percent}*
  → Transcribed{srt_path, duration_sec}        (Failed{error} at any step)
ModelDownload{progress, total_mb, downloaded_mb}    (model fetch, separate stream)
BackendDetected{name}                                (once per transcribe; persisted into settings)
```

## whisper.cpp build

| Platform | Backend | DLLs / dylibs in `binaries/` |
|----------|---------|------------------------------|
| Windows x64 | **Vulkan** + CPU fallback | `whisper-cli.exe`, `whisper.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml-vulkan.dll` |
| macOS arm64 | **Metal** + CPU fallback | `whisper-cli`, `libwhisper.1.dylib`, `libggml.0.dylib`, `libggml-{base,blas,cpu,metal}.0.dylib` (Metal shaders embedded into libggml-metal — no separate `.metallib` since whisper.cpp v1.7+) |

Built from whisper.cpp v1.8.4. Windows: locally with VS 2022 + Vulkan SDK 1.4.341 + cmake `-DGGML_VULKAN=ON`. macOS: GitHub Actions `macos-14` runner, see `.github/workflows/build-mac-binaries.yml` (manually triggered when bumping whisper.cpp). Mac dylibs are install_name_tool'd to `@loader_path/...` and ad-hoc codesigned.

`pipeline/whisper.rs` parses the first `ggml_<backend>: 0 = <gpu name>` stderr line to recognize the active accelerator (`Vulkan / NVIDIA RTX 4090`, `Metal / Apple M2 Pro`, etc.) and emits `BackendDetected` once per run. CPU-only fallback case explicitly emits `BackendDetected{ name: "CPU" }`.

## Frontend modules (`src/`)

| File | Notes |
|------|------|
| `App.tsx` | Routes (/library, /player/:id, /vocab, /settings); mounts `BackendListener` at root |
| `pages/Library.tsx` | Card grid; drag-drop reorder; right-click menu; OS file drop → ImportModal; status badges; header has ⭐ vocab + ⚙ settings links |
| `pages/Player.tsx` | Resizable split (localStorage %); left video, right tabs `[字幕 \| 重点短语]`. Owns LLM analysis effect with AbortController + StrictMode dedup. Reads `?t=<sec>` deep-link and seeks on `loadedmetadata`. Throttled partial-save of analysis.json every 800 ms while streaming. SRT export (en/zh/both) via save dialog + `write_text_file` |
| `pages/Settings.tsx` | VendorSection (preset → autofill base URL); SecretField/DirField/FileField; Whisper model dropdown + download progress; **GPU 加速 status** (read from `whisperBackend`) |
| `pages/Vocab.tsx` | Sort modes (按视频/最近/最早/字母); flat or grouped view; CSV export via `write_text_file` (RFC4180 escape + BOM); per-entry deep link to `/player/:id?t=<cueTime>` |
| `components/VideoPlayer.tsx` | YouTube-like controls; hold ←/→ = 2x boost; speed 0.5–2x; panel toggle |
| `components/SubtitleList.tsx` | Auto-scroll to current cue; **freeze on highlight hover** (event delegation on `[data-highlight="true"]`); freeze ~2s on user wheel/touch/keyboard |
| `components/KeyPhraseList.tsx` | Phrase cards (amber expr + IPA + 🔊 + ⭐ + meaning + usage); voice dropdown; install hint if no English voices; resolves first source cue per phrase to seed StarButton's deep-link |
| `components/HighlightWord.tsx` | Inline yellow span with `data-highlight="true"`; hover/click → keyNote tooltip |
| `components/StarButton.tsx` | Toggle (filled/outlined) — calls `useVocabulary.toggle(...)` |
| `components/ImportModal.tsx` | URL/local tabs; live phase checklist via `pipeline-event` |
| `components/ProgressBanner.tsx` | Phases: downloading/extracting/transcribing/analyzing/**paused**/error. **停止/继续** buttons (paused). Calls Player's onStop/onContinue |
| `components/FirstRunGate.tsx` | Welcome if no LLM key OR Whisper model |
| `hooks/useTauriEvent.ts` | `listen()` wrapper with cleanup |
| `hooks/useVideoSync.ts` | rAF binding video.currentTime → cue index |
| `hooks/useSpeech.ts` | Web Speech API; voice persistence; auto-cancel on new utterance |
| `store/settings.ts` | Settings + load/save; deep merge for partial legacy files |
| `store/library.ts` | Library list + optimistic reorder/rename |
| `store/analysis.ts` | phase, progressPercent, subtitles[], summary, error. `appendSubtitle` dedupes by `(time, endTime, text)`. Includes `paused` phase + cue edit ops (update/delete/insert/reorder) |
| `store/vocab.ts` | entries[], reload/add/remove/toggle/has |
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

## Storage layout (`%APPDATA%/Get_Video/` on Windows, `~/Library/Application Support/Get_Video/` on macOS)

```
settings.json              # always at default path
library.json               # always at default path; videos[] include absolute thumbnailPath + videoDir
vocabulary.json            # ⭐ saved phrases (cross-video)
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
6. **Asset protocol scope:** `$DATA/Get_Video/**` covers Windows + macOS defaults; `$LOCALDATA/Get_Video/**` covers macOS variant; `**/*.mp4` etc. allow custom paths.
7. **Web Speech API for TTS.** Cross-platform, zero deps. Hint shown if no English voices installed (Windows users → 时间和语言 → 语音 → 添加).
8. **Offline IPA dict (3 MB JSON, 125k entries).** Lazy-loaded on first KeyPhrase view; cached forever in renderer. Render-time only — never stored in `analysis.json`, so old analyses gain IPA without re-running LLM.
9. **Vendor preset layer over protocol.** 3 internal protocols (`openai-compatible` / `claude` / `gemini`) cover wire format; 10 user-facing vendors (`llm/vendors.ts`) combine protocol + preset baseUrl + suggested models + console link. `inferVendorId()` reverse-maps legacy settings.json.
10. **Vocabulary deep links + sort modes.** Star saves cue context (cueTime + cueText). Vocab page sort: 按视频分组 / 最近 / 最早 / 字母. Click vocab entry → `/player/:id?t=<sec>` → seek video.
11. **Tauri 2 platform overlay** (`tauri.macos.conf.json`) keeps Mac config (frameworks list) out of the base file so Windows builds don't reference missing dylibs.

## Build / dev

```bash
# Frontend (run from client/)
pnpm install
pnpm tauri dev          # First cargo build 5–15 min; incremental ~10s
pnpm test               # Vitest, ~23 unit tests
pnpm typecheck          # tsc --noEmit
pnpm tauri build        # → src-tauri/target/release/bundle/

# Rust unit tests (from src-tauri/)
cargo test              # paths, ids, srt, ytdlp, whisper, library, settings
                        # NB: library + settings tests pollute real %APPDATA%/Get_Video/
```

> Dev mode: Tauri puts sidecars at `target/debug/<basename>.exe` (no triple). If you delete those during cleanup, dev spawn fails with `os error 2 (file not found)` — copy them back from `binaries/` or rebuild.

## Release workflow

Two repos: source `rjxznb/Get_Video` (private), release artifacts `rjxznb/Get_Video-releases` (public). Updater endpoint: `https://github.com/rjxznb/Get_Video-releases/releases/latest/download/latest.json`. Private signing key at `~/.tauri/eversay-studio.key` (also `secrets/eversay-studio.key` in private repo for backup). Public key embedded in `tauri.conf.json` `plugins.updater.pubkey`.

### Per-release checklist

1. Bump version in 3 places: `client/package.json`, `client/src-tauri/tauri.conf.json`, `client/src-tauri/Cargo.toml` (must match).
2. Build (Git Bash):
   ```bash
   cd client
   TAURI_SIGNING_PRIVATE_KEY="$(cat $USERPROFILE/.tauri/eversay-studio.key)" \
   TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
   pnpm tauri build --bundles msi
   ```
   Output: `src-tauri/target/release/bundle/msi/Eversay Studio_X.Y.Z_x64_en-US.msi` + `.sig`.
3. Hand-author `latest.json` (Tauri does NOT generate). Template:
   ```json
   {"version":"X.Y.Z","notes":"...","pub_date":"2026-04-30T...","platforms":{
     "windows-x86_64":{"signature":"<paste .sig content>","url":"https://github.com/rjxznb/Get_Video-releases/releases/download/vX.Y.Z/Eversay.Studio_X.Y.Z_x64_en-US.msi"}}}
   ```
   Note: GitHub asset URLs replace spaces with dots — write the URL post-upload.
4. `gh release create vX.Y.Z --repo rjxznb/Get_Video-releases ...` with the .msi, .sig, and latest.json.
5. Verify: `curl <updater endpoint>` returns the JSON.
6. Test upgrade flow on a machine with prior version installed.

### macOS release path

`macos-14` GitHub Actions runner builds whisper.cpp Metal binaries via `.github/workflows/build-mac-binaries.yml` (manual `workflow_dispatch`; ~6 min on private repo, costs ~60 min from 2000 min/month quota). Future Phase 3 workflow will add tag-triggered `pnpm tauri build --bundles dmg,app` + minisign + GitHub Release upload. **No Apple Developer account / no notarization** — first-launch users hit Gatekeeper "已损坏" and must do System Settings → 隐私与安全性 → 仍要打开 (or `xattr -cr <app>`). README documents the 5-step bypass.

### User-facing update behavior

- Auto-check on launch (3s after window opens, silent on network fail).
- Bottom-right toast if newer version found: 「立即更新」 (download + verify + install + restart) / 「稍后」 (session-only) / 「✓ 不再提醒此版本」 (persists in `localStorage["skippedUpdateVersions"]`; still notifies on next version).
- Manual: Settings → 应用版本 → 「检查更新」 (ignores skip list).

### Safety

- **Never lose the private key.** Public key is embedded in shipped app; rotation breaks all installed clients.
- **Never make source repo public** without rotating the unprotected signing key in `secrets/`.
- **Never commit .msi / .sig** — release assets only.
- **Never delete a release users have installed from** — breaks their signature chain for subsequent updates.

## Known limitations / TODO

- All OpenAI-compatible vendors share one API-key slot (`settings.openaiCompatible`) — switching DeepSeek ↔ Kimi loses prior key.
- `settings.modelsDir` change does NOT migrate existing `.bin` files in old dir.
- Mac release pipeline (Phase 3) not yet wired — `build-mac-binaries.yml` produces sidecar artifacts but full `.app` / `.dmg` build + signed update json not done.
- Rust tests pollute real `%APPDATA%/Get_Video/` (library / settings tests). Should use temp dir.
- ARM64 Windows / Intel Mac not built.

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
| Asset protocol issue (video won't load) | `src-tauri/tauri.conf.json` `assetProtocol.scope` |
| Sidecar permission errors | `src-tauri/capabilities/default.json` `shell:allow-execute.allow` |
| Mac binary build / dylib swap | `.github/workflows/build-mac-binaries.yml` + `tauri.macos.conf.json` |
