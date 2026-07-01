# yt-dlp update check + prompt — design

**Date:** 2026-07-01
**Scope:** `client/` (Rust yt-dlp commands + a launch-time check/prompt in React)
**Status:** approved in discussion, pending implementation plan

## Problem

yt-dlp ships multiple times a week chasing YouTube's player-JS changes. When
YouTube breaks extraction, an out-of-date yt-dlp fails imports until the user
manually hits Settings → 更新 yt-dlp. We want users to stay current without:
- bumping the whole whatsub app per yt-dlp release (absurd: a ~233 MB installer
  re-download + rebuild/re-sign/republish for an 18 MB tool, multiple times/week), or
- silently auto-updating behind the user's back (yt-dlp releases are frequent and
  occasionally regress; the user should stay in control).

## Goal

On every launch, silently check whether a newer yt-dlp exists; if so, show a
**non-blocking prompt**; only when the user **explicitly clicks 更新** does it
download + swap the binary. Fully user-controlled, mainland-reachable.

## What already exists (reuse, don't rebuild)

- `commands/yt_dlp.rs`:
  - `yt_dlp_get_status()` → current active yt-dlp `{version}` (from the AppData
    copy or the bundled sidecar via `--version`).
  - `yt_dlp_update()` → downloads latest from GitHub to
    `<app_data>/bin/yt-dlp.downloading`, atomic-renames into place; already
    handles the rename-while-a-yt-dlp-process-runs case.
  - The pipeline prefers `<app_data>/bin/yt-dlp` over the bundled sidecar, and
    `resolve_appdata_yt_dlp()` is resolved per spawn.
- The app updater UX: `hooks/useUpdater.ts` + `components/UpdateChecker.tsx` — a
  launch-time check that surfaces a non-blocking toast with 立即更新 / 稍后 /
  不再提醒此版本, mounted once in `App.tsx`. This is the exact pattern to clone.

## Decisions (settled)

- **Model: proactive check on launch → prompt → explicit consent.** NOT silent
  auto-update, NOT reactive-on-failure.
- **Mirror hosting (mainland): the existing JiHuLab `whatsub-release` project, a
  dedicated fixed release tag `yt-dlp`** (NOT versioned per release). The maintainer
  **manually** re-uploads (overwrites) three assets there when yt-dlp releases:
  `yt-dlp.exe`, `yt-dlp_macos`, `yt-dlp-version.json`. Fixed download URLs:
  `https://jihulab.com/rjxznb-group/whatsub-release/-/releases/yt-dlp/downloads/<file>`.
- **GitHub is NOT self-mirrored** — the fallback download points straight at the
  official `github.com/yt-dlp/yt-dlp/releases/latest/download/<file>` (always
  current, zero maintenance). So the ONLY thing the maintainer keeps fresh is the
  JiHuLab copy.
- **Version check reads ONLY the JiHuLab `yt-dlp-version.json`** (option A). If it's
  unreachable, this launch simply doesn't prompt (retry next launch). Downloads
  are dual-source (JiHuLab primary → GitHub official fallback).
- **`yt-dlp-version.json` shape:** `{ "version": "2026.06.30", "notes": "<optional>" }`.
  Download URLs are NOT in the manifest — they're fixed and hard-coded in the app
  (JiHuLab tag URL + GitHub official URL).
- **No auto-update; explicit 更新 click only.** Persist a per-version 「不再提醒此版本」
  so a declined version doesn't nag every launch.
- yt-dlp versions are date-based (`2026.06.30`) → **string comparison** determines
  "newer".

## Non-goals

- No silent/automatic update; no reactive-on-failure update (both explicitly
  rejected).
- No automated CI to keep the JiHuLab mirror fresh (maintainer chose manual upload).
- No GitHub-side version manifest / GitHub API version check.

## Design

### Unit 1 — Rust: version check command

`commands/yt_dlp.rs`:
- `const YTDLP_MANIFEST_URL: &str` = the JiHuLab `yt-dlp-version.json` URL.
- `yt_dlp_check_update(app) -> YtDlpUpdateInfo` where
  `YtDlpUpdateInfo { current: String, latest: String, has_update: bool, notes: String }`.
  - `reqwest` GET the manifest (short timeout, e.g. 10 s) — Rust, NOT WebView fetch
    (mainland reliability, same rationale as license/corpus HTTP).
  - Read current via existing `yt_dlp_get_status()`.
  - `has_update = is_newer(latest, current)`, a **pure** function
    (`is_newer(a, b)` = true when date-ish string `a > b`), unit-tested.
  - Best-effort: any network/parse failure → `has_update = false` (no prompt).

### Unit 2 — Rust: dual-source download

Modify `yt_dlp_update()` (or add a thin wrapper) to try the **JiHuLab tag URL
first, then the GitHub official URL** for the current platform, keeping the
existing `.downloading` → atomic-rename + in-use-rename handling. Emit progress
so the prompt can show a bar (mirror how `yt_dlp_update` already reports, or the
model-download progress event pattern).

### Unit 3 — TS: launch check + prompt

- `hooks/useYtDlpUpdater.ts` (clone of `useUpdater.ts`): on mount, `invoke
  yt_dlp_check_update`; hold `{ status, info }`; expose `update()` (→ invoke the
  download command) and `skipThisVersion()`.
- `components/YtDlpUpdateToast.tsx` (clone of `UpdateChecker.tsx`): non-blocking
  bottom-corner toast 「yt-dlp 有新版本 <X>,建议更新以保持下载可用」 with buttons
  **更新** / **稍后** / **不再提醒此版本**. Shows a progress state while updating and
  a success/failure line.
- **Skip persistence:** store the skipped version (localStorage key e.g.
  `ytdlpSkipVersion`, mirroring how the app updater persists its skip). Don't
  prompt when `info.latest === skipped`.
- Mount once in `App.tsx` next to `<UpdateChecker />`. Non-blocking, never delays
  launch; silent when offline / no update / skipped.

### Unit 4 — Ops doc

Add a short section (RELEASE.md or a new `docs/ytdlp-mirror.md`) documenting the
manual mirror update: download the latest `yt-dlp.exe` + `yt-dlp_macos` from
upstream, write `yt-dlp-version.json` with the new version, and upload all three
to the JiHuLab `yt-dlp` release tag (overwrite). This is the recurring manual step.

## Data flow

```
launch → useYtDlpUpdater → invoke yt_dlp_check_update
           → reqwest GET jihu yt-dlp-version.json  ── unreachable ─► no prompt
           → is_newer(latest, current)?  ── no / skipped ─► no prompt
           → yes ─► toast「yt-dlp 有新版 X」[更新 / 稍后 / 不再提醒此版本]
                     └ 更新 ─► invoke download (jihu → github fallback)
                              → .downloading → atomic swap → next import uses it
```

## Testing

- `is_newer()` pure unit tests (Rust): newer date → true; equal → false; older →
  false; malformed → false.
- Skip-persistence + "prompt only when newer & not skipped" — small pure TS helper
  (`shouldPromptYtDlp(latest, current, skipped)`) unit-tested.
- The reqwest check, the download, and the toast rendering follow the existing
  updater patterns; real behavior is a manual smoke test (point the manifest at a
  higher version, confirm the prompt + update).

## Rollout / risk

- Additive: two Rust commands + one launch-mounted toast; no schema/migration, no
  change to imports. The check is best-effort and silent on failure — worst case is
  "no prompt", never a broken launch.
- The download reuses the proven atomic-swap path; concurrent downloads keep using
  their already-spawned binary (per-spawn resolution) and the swap handles the
  rename-in-use case.
- Ongoing cost: the maintainer must manually refresh the JiHuLab `yt-dlp` tag when
  they want users to get a newer yt-dlp (accepted trade-off).
- Ship together with the pending `fix/mkv-container-remux` in the same version bump.
