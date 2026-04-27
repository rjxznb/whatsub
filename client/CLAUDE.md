# Get Video Client — Architecture

> Tauri 2 desktop app for English subtitle learning. User imports a video
> (local file or URL via yt-dlp), the app extracts audio, runs whisper.cpp
> locally for transcription, then sends the SRT to a user-configured LLM
> (DeepSeek / Claude / Gemini / etc.) for Chinese translation + key-phrase
> highlighting. Player page shows video on the left and a scrolling
> bilingual subtitle list + key phrase tab on the right.

This document is the source of truth for the client's architecture. The
older planning docs in `docs/superpowers/{specs,plans}/` are stale —
prefer this file.

## Tech stack

- **Tauri 2** — Rust core + WebView2 (Edge) on Windows / WKWebView on macOS
- **React 19 + TypeScript + Vite** — frontend
- **Tailwind CSS v3** — styling
- **zustand** — state (per-domain stores)
- **React Router v6** — routing
- **lucide-react** — icons
- **@fontsource/charis-sil** — IPA-friendly font
- **Vitest** — TS unit tests
- External CLI sidecars: `yt-dlp`, `ffmpeg`, `whisper-cli` (whisper.cpp BLAS build)
- LLM SDKs: handwritten SSE parsers per provider (no `openai` / `@anthropic-ai/sdk` JS deps; we own the HTTP)

## Top-level layout

```
client/
├── src-tauri/                     # Rust backend
│   ├── src/                       # See "Rust modules" below
│   ├── binaries/                  # Bundled exe + DLL (gitignored except README)
│   ├── tauri.conf.json            # bundle.externalBin, assetProtocol scope, etc.
│   ├── capabilities/default.json  # Plugin permissions + scoped shell exec
│   ├── build.rs                   # Copies whisper DLLs to target/{debug,release}/
│   └── Cargo.toml
├── src/                           # React frontend (see "Frontend modules")
├── public/
│   ├── data/ipa-en-us.json        # 3 MB offline IPA dict (125k entries)
│   └── help/*.png                 # Cookie-export tutorial screenshots
├── package.json
└── vitest.config.ts
```

## Rust modules (`src-tauri/src/`)

```
lib.rs                   # Tauri Builder: registers plugins + 19 invoke handlers
main.rs                  # tiny entry calling lib::run()
error.rs                 # AppError enum + AppResult<T>; serializes to string for IPC
core/
  paths.rs               # %APPDATA%/Get_Video/ path resolution
                         # video_dir(id) consults library.json's per-entry videoDir first,
                         # then falls back to settings.libraryDir/<id>
  ids.rs                 # video_id generators (sha256 hash, YouTube ID, URL fallback)
  srt.rs                 # SRT parser (whisper-cli output format)
  progress.rs            # PipelineEvent enum + emit() helper
commands/
  settings.rs            # get/save_settings (Value-based, schema-agnostic)
  library.rs             # list / get / upsert / delete / set_status / rename / reorder
                         # / freeze_paths / reveal_in_explorer
  analysis.rs            # save / load_analysis, load_transcript, video_source_path
  models.rs              # whisper_model_status, whisper_model_download
  import.rs              # import_video — orchestrates the entire ingestion pipeline
pipeline/
  spawn.rs               # run_sidecar() — generic spawn + stderr-tail capture for diagnostics
  ytdlp.rs               # URL → source.mp4 + thumb.jpg + info.json; reads cookiesFile from settings
  ffmpeg.rs              # extract_audio_wav (16 kHz mono PCM), extract_thumbnail
  whisper.rs             # transcribe via whisper-cli; model download with .partial → atomic rename
                         # MODEL_URLS use hf-mirror.com (China-friendly)
```

### Tauri config

- `tauri.conf.json`:
  - `bundle.externalBin: ["binaries/yt-dlp", "binaries/ffmpeg", "binaries/whisper-cli"]`
    (Tauri appends target-triple suffix at build time, strips at runtime)
  - `bundle.resources: ["binaries/*.dll"]` (6 whisper.cpp DLLs)
  - `app.security.assetProtocol`: `enable: true`, scope `["$DATA/Get_Video/**", "$LOCALDATA/Get_Video/**", "**/*.mp4", "**/*.jpg", ...]`
- `capabilities/default.json`: `core:default`, `core:window:allow-set-fullscreen`, all plugin defaults, scoped `shell:allow-execute` for the 3 sidecars (`{name: "yt-dlp", sidecar: true, args: true}`)

### Pipeline event stream

`emit("pipeline-event", PipelineEvent)` from Rust; frontend listens via Tauri's event bus.

```
Started{video_id}
  → Downloading{video_id, percent}*    (URL only)
  → ExtractingAudio{video_id}
  → Transcribing{video_id, percent}*
  → Transcribed{video_id, srt_path, duration_sec}
  (Failed{video_id, error} at any step)
ModelDownload{progress, total_mb, downloaded_mb}    (separate; emitted from whisper::download_model)
```

## Frontend modules (`src/`)

```
main.tsx                 # ReactDOM render
App.tsx                  # Router: / → /library; /library, /player/:videoId, /settings
App.css                  # Tailwind directives + dark scrollbar styles + .font-ipa class
                         # @import @fontsource/charis-sil
pages/
  Library.tsx            # Card grid: drag-drop reorder, right-click menu (rename/reveal/delete),
                         # search box with browser-style yellow highlight,
                         # OS file drop → auto-open ImportModal,
                         # status badges (analyzing/failed)
  Player.tsx             # Resizable split (localStorage-persisted %),
                         # left: VideoPlayer; right: tabs [字幕 | 重点短语]
                         # Owns the LLM analysis useEffect with a cancellation token
                         # to prevent StrictMode double-mount from running parallel LLM calls
                         # Self-heals duplicate cues in old analysis.json on load
  Settings.tsx           # VendorSection (vendor preset → auto-fill base URL + model datalist + console link)
                         # SecretField (eye toggle), DirField, FileField (cookies)
                         # Whisper model dropdown + download progress
                         # On libraryDir change: invokes library_freeze_paths first
components/
  VideoPlayer.tsx        # YouTube-style controls (gradient overlay, large buttons, auto-hide while playing,
                         # hover-expand volume, speed dropdown 0.5-2x, panel-toggle button)
                         # Hold ←/→ → 2x boost (uses e.repeat + keyup + blur for safety)
                         # Center play/replay button with hover scale animation
  SubtitleList.tsx       # Auto-scrolls to current cue (useVideoSync); renders English with
                         # HighlightWord-wrapped key phrases AND Chinese with amber-tinted
                         # highlightTranslations spans; loading spinner while LLM streams first cue
  KeyPhraseList.tsx      # Phrase cards: expression (amber) + IPA (Charis SIL, gray) + 🔊 + meaning + usage
                         # Sticky header with voice dropdown (Web Speech API),
                         # warning + collapsible install guide if no English voices on system
  HighlightWord.tsx      # Yellow inline span with hover/click → keyNote tooltip
  ImportModal.tsx        # URL/local tabs; URL has '?' help button with cookies setup screenshots;
                         # while submitting, switches to checklist progress view (spinner per phase + duration hint)
                         # Subscribes to "pipeline-event" for live phase + percent updates
  ContextMenu.tsx        # Floating menu (closes on outside click / Esc)
  RenameDialog.tsx       # Modal text input
  ProgressBanner.tsx     # Top-of-Player banner during analysis (spinner + phase label + count)
  FirstRunGate.tsx       # Welcome screen if no LLM key configured OR Whisper model missing
hooks/
  useTauriEvent.ts       # listen() wrapper with proper cleanup on unmount
  useVideoSync.ts        # rAF loop binding video.currentTime → subtitle index
  useSpeech.ts           # Web Speech API: voices list (with poll fallback for WebView2),
                         # voiceURI persistence, speak() with auto-cancel for previous utterance
store/
  settings.ts            # zustand: settings + load/save; mergeWithDefaults handles partial
                         # legacy files (deep-merge per nested provider object)
  library.ts             # zustand: library list, optimistic reorder + rename, reveal command
  analysis.ts            # zustand: phase, progressPercent, subtitles[], summary, error
                         # appendSubtitle dedupes by (time, endTime, text) — defensive against
                         # parallel runs racing past the cancellation token
                         # Exports dedupSubtitles() helper used at all entry points
llm/
  types.ts               # Subtitle, KeyPhrase, AnalysisResult, SrtCue
  vendors.ts             # 10 vendor presets (DeepSeek/OpenAI/Kimi/智谱/Qwen/SiliconFlow/Ollama/Claude/Gemini/Custom)
                         # Each: id, name, protocol, baseUrl, models[], keyConsoleUrl, note
                         # inferVendorId() reverse-maps legacy settings.json
  prompts.ts             # SYSTEM_PROMPT (JSON Lines schema, all "踩过的坑" rules) +
                         # buildUserPrompt + buildContinuationPrompt (batched continuation)
  parseSrt.ts            # SRT text → SrtCue[] (handles CRLF, hour timecodes)
  batchSubtitles.ts      # Split cues into 50-cue batches
  streamingJson.ts       # JsonLineParser: feed(chunk, onObj) + flush() — tolerates malformed lines
  analyze.ts             # runAnalysis(opts) — orchestrates batches + provider stream + parser
  phonetic.ts            # Lazy-loads /data/ipa-en-us.json once; lookupPhonetic() for word OR
                         # multi-word (looks up each token, joins with spaces; null if any miss)
  providers/
    types.ts             # interface Provider { stream(req): AsyncIterable<string> }
    openaiCompatible.ts  # SSE: data: {choices:[{delta:{content:"..."}}]}
    claude.ts            # SSE: data: {type:"content_block_delta", delta:{type:"text_delta", text:"..."}}
    gemini.ts            # SSE alt mode: data: {candidates:[{content:{parts:[{text:"..."}]}}]}
    index.ts             # getProvider(settings) → switches by settings.llmProvider
types/
  settings.ts            # Settings interface (incl. vendorId, libraryDir, modelsDir, cookiesFile),
                         # DEFAULT_SETTINGS, mergeWithDefaults
  library.ts             # LibraryEntry (incl. videoDir frozen at import), Library, LibrarySource, LibraryStatus
utils/
  time.ts                # formatTime() — seconds to mm:ss / h:mm:ss
```

## Storage layout (`%APPDATA%/Get_Video/` by default)

```
settings.json                # always at default path; never moves
library.json                 # always at default path; never moves
                             # videos[] each store thumbnailPath + videoDir as ABSOLUTE paths
models/ggml-<size>.bin       # default; settings.modelsDir overrides for new downloads
                             # (no migration of old models on path change)
library/<video_id>/          # default; settings.libraryDir overrides for new imports
  source.mp4                 # the actual video file
  audio.wav                  # 16 kHz mono PCM (kept; not auto-deleted)
  transcript.srt             # whisper-cli output
  thumb.jpg                  # first-frame extract (or yt-dlp's converted thumbnail)
  analysis.json              # final LLM output: { subtitles[], keyPhrases[] }
  info.json                  # yt-dlp metadata (URL imports only)
```

`LibraryEntry.videoDir` is **frozen at import time** to the resolved
`library_dir()` path. This means changing `settings.libraryDir` later does not
orphan existing entries — they remember where their files actually are.
`library_freeze_paths` runs before any libraryDir change to fill in `videoDir`
for legacy entries written before this field existed.

## Data flow

### Import (URL or local file)

```
ImportModal.submit()
  └─ invoke('import_video', { sourceKind, sourceValue, whisperModel })
       └─ Rust commands::import:
          1. video_id   = sha256 hash (local) | YouTube ID (URL) | url-hash fallback
          2. out_dir    = paths::video_dir(video_id)   // current library_dir / id
          3. emit Started
          4. URL  → pipeline::ytdlp::download (yt-dlp -f bv*[ext=mp4][height<=720]+ba/best,
                    --cookies if settings.cookiesFile, emits Downloading{percent} from stderr)
             Local→ fs::copy + pipeline::ffmpeg::extract_thumbnail
          5. library_upsert(entry, status=Analyzing, videoDir=out_dir)
          6. emit ExtractingAudio
          7. pipeline::ffmpeg::extract_audio_wav (-ac 1 -ar 16000 -c:a pcm_s16le)
          8. pipeline::whisper::transcribe (whisper-cli -m model -l en -osrt --print-progress;
                                            emits Transcribing{percent} from stderr)
          9. emit Transcribed{srt_path, duration_sec}
          → returns { videoId, srtPath, durationSec }
  └─ Modal closes → navigate(/player/:videoId)
```

### LLM analysis (in Player.tsx mount)

```
Player mount → useEffect with cancellation token:
  1. invoke('load_analysis', {videoId})
     ├─ cached: dedupSubtitles + setSubtitles + setSummary
     │          if dedup count changed: auto-resave cleaned version (self-heal)
     │          phase = "complete"; return
     └─ null: continue
  2. analysis.startFor(videoId)            // clears state
  3. invoke('load_transcript') → SRT
  4. parseSrt(srt) → SrtCue[]
  5. provider = getProvider(settings)
  6. runAnalysis({ provider, cues, onCue, onSummary }):
       for batch of batchSubtitles(cues, 50):
         for chunk of provider.stream({ systemPrompt, userPrompt }):
           parser.feed(chunk, routeObject):
             obj.type === "cue"     → onCue(parsed Subtitle)    → analysis.appendSubtitle
             obj.type === "summary" → onSummary(...)              → analysis.setSummary
  7. invoke('save_analysis', {videoId, finalAnalysis})    // dedupSubtitles before save
     invoke('library_set_status', {id, status: "ready"})
     phase = "complete"
```

The cancellation token (`let cancelled = false; cleanup: cancelled = true`) is
critical — without it, React StrictMode dev double-mount produces parallel LLM
runs that both append, doubling every cue.

### Subtitle rendering

`SubtitleList` walks each `Subtitle.text` left-to-right, splicing `HighlightWord`
spans at each `highlightWords[i]` substring (sorted by position). Same pattern
for the Chinese translation but using `highlightTranslations` values, with
amber-tinted background instead of solid yellow to visually pair with the
English highlight without competing.

`KeyPhraseList` calls `phonetic.lookupPhonetic(expression)` for each phrase on
mount (in parallel via `Promise.all`); IPA is rendered in the Charis SIL font.
Multi-word phrases are looked up by tokens and joined; if ANY token misses,
the entry returns null and is simply not displayed (per UX decision).

## Key design decisions

1. **Rust does subprocess + filesystem; TS does HTTP/LLM**.
   Cleanest separation. Rust can't get prompt-cached HTTP for free; TS can use
   browser fetch + Web Streams. Tauri's `externalBin` handles cross-platform
   binary distribution — sidecar resolution at runtime by basename only
   (`sidecar("yt-dlp")`, NOT `sidecar("binaries/yt-dlp")` — Tauri strips the
   `binaries/` prefix at build time).

2. **External binaries bundled, Whisper model lazy-downloaded**.
   yt-dlp + ffmpeg + whisper-cli + 6 DLLs ship in installer (~280 MB).
   Model downloads on first use from hf-mirror.com with `.partial → fs::rename`
   atomic semantics so interrupted downloads aren't mistaken for complete files.

3. **JSON Lines streaming for LLM output**.
   Each cue arrives as one JSON object on its own line; `JsonLineParser` emits
   them as they arrive → UI streams. The summary object is the LAST line. This
   is robust to model variation (no need for the LLM to produce a final
   well-formed mega-object).

4. **All asset paths absolute in library.json**.
   Combined with `videoDir` frozen per-entry, changing `settings.libraryDir`
   never orphans old entries. Models are simpler (no per-entry storage) and
   the docs warn the user that changing `modelsDir` won't migrate old `.bin`s.

5. **Asset protocol scope**: `$DATA/Get_Video/**` covers the default storage,
   `$LOCALDATA/Get_Video/**` covers the macOS path variant, and the broad
   `**/*.mp4` etc. globs allow custom paths anywhere on disk.

6. **Web Speech API for TTS**. Cross-platform (Windows SAPI / macOS
   NSSpeechSynthesizer), zero deps, fully offline. Not all systems have
   English voices preinstalled — `KeyPhraseList` shows a polite install hint
   when none are detected (Windows users navigate to Settings → Time &
   Language → Speech to add voice packs).

7. **Offline IPA dict (3 MB JSON, 125 k entries)**.
   Bundled to `public/data/ipa-en-us.json`, lazy-loaded on first KeyPhrase tab
   view, cached forever in the renderer process. Lookup is render-time only —
   never stored in `analysis.json` — so old analyses automatically gain IPA
   on next view without LLM re-runs.

8. **Vendor preset layer over the protocol distinction**.
   The 3 internal protocols (`openai-compatible` / `claude` / `gemini`) cover
   the wire format. Above them, `llm/vendors.ts` lists 10 user-facing vendors
   that combine protocol + auto-filled baseUrl + suggested models + key
   console link. Settings UI uses vendor as the primary picker; legacy
   settings.json files get auto-mapped via `inferVendorId()`.

## Build / dev commands

```bash
# Frontend (run from client/)
pnpm install
pnpm tauri dev          # First cargo build is 5-15 min; incremental ~10s
pnpm test               # Vitest, ~20 unit tests
pnpm typecheck          # tsc --noEmit
pnpm tauri build        # Production .msi/.exe → src-tauri/target/release/bundle/

# Rust unit tests (run from client/src-tauri/)
cargo test              # paths, ids, srt, ytdlp, whisper, library, settings
                        # NOTE: library + settings tests pollute real %APPDATA%/Get_Video/
                        #       — known issue, not yet refactored to use temp dir
```

## Release workflow (Tauri auto-updater)

The app self-checks for updates on launch and lets the user install with one
click. Detailed step-by-step in `RELEASE.md`; here's the operational summary.

### Where things live

| Asset | Location |
|---|---|
| **Source code repo** (private) | `github.com/rjxznb/Get_Video` |
| **Release artifact repo** (public, updater endpoint) | `github.com/rjxznb/Get_Video-releases` |
| **Private signing key** (sign every release) | `secrets/eversay-studio.key` (private repo backup) + `~/.tauri/eversay-studio.key` (active local) |
| **Public verification key** (embedded in the app) | `client/src-tauri/tauri.conf.json` → `plugins.updater.pubkey` |
| **Updater endpoint** (URL the app polls) | `https://github.com/rjxznb/Get_Video-releases/releases/latest/download/latest.json` |

The repo is split private/public so the source stays closed but auto-update
artifacts can be served over GitHub's public CDN. **Don't** commit the .msi
or .sig anywhere — they only live as GitHub Release assets on the public repo.

### Per-release checklist

1. **Bump version in 3 places** (must match):
   - `client/package.json` `"version"`
   - `client/src-tauri/tauri.conf.json` `"version"`
   - `client/src-tauri/Cargo.toml` `[package] version`

2. **Build with signing** (Git Bash):
   ```bash
   cd client
   TAURI_SIGNING_PRIVATE_KEY="$(cat $USERPROFILE/.tauri/eversay-studio.key)" \
   TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
   pnpm tauri build --bundles msi
   ```
   The `--bundles msi` flag skips NSIS (whose download often times out from
   China). Output:
   ```
   src-tauri/target/release/bundle/msi/Eversay Studio_X.Y.Z_x64_en-US.msi
   src-tauri/target/release/bundle/msi/Eversay Studio_X.Y.Z_x64_en-US.msi.sig
   ```

3. **Hand-author `latest.json`** — Tauri does NOT generate this automatically;
   you write it. Template:
   ```json
   {
     "version": "X.Y.Z",
     "notes": "user-facing notes shown in the toast",
     "pub_date": "2026-04-28T10:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<paste full content of .msi.sig>",
         "url": "https://github.com/rjxznb/Get_Video-releases/releases/download/vX.Y.Z/Eversay.Studio_X.Y.Z_x64_en-US.msi"
       }
     }
   }
   ```
   Note the .msi URL uses dots not spaces — GitHub mangles spaces to dots in
   asset URLs. Either rename the .msi before upload, or write the URL with
   the actual asset URL after upload.

4. **Cut the GitHub Release** via `gh`:
   ```bash
   gh release create vX.Y.Z \
     --repo rjxznb/Get_Video-releases \
     --title "Eversay Studio vX.Y.Z" \
     --notes "Brief release notes here" \
     "src-tauri/target/release/bundle/msi/Eversay Studio_X.Y.Z_x64_en-US.msi" \
     "src-tauri/target/release/bundle/msi/Eversay Studio_X.Y.Z_x64_en-US.msi.sig" \
     latest.json
   ```

5. **Verify** the manifest is reachable:
   ```bash
   curl https://github.com/rjxznb/Get_Video-releases/releases/latest/download/latest.json
   ```
   Should print the JSON. If 404, re-check the release was published (not draft)
   and `latest.json` is named exactly that.

6. **Test the upgrade flow** on a machine with the previous version installed:
   restart the app, the bottom-right toast should appear within ~3 seconds.

### How users experience updates

- **Auto-check on every launch** (3 s after window opens; silently fails on
  network issues)
- **Toast at bottom-right** if a newer version is found, with three actions:
  - "立即更新" → download + verify signature + install + auto-restart
  - "稍后" → dismisses for this session only
  - "✓ 不再提醒此版本" → permanently silences for THIS specific version
    (still notifies for the *next* version)
- **Manual trigger**: Settings page → 应用版本 → 「检查更新」 button (ignores
  the skipped-version list)
- "Skipped versions" persisted in `localStorage["skippedUpdateVersions"]`

### Key safety / what to NOT do

- **NEVER lose the private key.** Embedded public key in the shipped app is
  fixed; if you re-generate keys, all existing installs stop accepting your
  updates and need manual reinstall. Backup at `secrets/eversay-studio.key`
  (in the private repo) covers drive failure on the dev machine.
- **NEVER make the source repo public** unless you also rotate the signing
  key (it's currently stored without password protection in `secrets/`).
- **NEVER commit .msi or .sig files** to the source repo — they're release
  assets only. Add to `.gitignore` if Cargo accidentally produces them under
  a tracked path (currently `client/src-tauri/target/` is ignored, so safe).
- **NEVER delete a release** users may have already installed from — they'll
  get errors trying to verify signatures of subsequent updates if the chain
  breaks. Only delete pre-release / draft releases that nobody downloaded.

## Known limitations / TODO

- **All OpenAI-compatible vendors share one API-key slot** in
  `settings.openaiCompatible` — switching DeepSeek ↔ Kimi loses the previous
  key. Per-vendor key storage is a pending refactor.
- **`settings.modelsDir` change does not migrate old models**. Unlike video
  entries (which freeze their dir per-entry), models are keyed only by size,
  so changing the dir loses sight of any pre-existing `.bin` files in the old
  dir. User must manually copy or re-download.
- **Linux / macOS not yet built**. Code is cross-platform but
  `src-tauri/binaries/` only contains Windows x64 binaries. Producing a Mac
  build needs the same 3 binaries with `-x86_64-apple-darwin` (or `aarch64-`)
  suffixes acquired separately.
- **Rust unit tests pollute real `%APPDATA%/Get_Video/`** — `commands/library.rs`
  and `commands/settings.rs` tests write to the actual path. Should use a
  temp dir (env override pattern). Currently when running `cargo test`, the
  user's real settings.json gets overwritten with stub data.
- **No video re-analysis UI** — to re-run LLM on a video with a different
  prompt or LLM, the user must manually delete its `analysis.json` from disk
  before re-opening. A "重新解析" context-menu item would be nice.

## Quick map: where to look when

| Task | File |
|---|---|
| Add a new LLM vendor preset | `src/llm/vendors.ts` |
| Tweak the SYSTEM prompt | `src/llm/prompts.ts` |
| Add a new pipeline phase / progress event | `src-tauri/src/core/progress.rs` + `src-tauri/src/commands/import.rs` + `src/components/ImportModal.tsx` (UI checklist) |
| Add a new invoke command | `src-tauri/src/commands/<area>.rs` + register in `lib.rs` invoke_handler |
| Style the player controls | `src/components/VideoPlayer.tsx` |
| Adjust vendor / API plumbing | `src/llm/providers/<provider>.ts` |
| Library card behavior | `src/pages/Library.tsx` |
| Subtitle highlighting logic | `src/components/SubtitleList.tsx` |
| Cookies / yt-dlp args | `src-tauri/src/pipeline/ytdlp.rs` |
| Whisper download / transcribe | `src-tauri/src/pipeline/whisper.rs` |
| Asset protocol issue (video won't load) | `src-tauri/tauri.conf.json` `app.security.assetProtocol.scope` |
| Sidecar permission errors | `src-tauri/capabilities/default.json` `shell:allow-execute.allow` |
