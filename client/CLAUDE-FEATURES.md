# Feature deep-dives

Implementation detail on individual features. Cross-referenced from `CLAUDE.md`. Read the relevant section when touching the feature.

## Analysis checkpoint recovery

DeepSeek analysis is persisted batch-by-batch through `src/llm/analysisSession.ts` and Rust `commands/analysis_store.rs`. Production callers use `openStoredAnalysisSession`, whose Rust command reads `transcript.srt` and issues one opaque process-local lease in the same critical section. The lease captures the exact transcript-file SHA-256 and every save rechecks it, in addition to checkpoint fingerprint/revision validation. Foreground/background handoff transfers the same session instead of opening another lease.

The durable checkpoint lives inside the atomically replaced `analysis.json`: `nextCueOffset` is the number of input transcript cues already consumed, `phase` is `cues | summary | complete`, and `revision` orders committed snapshots. Streamed output remains in memory until the whole current batch validates and Rust confirms the atomic save; only then is Zustand/UI updated. Therefore a hard process kill repeats at most the current uncommitted DeepSeek batch. A valid existing `transcript.srt` skips Whisper on continuation, and a summary-phase interruption retries only the summary. If a background lease becomes stale, retry closes it, reloads the durable transcript, and opens a fresh lease; temporary reopen failures stay in this mode and never fall through to retranscription.

Delete and import cleanup keep the Rust lease mutex held from revocation through index/filesystem removal, preventing a replacement producer from entering mid-cleanup. Cloud replacement stages `transcript.srt` and `analysis.json` together, publishes analysis last, and never restores old analysis unless transcript rollback succeeded. `cancel_import` waits for the exact registered sidecar's `Terminated` event and cleanup result: timeout or event-channel closure is a structural unconfirmed-exit error and keeps the job fenced. Cleanup-only recovery holds the import-registry lock from exact job-id validation through cleanup and unregister, so duplicate cancel callers cannot touch a replacement. Old `analysis.generation.json`, `.tmp`, and `.bak` artifacts are a one-time migration input only—steady state is one `analysis.json`, with no generation sidecar.

This guarantee is desktop-local. The remote import queue is not restart-safe because its server payload still lacks desktop video id, pipeline stage, and analysis checkpoint fields.

## Library folders + drag-to-merge

`pages/Library.tsx` renders single-level folders via `library.topLevelOrder` instead of a flat `library.videos.filter()`. Drag-to-merge UX:

- Drag video A onto another video B with **overlap ≥ 0.85** → merge into a new folder. Threshold lives in `utils/overlap.ts::MERGE_THRESHOLD` (was 0.9 originally, briefly 0.7, settled at 0.85 — 0.7 made every reasonable drop into a merge, 0.9 required bullseye precision).
- Drop with overlap < 0.85 → reorder. The grid renders an `effectiveOrder` computed by `useMemo` — source is inserted at the hover target's index in `library.topLevelOrder` — so the user sees a live preview of where the dragged card will land.
- Drop on a folder card with overlap ≥ 0.85 → add the video to that folder.
- Folder source can never merge — `resolveDropMode(folder→*)` always returns reorder. Folders can be rearranged at the top level but not nested.

**FLIP-style smooth reorder preview** uses `framer-motion`'s `<motion.div layout>`. Each card in the topLevelOrder branch is wrapped — when `effectiveOrder` changes, `layout` measures rect-before / rect-after and animates the transform difference with a spring (stiffness 350, damping 30). Search-mode rendering is unwrapped (filter-driven, doesn't reorder).

**Folder open uses an iPad-style modal** (`components/FolderOpenView.tsx`). Click captures the card's `getBoundingClientRect()`; the modal mounts at that rect and transitions `transform: scale + translate` to a centered (80vw × 75vh) target over 300ms ease-out. Esc / backdrop-click reverses the animation.

**Merge animation** (`components/MergeAnimationLayer.tsx`): on a merge drop, two thumbnail clones fly toward the midpoint (300ms), a blue Apple-Finder-style folder pops with bounce (250ms), clones fade (200ms). After 750ms the layer calls `mergeIntoFolder([target, source])` server-side then opens the rename dialog seeded with "新建文件夹".

Rust side (`src-tauri/src/commands/library.rs`) — pure in-memory helpers `create_folder_in_memory` / `delete_folder_in_memory` / `rename_folder_in_memory` / `move_video_to_folder_in_memory` / `merge_into_folder_in_memory` / `set_top_level_order_in_memory`, all callable from tests with a `&mut Library`. The `library_*` Tauri commands are thin `read_index → helper(...)? → write_index` wrappers. Error propagation uses `From<String> for AppError` (no `AppError::Internal` variant exists). ID generation is `sha256(now_secs || now_nanos)[..10]` — no `rand` crate dependency.

## Caption style menu + draggable overlay

Player gear button opens a 3-view menu (`pages/VideoPlayer.tsx` `menuView` state: `null | "root" | "speed" | "captions" | "captions.*"`):

- **root**: 「播放速度」 + 「字幕设置」 rows.
- **speed**: playback-speed list (Check icon ✓ marks selection — unified with captions).
- **captions**: row-list YouTube-style. Each row drills into a deep submenu (`captions.fontColor` / `captions.fontScale` / `captions.fontOpacity` / `captions.highlights` / `captions.bgColor` / `captions.bgOpacity`). 8-color palette uses Chinese labels (白色 / 黄色 / 青色 / 绿色 / 蓝色 / 品红色 / 红色 / 黑色). Picking an option does NOT auto-back — user stays in the deep view to compare. Back arrow at the top returns to captions level. Bottom has a 「重置字幕设置」 button that patches all 6 fields to defaults in one call.

Menu container: `w-[280px] bg-zinc-900/30 backdrop-blur-2xl`. Gear icon rotates 30° via `transition-transform` while menu is open.

**`CaptionOverlay` is draggable** — `mousedown` on the box starts a transient drag (local `dragDelta` useState), `mousemove` updates the visible `transform: translate(dx, dy)`, `mouseup` calls `onPositionChange(x, y)` → Player.tsx sets local `captionOffset` state. **Position is session-only, NOT persisted to settings** — every fresh Player mount resets to (0, 0). Deliberate UX choice.

**`backdrop-blur-sm` is conditional on `bgOpacity > 0`** — the blur filter is independent of bg-color alpha. At 0% background opacity the user expects the video to show through crisply.

## Library progress-bar hover thumbnail

YouTube-style scrubber preview in `components/VideoPlayer.tsx`. A hidden `<video>` element (separate ref, same `src` as the main player) lives above the progress bar with `display: none` until hover. On mouse-move over the progress bar, a `requestAnimationFrame`-throttled `useEffect` syncs the preview video's `currentTime` to the hovered timestamp. Render size 160×90 px (`w-40 aspect-video`) framed above the cursor with a time-label below.

The preview element **stays mounted** (toggled via inline `display`) so we pay the metadata-load cost once per video open, not per hover-tick. Lag for local mp4 via the asset protocol is ~50–200ms.

## Materialize (下载到本地)

Downloads a cloud-only library entry (e.g. phone-imported, captions-only video) to local disk, reusing the cloud's transcript + analysis — no re-whisper/re-LLM.

**Rust command:** `library_materialize_from_cloud` in `src-tauri/src/commands/library_sync.rs`. Steps: `GET /api/library/entry/:id` → `ytdlp::download(source_url, background:true)` → `replace_materialized_snapshot` stages the cloud transcript + analysis, revokes any producer, commits `transcript.srt`, then publishes `analysis.json` last while the lease mutex remains held → `library_upsert(entry{status:Ready, synced_at:now})`. Registered in `lib.rs` invoke_handler.

**TS wrapper:** `materializeFromCloud(id)` in `src/lib/api/librarySync.ts`.

**UI:** `src/components/CloudSyncManager.tsx` — "下载到本地" button per cloud entry. On click → `materializeFromCloud` → spinner → on success: `useLibrary.reload()` + toast "已下载到本地，可在库中播放". Only shown when entry is not already local.

**Persistent progress state:** materializing state lives in `src/store/materializing.ts` (module-level store, NOT component-local useState) so "正在下载…" persists across dialog re-mounts while the Rust command runs.

**Placeholder card in Library:** `library_upsert_placeholder` (a Rust helper) writes a stub entry with `status: Analyzing` + a "downloading" overlay while the materialize command runs, then flips to `ready` on success.

**Orphan reconcile + dangling-ref filter:** `read_index` (in `src-tauri/src/commands/library.rs`) does two passes: (a) appends any video that's in `library.videos[]` but absent from both `top_level_order` and all `folders[].videoIds`; (b) filters refs in `top_level_order` whose backing video/folder no longer exists (self-heals stale state left by older delete paths).

## Delete cascade dialog

When deleting a SYNCED video locally, the desktop asks what to do with the cloud copy.

**UI:** In the Library delete flow (`src/pages/Library.tsx`), when the target `LibraryEntry` has `syncedAt` set, a dialog with three choices is shown:
- **仅删本地** — `library_delete(id)` only (previous behavior for unsynced).
- **本地 + 云端都删** — `unsyncFromCloud(id)` (calls `DELETE /api/library/sync/:id`, which also deletes the OSS video object) then `library_delete(id)`.
- **取消** — dismiss.

Unsynced videos still delete directly without the dialog. Reuses `unsyncFromCloud` from `src/lib/api/librarySync.ts`.

## Corpus page detail — `/api/corpus/lookup?withScope=true` field shape

Server (since 2026-05-20) returns `{ phrase: { meaning_zh, usage_note, tags: {list} }, publicContributions, personalContributions }`. Three things to know:

1. **`meaning_zh` / `usage_note` fall back to caller's own contribution** when no `whatsub-curator` row exists. Aggregation in `aggregatePhraseViewWithPersonal()` in `whatsub-license/src/routes/corpus.ts`. Curator wins; caller's newest-non-null is the fallback. This is what lets users see their own saved meaning + usage note in the detail panel before a curator publishes anything.
2. **`tags` wraps as `{list}`** to match the corpus_contributions JSONB shape (was a bare array under legacy `aggregateCuratorView`). The desktop client's `phraseTagList()` accepts both shapes.
3. **`personalContributions` is now caller-scoped** (filtered by `contributor_id === deriveContributorId(session.email)`). Earlier "non-curator" filter included everyone else's rows under the user's `⭐ 我的例句出处` header — that was a privacy leak.

Client-side Rust struct `BrowseItem` uses `usage_note ↔ usageNote` serde mapping (was `key_notes ↔ keyNotes`; column was renamed in the 2026-05-20 schema migration). The TS side reads `phrase.usageNote`. UI label stays 「📝 重点笔记」 — same intent.

**`/api/corpus/browse` `source` field (2026-06-26).** `browse` aggregates curator contributions per phrase but used to drop the source. `aggregateCuratorDataByPhrase` (whatsub-license `db.ts`) now also SELECTs `source` and returns the **most-recent curator contribution's source** per phrase (same "later wins" fold as meaning/tags); `browseCorpus` threads it through (default null) and `CorpusPhrasePublicView` gains `source: CorpusSource | null`. Desktop `BrowseItem` carries it through as `source` (serde_json::Value, default null, backward-compatible — old clients ignore it). This is what powers the public list's 按视频来源 grouping + `CorpusVideoDetail` (group + seek by `source.timestampSec`). Curator sources are `{kind:'youtube', url, timestampSec}` — **no `youtubeId`, no `title`** — so the client parses the video id out of `url` to group per-video. Staleness: adding a field doesn't bump the corpus version, so an existing SWR cache serves source-less rows until the user hits ↻ (invalidateAll) or the version changes.

## Corpus page detail — `/api/corpus/versions` `public` field

The route now returns `{ mine, public }` — `mine = MAX(contributed_at) WHERE contributor_id = <caller>`, `public = MAX(contributed_at) WHERE contributor_id = 'whatsub-curator'`. Both bump on hide-no-longer or hide-resurrect because `MAX` recomputes from the current visible set. The desktop's `useCorpusList` cache compares for equality and refetches on any mismatch, so a downward bump is still a consistent signal.

Pre-Plan-D server builds returned only `{ mine }`. Both Rust (`#[serde(default)] public: i64`) and TS (`public?: number`) tolerate missing field — fall to 0, public cache check never short-circuits, browse always refetches. No UX regression, just no caching benefit for browse until server is upgraded.

## Release workflow

**Private source, canonical GitHub release, and mainland CDN:**
- Source: `rjxznb/whatsub` (private)
- Canonical release: `rjxznb/whatsub-releases` on GitHub (public)
- Mainland distribution: DogeCloud object storage + `https://download.eversay.cc`

**Updater endpoints** in `tauri.conf.json`, tried in order:
1. `https://download.eversay.cc/latest.json` — DogeCloud first
2. `https://github.com/rjxznb/whatsub-releases/releases/latest/download/latest.json` — GitHub fallback

GitHub remains the release source of truth and CI publishes only to GitHub. The `publish` job also attaches `dogecloud-latest.json`, whose platform URLs target `app/vX.Y.Z/manual/` on DogeCloud. From a domestic workstation, upload the Windows setup, macOS updater archive, and DMG to that directory, verify them, then upload `dogecloud-latest.json` to the bucket root under the name `latest.json`. Same minisign key for both—signature bytes remain identical; only each platform URL is rewritten.

Private signing key = repo secret `TAURI_SIGNING_PRIVATE_KEY` (+ local backup `secrets/whatsub.key`). Public key embedded in `tauri.conf.json plugins.updater.pubkey`. Cross-repository publication to canonical GitHub uses `RELEASES_REPO_TOKEN`. Desktop release CI does not hold DogeCloud credentials.

### Per-release

1. Bump version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (must match).
2. Commit + push to `main`.
3. GH Actions → **Release** → Run workflow. Inputs: `targets` (both/windows/macos; single-platform is for dry-run diagnostics only), `release_notes`, `whisper_tag`, `vulkan_sdk_version` (bump if LunarG 404s an old version), `node_version`, `yt_dlp_tag` (default `latest`; pin to e.g. `2026.03.17` when chasing an upstream regression), `dry_run`. A public release requires both platform builds from the same version; `dry_run=true` publishes nothing.
4. ~5–25 min depending on cache hit. Windows produces NSIS `*-setup.exe` plus `*-setup.exe.sig`; macOS produces `.dmg`, `.app.tar.gz`, and `.app.tar.gz.sig`. The `.dmg` is notarized + stapled in CI, and `.app.tar.gz` is repackaged from the stapled `.app` so auto-updater serves the notarized version. GitHub receives the five binaries/signatures, canonical `latest.json`, and `dogecloud-latest.json`.
5. Download the setup EXE, `.app.tar.gz`, `.dmg`, and `dogecloud-latest.json` locally. Upload the three binaries unchanged to `app/vX.Y.Z/manual/`, verify all three public URLs, then upload the prepared manifest to DogeCloud root as `latest.json`.

Never upload the DogeCloud manifest before all three binaries are publicly reachable. Keeping the manifest last makes a partial manual upload harmless. Verify public assets with an anonymous range GET.

CI caches whisper sidecar+DLLs, Vulkan SDK, node sidecar, and cargo target (`Swatinem/rust-cache@v2`). Warm rebuild ~5–8 min Win + 2–3 min Mac (cold = 25 + 5).

Mac dmg build is wrapped in a 3× retry loop — Tauri's create-dmg wrapper relies on AppleScript + hdiutil + diskimages-helper which intermittently fail on macos-14 runners with a generic 4-second `failed to bundle project`. Retry helpers: `hdiutil detach -force /Volumes/whatsub*` + `pkill -9 diskimages-helper` + 8s sleep between attempts.

### Updater UX

Auto-check 3s after launch; bottom-right toast with 「立即更新」/「稍后」/「✓ 不再提醒此版本」 (persisted in `localStorage["skippedUpdateVersions"]`). Settings → 检查更新 ignores skip list. Windows updater uses `installMode: "passive"` and installs the signed NSIS `*-setup.exe` updater artifact. The NSIS installer is `currentUser`, includes its path picker, creates the install subfolder, and requires no UAC. `useUpdater.ts` does not call `relaunch()` after `downloadAndInstall` on Windows; Tauri hands off the update process. macOS: `open -b com.whatsub.app` via Launch Services + `exit(0)` (more reliable than `plugin-process::relaunch`'s direct exec).

Updater state lives in a module-level zustand store in `useUpdater.ts` (not component-local useState) so navigation away mid-download keeps the percent indicator alive + shared between the auto-check toast and the Settings panel. `runningDownload: Promise<void>` is a module-level singleton so a second click while one is in flight short-circuits.

### Release safety

- **Never lose the private key** (public key shipped in app; rotation breaks all installed clients).
- **Never make source repo public** without rotating the local backup key.
- **Never delete a release users installed from** — breaks signature chain for subsequent updates.
- **Never commit `*-setup.exe`, `.dmg`, `.app.tar.gz`, or their `.sig` files** — release assets only.

### Mirror migration history

JiHu and GitCode were former mirrors. Their active updater instructions are retired.
Already-installed old clients cannot have hard-coded endpoints changed remotely;
they must reach their existing GitHub fallback once (or manually install a current
version) before they receive the DogeCloud-first updater configuration.
