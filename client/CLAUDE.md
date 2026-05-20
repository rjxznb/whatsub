# Get Video Client — Architecture

Tauri 2 desktop app for English subtitle learning. Pipeline: import (yt-dlp / local) → ffmpeg audio extract → whisper.cpp transcribe → user-configured LLM (DeepSeek / Claude / Gemini / etc.) for Chinese translation + key-phrase highlighting → bilingual player.

**Companion repo:** [`rjxznb/whatsub-license`](https://github.com/rjxznb/whatsub-license) (private) — Hono + node-postgres on the existing Eversay Aliyun ECS at `https://whatsub.eversay.cc`. Desktop POSTs once to `/api/license/activate`, then runs fully offline. Migrated 2026-05-09 from Cloudflare Workers + D1 (mainland latency 5–10s → <200ms).

## Stack

Tauri 2 · React 19 + TS + Vite · Tailwind v3 · zustand · React Router v6 · lucide-react · framer-motion (Library reorder FLIP) · @fontsource/charis-sil · Vitest. Sidecars: `yt-dlp`, `ffmpeg`, `whisper-cli`, `node`. LLM HTTP is hand-rolled SSE per provider (no vendor SDKs). License + trial + corpus HTTP runs in Rust via `reqwest` (NOT WebView fetch — see 踩过的坑). Tag-chip browse cache uses `tauri-plugin-store` (LazyStore). Bridge module (`bridge/`) was deleted 2026-05-18 — plugin + desktop now both talk to `whatsub-license` directly; no localhost peer-to-peer sync.

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

`library.json` schema (since 2026-05-20): `{ videos: LibraryEntry[], folders: LibraryFolder[], topLevelOrder: LibraryItemRef[] }`. The legacy `{ videos: [...] }` shape auto-upgrades on first read (Rust `read_index` synthesises `topLevelOrder` from `videos` when missing). Folders are virtual — no filesystem analog; `folder.videoIds` references entries by id and a video at the top level appears as `{type: "video", id}` in `topLevelOrder`. See "Library folders + drag-to-merge" below.

`settings.json` new caption-style fields (2026-05-20): `captionFontColor` / `captionFontScale` / `captionFontOpacity` / `captionBackgroundColor` / `captionBackgroundOpacity` / `captionHighlightsEnabled`. All optional, defaults applied via `mergeWithDefaults` so old settings.json files keep working. Caption box X/Y offset (drag-to-move) is **deliberately NOT persisted** — every Player remount starts at (0,0), see "Caption style menu + draggable overlay" below.

## Pipeline event stream

`emit("pipeline-event", PipelineEvent)`. Variants in `core/progress.rs`. Per-import sequence:

```
Started → Preparing{step}* → Downloading{percent}* → ExtractingAudio
        → Transcribing{percent}* → BackendDetected (once) → Transcribed
        (Failed at any step)
```

`Preparing{step}` fires once per detected yt-dlp stderr phase transition, mapping a stable `step` ID to a Chinese UI label (`fetching-webpage` → 获取视频信息, `fetching-player` → 获取播放器, `solving-signature` → 解算签名 (常是最慢的一步), `fetching-manifest` → 获取清晰度列表, `format-selected` → 格式已选). Each step also gets a redundant `Log` entry "准备中 → <label>" so users with the log panel open see the same trace even if the UI sub-label rendering breaks. Detection in `pipeline/ytdlp.rs::detect_prepare_step` — pattern-matches on `[youtube]` / `[info]` lines.

Side streams: `ModelDownload` (model fetch), `Exporting → Exported` (burn-in), `Log` (raw stderr passthrough to UI's log scroller; also used by Rust to inject `[whatsub] ...` lifecycle markers like "启动 yt-dlp" before spawn).

## Key architecture decisions

- **Rust does subprocess + filesystem; TS does HTTP/LLM.** TS gets browser fetch + Web Streams; Tauri's externalBin handles binary distribution.
- **JSON Lines streaming for LLM output.** Each cue arrives as one line → UI streams cue-by-cue. Two-phase analysis: phase 1 = per-batch cues; phase 2 = single global summary across ALL cues (sees the whole transcript, not just last batch).
- **Cancellation = AbortController.** Stop button aborts → phase=paused → partial save persists. Continue resumes from `subtitles.length` with `previouslyAnalyzed` so the summary phase still sees the full transcript.
- **Vendor preset layer over protocol.** 3 internal protocols (`openai-compatible` / `claude` / `gemini`) cover wire format; 10 user-facing vendors combine protocol + preset baseUrl + suggested models. `inferVendorId()` reverse-maps legacy settings.
- **Offline IPA dict (3 MB, 125k entries).** Render-time only — never stored in `analysis.json`, so old analyses gain IPA without re-running the LLM.
- **License gate is one-time, online only at activation; pure offline forever after.** No periodic verification, no JWT — just a presence check on `license.json`. Trade-offs: refunds not supported (sold as 数字商品), cracking the local file is trivial. The protection is the one-time `/activate` call enforcing the 3-device limit per key. Fingerprint = `sha256(machine_uid || ":whatsub:v1")`. `ACTIVATE_ENDPOINT` is hard-coded into the binary so settings can't redirect it.
- **24h trial mode (TRIAL_ACTIVE).** First launch with no license: POST `/api/license/trial/start` returns `expiresAt` (server-authoritative — same fingerprint always gets the SAME expiresAt, so wiping `trial.json` doesn't farm new trials). App fully usable but `TrialBanner` countdown at top; banner's 「激活完整版」 button flips `mode: TRIAL_ACTIVE → NEEDS_KEY`. `LicenseGate.resumeTrial()` action can flip back if user hits the activation page by accident and trial is still valid.
- **License + trial HTTP runs in Rust, NOT WebView fetch.** Both endpoints (`license_activate_http` / `license_trial_start_http` in `commands/license.rs`) wrap `reqwest::Client::builder().timeout(30s)` and POST from native side, bypassing WebView2's network stack quirks (CSP/CORS/cert chain/antivirus SSL inspection that all surface as a useless `TypeError: Failed to fetch`). On error, Rust returns prefixed strings (`timeout:` / `connect:` / `tls:` / `http <N>:`) which `store/license.ts::friendlyNetworkMessage()` maps to actionable Chinese copy.

## License-key → session auto-login

Desktop never asks the user for an email/OTP. `LicenseSessionGate` (mounted once at app root) fires-and-forgets `useAuth.authFromLicense(licenseKey)` on mount — Rust command `auth_from_license` (commands/auth.rs) POSTs `/api/auth/from-license` with the user's already-activated license key, gets back a 30-day sessionToken, persists to `app_data_dir/auth.json`. Subsequent corpus calls (`corpus_browse` / `corpus_mine` / `corpus_tags` / `corpus_phrase_detail` / `corpus_versions`) attach the bearer.

`LicenseSessionGate` is **non-blocking by design** — if the server call fails or the user is offline, the app still renders normally (library, vocab, player, settings all work). Only the `/corpus` page reads `useAuth.status` and shows a 「云端未连接 + 重试」 inline UI when the session isn't ready. The gate is purely an initializer; it never gates the rest of the app behind a full-screen blocker.

## Corpus page — multi-tag chip browse

`/corpus` (`pages/Corpus.tsx`) replaces the older fixed-18-scene tree with a flat multi-tag chip model that mirrors the server's `tags.list[]` storage.

Layout:
```
[← Library | 语料库 | ↻]
[公共 / 我的]                              (tab strip)
[chip1] [chip2] [chip3] ... [清除(N)]      (tag chip wrap, scope-aware)
[phrase list]      | [phrase detail + YouTube embed + 例句出处]
```

- `CorpusTagChips` pulls tags from `useCorpusTags(scope)` which invokes `corpus_tags` Rust command (which calls `/api/corpus/tags?scope=public|mine`). 18 official scenes are pinned in canonical order, custom tags after a divider. Multi-select AND.
- `useCorpusList(scope)` SWR-style cache: reads server version via `corpus_versions`, compares to `tauri-plugin-store`-cached version, refetches only when stale. Scope = `{mode: 'mine'|'browse', tags: string[]}` — tags array participates in cache key so each filter combo caches separately.
- `CorpusPhraseList` shows row title + meaning + inline tag chips per row.
- `CorpusPhraseDetail` shows `📚 公共例句出处` + `⭐ 我的例句出处` lists. Each instance has a clickable `▶ MM:SS` button (resolved via `instance.source.timestampSec ?? parseYouTubeUrl(url).startSec`) that re-seeks the embedded YouTube iframe.
- `YouTubeEmbed` uses `youtube-nocookie.com/embed/...` (Tracking Prevention bypass) + `allow="encrypted-media; picture-in-picture; clipboard-write"`. No autoplay — WebView2 blocks unmuted autoplay by default and the failed-load leaves the iframe blank.

Cache storage: `corpus_cache.json` via `tauri-plugin-store` LazyStore (see `lib/corpusCache.ts`). Two version keys (`mineVersion`, `publicVersion`) + per-scope data keys (`mineData:tag,sig` / `publicData:tag,sig`). Refresh button invalidates everything + bumps a render key so all children remount.

### `/api/corpus/lookup?withScope=true` field shape

Server (since 2026-05-20) returns `{ phrase: { meaning_zh, usage_note, tags: {list} }, publicContributions, personalContributions }`. Three things to know:

1. **`meaning_zh` / `usage_note` fall back to caller's own contribution** when no `whatsub-curator` row exists. Aggregation in `aggregatePhraseViewWithPersonal()` in `whatsub-license/src/routes/corpus.ts`. Curator wins; caller's newest-non-null is the fallback. This is what lets users see their own saved meaning + usage note in the detail panel before a curator publishes anything.
2. **`tags` wraps as `{list}`** to match the corpus_contributions JSONB shape (was a bare array under legacy `aggregateCuratorView`). The desktop client's `phraseTagList()` accepts both shapes.
3. **`personalContributions` is now caller-scoped** (filtered by `contributor_id === deriveContributorId(session.email)`). Earlier "non-curator" filter included everyone else's rows under the user's `⭐ 我的例句出处` header — that was a privacy leak; the user could read other users' saved notes.

Client-side Rust struct `BrowseItem` uses `usage_note ↔ usageNote` serde mapping (was `key_notes ↔ keyNotes`; column was renamed in the 2026-05-20 schema migration). The TS side reads `phrase.usageNote`. UI label stays 「📝 重点笔记」 — same intent.

### `/api/corpus/versions` `public` field

The route now returns `{ mine, public }` — `mine = MAX(contributed_at) WHERE contributor_id = <caller>`, `public = MAX(contributed_at) WHERE contributor_id = 'whatsub-curator'`. Both bump on hide-no-longer or hide-resurrect because `MAX` recomputes from the current visible set. The desktop's `useCorpusList` cache compares for equality and refetches on any mismatch, so a downward bump is still a consistent signal.

Pre-Plan-D server builds returned only `{ mine }`. Both Rust (`#[serde(default)] public: i64`) and TS (`public?: number`) tolerate missing field — fall to 0, public cache check never short-circuits, browse always refetches. No UX regression, just no caching benefit for browse until server is upgraded.

## Library folders + drag-to-merge

`pages/Library.tsx` renders single-level folders via `library.topLevelOrder` instead of a flat `library.videos.filter()`. Drag-to-merge UX:

- Drag video A onto another video B with **overlap ≥ 0.85** → merge into a new folder. Threshold lives in `utils/overlap.ts::MERGE_THRESHOLD` (was 0.9 originally, briefly 0.7, settled at 0.85 — 0.7 made every reasonable drop into a merge, 0.9 required bullseye precision).
- Drop with overlap < 0.85 → reorder. The grid renders an `effectiveOrder` computed by `useMemo` — source is inserted at the hover target's index in `library.topLevelOrder` — so the user sees a live preview of where the dragged card will land.
- Drop on a folder card with overlap ≥ 0.85 → add the video to that folder.
- Folder source can never merge — `resolveDropMode(folder→*)` always returns reorder. Folders can be rearranged at the top level but not nested.

**FLIP-style smooth reorder preview** uses `framer-motion`'s `<motion.div layout>`. Each card in the topLevelOrder branch is wrapped — when `effectiveOrder` changes, `layout` measures rect-before / rect-after and animates the transform difference with a spring (stiffness 350, damping 30). Search-mode rendering is unwrapped (filter-driven, doesn't reorder).

**Folder open uses an iPad-style modal** (`components/FolderOpenView.tsx`). Click captures the card's `getBoundingClientRect()`; the modal mounts at that rect and transitions `transform: scale + translate` to a centered (80vw × 75vh) target over 300ms ease-out. Esc / backdrop-click reverses the animation.

**Merge animation** (`components/MergeAnimationLayer.tsx`): on a merge drop, two thumbnail clones fly toward the midpoint (300ms), a blue Apple-Finder-style folder pops with bounce (250ms), clones fade (200ms). After 750ms the layer calls `mergeIntoFolder([target, source])` server-side then opens the rename dialog seeded with "新建文件夹".

Rust side (`src-tauri/src/commands/library.rs`) — pure in-memory helpers `create_folder_in_memory` / `delete_folder_in_memory` / `rename_folder_in_memory` / `move_video_to_folder_in_memory` / `merge_into_folder_in_memory` / `set_top_level_order_in_memory`, all callable from tests with a `&mut Library`. The `library_*` Tauri commands are thin `read_index → helper(...)? → write_index` wrappers. Error propagation uses `From<String> for AppError` (no `AppError::Internal` variant exists). ID generation is `sha256(now_secs || now_nanos)[..10]` — no `rand` crate dependency (intentional; existing deps only).

## Caption style menu + draggable overlay

Player gear button opens a 3-view menu (`pages/VideoPlayer.tsx` `menuView` state: `null | "root" | "speed" | "captions" | "captions.*"`):

- **root**: 「播放速度」 + 「字幕设置」 rows.
- **speed**: existing playback-speed list (Check icon ✓ marks selection — unified with captions).
- **captions**: row-list YouTube-style. Each row drills into a deep submenu (`captions.fontColor` / `captions.fontScale` / `captions.fontOpacity` / `captions.highlights` / `captions.bgColor` / `captions.bgOpacity`). 8-color palette uses Chinese labels (白色 / 黄色 / 青色 / 绿色 / 蓝色 / 品红色 / 红色 / 黑色). Picking an option does NOT auto-back — user stays in the deep view to compare. Back arrow at the top returns to captions level. Bottom has a 「重置字幕设置」 button that patches all 6 fields to defaults in one call.

Menu container: `w-[280px] bg-zinc-900/30 backdrop-blur-2xl`. Gear icon rotates 30° via `transition-transform` while menu is open.

**`CaptionOverlay` is draggable** — `mousedown` on the box starts a transient drag (local `dragDelta` useState), `mousemove` updates the visible `transform: translate(dx, dy)`, `mouseup` calls `onPositionChange(x, y)` → Player.tsx sets local `captionOffset` state. **Position is session-only, NOT persisted to settings** — every fresh Player mount resets to (0, 0). This was a deliberate UX choice; the user originally asked for persistence then asked for per-video reset.

**`backdrop-blur-sm` is conditional on `bgOpacity > 0`** — the blur filter is independent of bg-color alpha. At 0% background opacity the user expects the video to show through crisply; if blur stayed on, the picture behind the caption looked "as if through a lens". Toggle the class off when opacity is 0.

## Library progress-bar hover thumbnail

YouTube-style scrubber preview in `components/VideoPlayer.tsx`. A hidden `<video>` element (separate ref, same `src` as the main player) lives above the progress bar with `display: none` until hover. On mouse-move over the progress bar, a `requestAnimationFrame`-throttled `useEffect` syncs the preview video's `currentTime` to the hovered timestamp. Render size 160×90 px (`w-40 aspect-video`) framed above the cursor with a time-label below.

The preview element **stays mounted** (toggled via inline `display`) so we pay the metadata-load cost once per video open, not per hover-tick. Lag for local mp4 via the asset protocol is ~50–200ms — comparable to YouTube's storyboard previews but live-decoded.

## yt-dlp resolution order

`pipeline/ytdlp.rs::download()` resolves yt-dlp at runtime in priority order:

1. **`<app_data>/bin/yt-dlp{.exe}`** — user-updated copy from Settings → 更新 yt-dlp (`commands::yt_dlp::yt_dlp_update`). Downloaded via reqwest from `https://github.com/yt-dlp/yt-dlp/releases/latest/download/`, written to `.downloading`, atomic-renamed. `chmod +x` on unix.
2. **Bundled sidecar** (`binaries/yt-dlp-<target_triple>{.exe}`) — what `pnpm tauri build` ships. CI workflow input `yt_dlp_tag` (default `latest`) controls which yt-dlp release gets bundled.

The AppData path uses `pipeline/spawn.rs::run_external_with_callback` (a `tokio::process::Command`-based parallel of `run_sidecar` — same chunked-stderr callback + cancellation token + stderr-tail-on-error semantics) because Tauri shell plugin's `sidecar()` only accepts whitelisted basenames, not arbitrary paths. The bundled fallback still uses `run_sidecar`.

Why this split: yt-dlp upstream ships multiple times/week chasing YouTube's player JS changes. Bundling a single yt-dlp at app-build time means weeks-long lag when extractors break. Users hit Settings → 更新 yt-dlp to get the current latest within seconds, no whatsub re-release needed.

## Foreground vs background yt-dlp retry budgets

`pipeline/ytdlp.rs::download(background: bool)`:

| flag | foreground | background |
|---|---|---|
| `--socket-timeout` | 5s | 20s |
| `--retries` (per HTTP req) | 1 | 10 |
| `--fragment-retries` | 1 | 10 |
| `--retry-sleep` | 2s | 5s |
| Process-level retry attempts | 1 | 3 (only on `is_transient_yt_dlp_error()`) |

Foreground goal: **fail fast (~25-50s)** so user sees actionable error dialog instead of staring at a frozen-looking modal. Background goal: **patient (~3 min)** so transient blips recover without user supervision. ⚠️ These knobs only control TCP-connect + HTTP retries; **they do NOT bound yt-dlp's player-JS sigsolver time** — long YouTube videos with large DASH manifests can still take minutes in "准备中" while yt-dlp parses formats. There's no flag to shorten that.

## whisper.cpp build

Built from whisper.cpp v1.8.4 in `.github/workflows/release.yml`. Win = Vulkan + CPU fallback (VS 2022 + Vulkan SDK + cmake). macOS arm64 = Metal + CPU fallback (Metal shaders embedded into `libggml-metal` since v1.7+; no separate `.metallib`).

Critical: Win cmake passes `-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=OFF -DGGML_AVX512=OFF -DGGML_FMA=OFF -DGGML_F16C=ON` — without this conservative SIMD baseline, CI's AVX-512 Xeon bakes incompatible SIMD into `ggml-cpu.dll` → end-user CPUs hit `STATUS_ILLEGAL_INSTRUCTION` (-1073741795) **even when Vulkan is the active backend** (mel-spectrogram preprocessing still runs on CPU SIMD).

`pipeline/whisper.rs` parses the first `ggml_<backend>: 0 = <gpu>` stderr line, persists as `settings.whisperBackend` so Settings shows "GPU 加速" status.

## Build / dev

```bash
pnpm install
pnpm tauri dev          # First cargo build 5–15 min; incremental ~10s
pnpm test               # Vitest
pnpm typecheck          # tsc --noEmit
pnpm tauri build        # → src-tauri/target/release/bundle/

cd src-tauri && cargo test    # safe: tests use temp paths only (see "tests must use temp paths" rule below)
```

> Dev mode: Tauri puts sidecars at `target/debug/<basename>.exe` (no triple). If you delete those during cleanup, dev spawn fails with `os error 2`.

## Release workflow

**Three repos, dual-publish:**
- Source: `rjxznb/whatsub` (private)
- Release mirror A: `rjxznb/whatsub-releases` on GitHub (public, international)
- Release mirror B: `rjxznb-group/whatsub-release` on JiHu GitLab (public, mainland-direct, no VPN; project id 335658)

**Updater endpoints** in `tauri.conf.json`, tried in order:
1. `https://jihulab.com/.../latest.json` — preferred (China-reachable)
2. `https://github.com/rjxznb/whatsub-releases/.../latest.json` — fallback

Why dual: tauri-plugin-updater's reqwest client ignores OS proxy settings (only `HTTPS_PROXY` env var works), so GitHub release assets (Azure Blob) are intermittently unreachable from mainland China. JiHu sidesteps the GFW. Same minisign key for both — signature bytes identical, only `url` field in `latest.json` differs.

Private signing key = repo secret `TAURI_SIGNING_PRIVATE_KEY` (+ local backup `secrets/whatsub.key`). Public key embedded in `tauri.conf.json plugins.updater.pubkey`. JiHu auth = secret `GITLAB_TOKEN`.

### Per-release

1. Bump version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (must match).
2. Commit + push to `main`.
3. GH Actions → **Release** → Run workflow. Inputs: `targets` (both/windows/macos, single-platform iterates with the other carried over), `release_notes`, `whisper_tag`, `vulkan_sdk_version` (bump if LunarG 404s an old version), `node_version`, `yt_dlp_tag` (default `latest`; pin to e.g. `2026.03.17` when chasing an upstream regression), `dry_run`.
4. ~5–25 min depending on cache hit. Both `.msi` + `.dmg` get signed; `.dmg` is notarized + stapled in CI. `.app.tar.gz` repackaged from the stapled `.app` so auto-updater serves notarized version.

CI caches whisper sidecar+DLLs, Vulkan SDK, node sidecar, and cargo target (`Swatinem/rust-cache@v2`). Warm rebuild ~5–8 min Win + 2–3 min Mac (cold = 25 + 5).

Mac dmg build is wrapped in a 3× retry loop — Tauri's create-dmg wrapper relies on AppleScript + hdiutil + diskimages-helper which intermittently fail on macos-14 runners with a generic 4-second `failed to bundle project`. Retry helpers: `hdiutil detach -force /Volumes/whatsub*` + `pkill -9 diskimages-helper` + 8s sleep between attempts.

### Updater UX

Auto-check 3s after launch; bottom-right toast with 「立即更新」/「稍后」/「✓ 不再提醒此版本」 (persisted in `localStorage["skippedUpdateVersions"]`). Settings → 检查更新 ignores skip list. Win uses `installMode: "basicUi"` (default `passive` silently swallowed UAC). `useUpdater.ts` does NOT call `relaunch()` after `downloadAndInstall` on Windows (would file-lock msiexec out of the install dir); msiexec handles its own restart. macOS: `open -b com.whatsub.app` via Launch Services + `exit(0)` (more reliable than `plugin-process::relaunch`'s direct exec).

Updater state lives in a module-level zustand store in `useUpdater.ts` (not component-local useState) so navigation away mid-download keeps the percent indicator alive + shared between the auto-check toast and the Settings panel. `runningDownload: Promise<void>` is a module-level singleton so a second click while one is in flight short-circuits — without this, plugin-updater (which has no disk cache) would re-stream from byte 0.

### Safety

- **Never lose the private key** (public key shipped in app; rotation breaks all installed clients).
- **Never make source repo public** without rotating the local backup key.
- **Never delete a release users installed from** — breaks signature chain for subsequent updates.
- **Never commit `.msi` / `.sig`** — release assets only.

## 踩过的坑 (avoid repeating)

- **yt-dlp has no `--ffprobe-location` flag**. Only `--ffmpeg-location` exists; yt-dlp auto-discovers ffprobe by literal name (`ffprobe`/`ffprobe.exe`) next to the resolved ffmpeg. Our sidecars are renamed to `ffprobe-<triple>{.exe}` so yt-dlp can't find ours. Most YouTube downloads work without ffprobe; fragmented DASH/HLS fail with "ffprobe not found". Fix would be: copy `ffprobe-<triple>` → bare `ffprobe` into user-writable dir at first run, then pass `--ffmpeg-location <that dir>`.

- **`&list=...&index=N` URLs trigger playlist download**. YouTube's share-from-playlist links carry these params; without `--no-playlist`, yt-dlp walks the WHOLE playlist into the same `source.mp4`/`thumb.jpg` (each overwriting the last) and bails if any single video is unavailable. Always pass `--no-playlist`.

- **Opus-in-MP4 / VP9-in-MP4 won't play in WKWebView on Mac** (silent black frame, no error). Tauri WebView on Mac → AVFoundation hard-rejects these. Win Media Foundation tolerates them so this is invisible on Win dev. yt-dlp format selector in `pipeline/ytdlp.rs::yt_dlp_format` constrains BOTH `vcodec^=avc1` AND `ext=m4a` with progressive fallback chain. `best` is **capped at 1080p** because YouTube only ships VP9/AV1 above that.

- **AAC re-encode in yt-dlp merger corrupts multichannel audio**. We used to pass `Merger:-c:v copy -c:a aac -b:a 192k` as belt-and-suspenders for Mac playback. On YouTube uploads shipping 5.1/7.1 m4a, the ffmpeg AAC encoder writes a header for one channel layout but emits packets for another → `channel element 1.0 is not allocated` on every packet during downstream WAV extraction, ffmpeg exits 69. Current args: `Merger:-c:v copy -c:a copy` (pure remux). Defense in depth: `extract_audio_wav` passes `-fflags +discardcorrupt -err_detect ignore_err -max_error_rate 0.95` so a few corrupt packets don't kill transcription.

- **SSL EOF on googlevideo from China = GFW**. `EOF occurred in violation of protocol (_ssl.c:...)` mid-fetch is GFW interfering with TLS handshake. yt-dlp's default 10 retries finish in seconds without giving the network time to settle. We pass `--retries 20 --fragment-retries 20 --retry-sleep linear=1:20:2`, AND wrap `run_sidecar` in a 3-attempt process-level retry (fresh DNS / TLS session) that only fires on transient stderr patterns (`is_transient_yt_dlp_error()` in `pipeline/ytdlp.rs`). Deterministic errors (cookies / banned / private) bubble immediately so users see the actionable dialog quickly.

- **Cloudflare Workers from China without VPN: first TCP handshake 5–10s** (subsequent on same socket = 500ms). GFW TCP-level throttling on CF edge. Already migrated to Aliyun ECS (<200ms), but the 30s `fetch` timeout + "首次可能需要 10-15 秒" copy in LicenseGate stays as a safety margin.

- **Windows whisper-cli companion DLLs not on PATH**. `bundle.resources` puts `whisper.dll`/`ggml*.dll` at `<install>/resources/binaries/` which isn't in Windows' default DLL search order → whisper-cli exits with `STATUS_DLL_NOT_FOUND` (-1073741515). `pipeline/spawn.rs` (Windows-only) prepends that dir to the child process's PATH before spawning.

- **yt-dlp thumbnail download fails on flaky networks**. yt-dlp's `--write-thumbnail` does a separate HTTPS GET to `i.ytimg.com`; GFW often resets that connection → `EOF occurred in violation of protocol` after 10 retries → yt-dlp exits 1 **even when the video itself downloaded fine**. Now we don't ask yt-dlp for the thumbnail at all; `ffmpeg::extract_thumbnail` pulls a frame from the local `source.mp4` after download (best-effort — missing thumbnail doesn't fail the import).

- **Release commits MUST verify current branch first**. The session-start `gitStatus` snapshot Claude Code provides shows the branch at session start — it does NOT update if the user switches branches mid-session. Before any release `git commit`, **always run `git branch --show-current` and confirm it's `main`**. Hit this 2026-05-18 (would-be v0.1.45): mid-session worktree had been switched to `feat/corpus-seed` (user's WIP for the browser-plugin / bridge work); I committed the release there. Compounded by `git push origin main` — that refspec means "push local main, regardless of current branch", which silently picked up the user's unpushed docs commits on local main and published them to remote main unbidden (the exact pattern [[feedback_subagent_branch_isolation]] warns about, except this time it was the top-level agent, not a subagent).

- **`git add A B C` is atomic-fail-all**. If ANY pathspec doesn't match (typo, file moved, wrong cwd) git aborts the whole command with `fatal: pathspec ... did not match` AND stages nothing — even the valid paths in the list. Easy to miss inside a wall of `warning: LF will be replaced by CRLF` output. After every `git add`, run `git status --short` and verify the leading column is `M `/`A ` (staged) not ` M`/`??` (unstaged) for every file you intended. Hit this same 2026-05-18 incident: a typo `LibraryGate.tsx` → `LibraryTour.tsx` in the file list caused the whole add to fail, the subsequent commit included only the one new file (added separately) and missed all 11 version-bump + bug-fix modifications.

- **WebView fetch swallows TLS/CSP/AV errors as bare `TypeError: Failed to fetch`**. JS-side `fetch()` in Tauri 2 WebView2 (Win) and WKWebView (Mac) routes through the OS browser engine's network stack — which means user-side firewalls, antivirus SSL inspection, system-cert-store quirks, CSP `connect-src`, and CORS preflight all participate. When ANY of them blocks the request, JS gets a single error with no detail beyond "Failed to fetch". Hit this 2026-05-18 with license activation: server was healthy (curl ~200ms), but multiple users couldn't activate. Fixed by moving the POST to Rust via `reqwest` (`commands/license.rs::license_activate_http`), where errors come back tagged `timeout: ...` / `connect: ...` / `tls: ...` so the dialog can show actionable causes ("校准系统时间" / "关杀软 SSL 注入" / etc.).

- **opacity-animated wrapper creates a stacking context with z-auto, isolating children's z-index**. A `<div className="animate-fade-in">` where the animation includes `opacity` creates a *local* stacking context — meaning a child `<svg className="fixed inset-0 z-[200]">` inside it CANNOT escape the wrapper's stacking level. If the wrapper has `z-auto`, the whole tour overlay can sit *below* any sibling with explicit z-index (e.g. ImportModal at `z-50`). LibraryTour + VocabTour both hit this 2026-05-18: the dim+cutout SVG was rendered but invisible because the modal covered it. Fix: hoist `z-[200]` to the wrapper itself + `pointer-events: none`, switch children to `absolute` (since wrapper already covers viewport). Apply the same pattern to ANY new portal-mounted overlay component.

- **CSS `forwards` opacity animation on a wrapper that needs to be above a z-50 modal MUST set z-index on the wrapper itself.** Same root cause as above, listed separately because the fix is mechanical and worth pinning: do `fixed inset-0 z-[N] pointer-events-none` on the wrapper + `absolute` (NOT `fixed`) on each child + `pointer-events-auto` on the interactive piece (tooltip etc).

- **yt-dlp `--retries N` is PER HTTP REQUEST, not a global budget.** yt-dlp typically makes 4 distinct requests per download (webpage → player JS → format manifest → stream), each retried independently. Combined with the default ~20s TCP connect timeout, foreground used to wait ~2 min on "no VPN" cases. We now set `--socket-timeout 5 --retries 1` for foreground; comment block at top of `args.extend([...])` in `pipeline/ytdlp.rs` lays out the math.

- **stderr chunks from `run_sidecar` callback are NOT line-aligned.** `tauri-plugin-shell`'s `CommandEvent::Stderr(bytes)` delivers raw byte chunks, possibly containing multiple `\n`s. `parse_progress` and `parse_whisper_progress` use single-line patterns (`strip_prefix("[progress] ")` / `find("progress =")`), so multi-line chunks fail to parse OR only the first match registers — losing intermediate progress events. Both `ytdlp.rs` and `whisper.rs` callbacks must iterate `chunk.lines()` before invoking parse helpers. Hit 2026-05-18 (0.1.44): "准备中" turned green simultaneously with "下载视频" because every Downloading event was being dropped.

- **Rust `#[cfg(test)]` blocks must NEVER call `paths::*_path()` directly.** Earlier `commands/library.rs` and `commands/settings.rs` test modules ran `fs::remove_file(paths::library_index_path())` / `save_settings(...)` against the REAL `%APPDATA%/whatsub/` paths — so `cargo test` wiped the user's library.json + settings.json (DeepSeek key, etc. all gone). Fixed 2026-05-20 by extracting pure-memory helpers (`upsert_in_memory`, `set_status_in_memory`) and `path`-injectable variants (`save_settings_to(path, value)`, `get_settings_from(path)`); tests now operate on `Library::default()` or `std::env::temp_dir()` paths. **When adding a new Rust command that touches a user-data path, never let its tests call the production path resolver.** Mirror the pattern: extract the logic to take an injectable path, test that.

- **Validation errors in ImportModal must NOT share state with real download errors.** The error-dialog auto-open effect (`useEffect` watching `error`) triggers the troubleshooting checklist whenever `error` is non-empty. A simple `setError("请输入 URL")` for empty-URL validation accidentally pops the VPN/cookies dialog — actively misleading. Use a separate `validationError` state for input validation; reserve `error` for actual yt-dlp / ffmpeg / whisper failures.

- **JiHu GitLab API curl without `--connect-timeout` can hang the release job indefinitely.** Default curl waits forever on stalled TLS handshake. 0.1.49 publish step hung 13+ min on "Mirror to JiHu GitLab" before manual cancel. All curl calls in that workflow step now have `--connect-timeout 15-30 --max-time 30-600` matched to operation type. POST that creates the release record stays non-retried (`--retry` would risk duplicate records); idempotent ops (PUT package upload, DELETE, GETs) all have `--retry 3 --retry-all-errors`.

- **osxexperts.net HTTP/2 stream PROTOCOL_ERROR mid-download.** macOS CI ffmpeg/ffprobe download from osxexperts.net intermittently dies at 30-60% with `HTTP/2 stream X was not closed cleanly: PROTOCOL_ERROR (err 1)`. `--retry` alone doesn't help (re-tries die at the same point). Fix: pass `--http1.1 -C - --retry 5` to curl. HTTP/1.1 has no stream layer so the bug can't trigger; `-C -` resumes from any partial bytes so reconnects don't restart from byte 0.

- **Tauri 2 `dragDropEnabled: true` (the default) intercepts ALL HTML5 drag inside the webview.** Symptom: the webview-internal drag-and-drop (Library card reorder, drag-to-merge) shows the 「禁止」 cursor on every drop target — `dragover` events never fire because the OS-level OLE/COM drag handler is consuming them. Fix: set `windows[0].dragDropEnabled: false` in `tauri.conf.json`. Trade-off: `getCurrentWindow().onDragDropEvent` stops firing, so OS-level file drops (dragging a video file from Explorer into the window for import) break. Acceptable — Import button + URL input still cover the same flow.

- **HTML5 dragover handlers must read `drag` state from a ref, not useState.** The native `dragover` event fires immediately after `dragstart` — too fast for React to re-render with the new state. The dragover handler's closure still sees `drag === null`, returns early without calling `preventDefault`, and the browser permanently marks the drop as 「禁止」 (no drop target). Fix: `dragRef = useRef<DragState | null>(null)` written synchronously in `onDragStart`, read synchronously in `onDragOver`. A separate `dragSt` useState mirror still drives child visual state (opacity-40, ring colors) via re-render.

- **`onDragOver` early-return when cursor is over the source MUST still call `preventDefault`.** During reorder live-preview the source card animates under the cursor; if its dragover handler skips `preventDefault` (because target === source), the browser flashes 「禁止」 every frame. Always `preventDefault + dropEffect = "move"` first, only THEN check source-id and skip state update.

- **`onDragLeave` must NOT clear `dragOver` state.** Cursor crossing a 1px gap between cards fires dragleave → if you clear, `effectiveOrder` flips to base, framer-motion animates back, the next dragover (half a frame later) re-sets the state, animation kicks in again. Cards visibly bounce. Solution: make `onDragLeave` a no-op; `dragOver` only changes when a new target receives dragover, or when the drag ends (`onDragEnd` / `onDrop`).

- **Drop event fires on whichever element the cursor sits on at release.** With live reorder preview, the source card animates under the cursor on back→front drags; `onDrop` then runs with `target === source` and the obvious `if (target.id === drag.ref.id) return` cancels the operation. Fix: cache the last legitimately hovered target (`id + type + mode + rect`) in `dragOverRef` during `onDragOver`. `onDrop` ignores `e.currentTarget` and uses the cached target, so dropping anywhere — even on the source post-animation — still applies the reorder.

- **`backdrop-blur` is independent of `background-color` alpha.** Setting `bg-black/0` (fully transparent) still leaves the blur filter active — the video behind the caption looks "through a lens" even though the box is invisible. Tie the `backdrop-blur-*` class to `bgOpacity > 0` and the user actually sees the video crisply when they pick 0%.

- **`?start=` in YouTube embed URL only accepts integers.** Saved `timestampSec: 5.646522` (decimal from `player.getCurrentTime()`) becomes `?start=5.646522` → YouTube silently treats it as invalid → starts from 0. Floor before building the URL: `Math.max(0, Math.floor(startSec))`.

- **React `setState(sameValue)` won't trigger child key change.** The CorpusPhraseDetail timestamp button used `setSelectedInstance(c)` only. When clicked on the already-current instance the state didn't change, the iframe's `key={instance.id}:${seekNonce}` didn't change, the iframe didn't remount, the player stayed where it was. Always bump `seekNonce` alongside `setSelectedInstance` so the key changes unconditionally.

- **CSP `img-src 'self'` / `media-src 'self'` does NOT cover Tauri's asset protocol.** `convertFileSrc()` produces `http://asset.localhost/...` on Windows and `asset://localhost/...` on Mac — neither matches `'self'`. Thumbnails + videos render blank with no obvious error. Explicit CSP must include `asset: http://asset.localhost https://asset.localhost` in both `img-src` and `media-src`.

- **Overflow-scroll inside a layout-driven height requires `h-full`, not `flex-1`.** `flex-1` only applies when the parent is a flex container; inside a plain block parent it's a no-op. The element ends up content-sized and `overflow-y-auto` never kicks in. Use `h-full` (or wrap the parent in `flex`) so the element has a constrained height that overflows.

## Known limitations / TODO

- All OpenAI-compatible vendors share one API-key slot — switching DeepSeek ↔ Kimi may lose the prior key (vendorKeys stash exists but switch logic isn't fully wired).
- `settings.modelsDir` change does NOT migrate existing `.bin` files.
- ARM64 Windows / Intel Mac not built.
- ffprobe bundled but yt-dlp can't reach it (see 踩过的坑).
- Burn-in export = libx264 only, no NVENC. 1–2× realtime CPU.
- Tauri updater plugin doesn't disk-cache across app restarts — close mid-download + reopen + click = re-download from byte 0. ~80 lines to fix; deferred.
- No way to shorten yt-dlp's player-JS sigsolver time. `--socket-timeout` only bounds TCP connect. Long YouTube videos with large DASH manifests can sit in "准备中" for minutes regardless of our retry budget.
- Personal-corpus 我的 tab loads via cached SWR but doesn't show a global "正在同步" state; user has to click 刷新 if they just added a tag and want to see counts update.
