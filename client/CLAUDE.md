# Get Video Client — Architecture

Tauri 2 desktop app for English subtitle learning. Pipeline: import (yt-dlp / local) → ffmpeg audio extract → whisper.cpp transcribe → user-configured LLM (DeepSeek / Claude / Gemini / etc.) for Chinese translation + key-phrase highlighting → bilingual player.

**Companion repo:** [`rjxznb/whatsub-license`](https://github.com/rjxznb/whatsub-license) (private) — Hono + node-postgres on the existing Eversay Aliyun ECS at `https://whatsub.eversay.cc`. Desktop POSTs once to `/api/license/activate`, then runs fully offline. Migrated 2026-05-09 from Cloudflare Workers + D1 (mainland latency 5–10s → <200ms).

## Stack

Tauri 2 · React 19 + TS + Vite · Tailwind v3 · zustand · React Router v6 · lucide-react · @fontsource/charis-sil · Vitest. Sidecars: `yt-dlp`, `ffmpeg`, `whisper-cli`, `node`. LLM HTTP is hand-rolled SSE per provider (no vendor SDKs). License + trial HTTP runs in Rust via `reqwest` (NOT WebView fetch — see 踩过的坑). Browser-plugin bridge uses `actix-web` on a separate `std::thread`.

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

## Browser plugin bridge

`bridge/` module spawns an **actix-web HTTP server bound to 127.0.0.1** (port-races over `[51737, 53401, 59283, 62015]`) so the whatsub browser extension can sync vocabulary + LLM-settings handoff with the desktop app. Runs on a dedicated `std::thread` with its own `actix_web::rt::System` — isolated from Tauri's tokio runtime, no shared state beyond `AppHandle`.

Routes (in `bridge/routes.rs`):
- `GET /ping` — health + version banner. Used by the extension to discover the desktop is running.
- `POST /vocab` + `POST /vocab/batch` — extension pushes vocab cards into `vocabulary.json` (shallow-merge so user notes survive desktop re-saves).
- `GET /vocab` — extension reads the user's full vocab.
- `GET /settings/llm` — extension reads the LLM provider/key/baseUrl currently configured.
- `POST /settings/llm/handoff` — extension hands a fresh LLM config over with a native confirm dialog (handoff.rs).

CORS allowed only for `chrome-extension://*` and `moz-extension://*` origins. Toggle: `settings.bridgeEnabled` (default `true`). Disabled users have NO listening port + NO actix thread.

Runtime stop (0.1.55+): `BridgeState { handle: Mutex<Option<ServerHandle>> }` lives in Tauri-managed state. `start_bridge` uses an mpsc channel to send the `ServerHandle` back to the caller; the Settings toggle invokes `bridge_set_enabled(enabled: bool)` which either spawns a fresh actix thread (enable) or calls `handle.stop(true).await` to graceful-shutdown (disable). No restart needed.

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

cd src-tauri && cargo test    # NB: library + settings tests pollute real %APPDATA%/whatsub/
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

- **Validation errors in ImportModal must NOT share state with real download errors.** The error-dialog auto-open effect (`useEffect` watching `error`) triggers the troubleshooting checklist whenever `error` is non-empty. A simple `setError("请输入 URL")` for empty-URL validation accidentally pops the VPN/cookies dialog — actively misleading. Use a separate `validationError` state for input validation; reserve `error` for actual yt-dlp / ffmpeg / whisper failures.

- **JiHu GitLab API curl without `--connect-timeout` can hang the release job indefinitely.** Default curl waits forever on stalled TLS handshake. 0.1.49 publish step hung 13+ min on "Mirror to JiHu GitLab" before manual cancel. All curl calls in that workflow step now have `--connect-timeout 15-30 --max-time 30-600` matched to operation type. POST that creates the release record stays non-retried (`--retry` would risk duplicate records); idempotent ops (PUT package upload, DELETE, GETs) all have `--retry 3 --retry-all-errors`.

- **osxexperts.net HTTP/2 stream PROTOCOL_ERROR mid-download.** macOS CI ffmpeg/ffprobe download from osxexperts.net intermittently dies at 30-60% with `HTTP/2 stream X was not closed cleanly: PROTOCOL_ERROR (err 1)`. `--retry` alone doesn't help (re-tries die at the same point). Fix: pass `--http1.1 -C - --retry 5` to curl. HTTP/1.1 has no stream layer so the bug can't trigger; `-C -` resumes from any partial bytes so reconnects don't restart from byte 0.

## Known limitations / TODO

- All OpenAI-compatible vendors share one API-key slot — switching DeepSeek ↔ Kimi may lose the prior key (vendorKeys stash exists but switch logic isn't fully wired).
- `settings.modelsDir` change does NOT migrate existing `.bin` files.
- Rust tests pollute real `%APPDATA%/whatsub/`. Should use temp dir.
- ARM64 Windows / Intel Mac not built.
- ffprobe bundled but yt-dlp can't reach it (see 踩过的坑).
- Burn-in export = libx264 only, no NVENC. 1–2× realtime CPU.
- Tauri updater plugin doesn't disk-cache across app restarts — close mid-download + reopen + click = re-download from byte 0. ~80 lines to fix; deferred.
<!-- Bridge runtime stop was deferred-then-implemented in 0.1.55. -->
<!-- Settings.bridgeEnabled toggle now flips at runtime via the      -->
<!-- bridge_set_enabled command — see bridge/mod.rs.                  -->
- No way to shorten yt-dlp's player-JS sigsolver time. `--socket-timeout` only bounds TCP connect. Long YouTube videos with large DASH manifests can sit in "准备中" for minutes regardless of our retry budget.
