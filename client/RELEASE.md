# Releasing whatsub

How to ship a new version that existing users will pick up via auto-update.

## One-time setup

### Public release repo

The auto-updater fetches `latest.json` from a publicly-readable URL. Our
private repo can't serve release assets publicly, so we use a separate
public repo for distribution only.

**Create it once on GitHub** (UI):

1. New → Repository → Name: `whatsub-releases` → **Public** → Create
2. The endpoint baked into the app is:
   ```
   https://github.com/rjxznb/whatsub-releases/releases/latest/download/latest.json
   ```
   (configured in `src-tauri/tauri.conf.json` `plugins.updater.endpoints`)
3. If you want a different repo name, update that endpoint AND the URL paths
   below.

### Signing keys (already done)

Located at `secrets/whatsub.key` (private repo backup) and
`%USERPROFILE%\.tauri\whatsub.key` (active local copy).

The public key is embedded in `tauri.conf.json` `plugins.updater.pubkey`.

**Don't re-generate** unless you've truly lost the private key — re-keying
breaks auto-update for all existing installs (they have the old public key
burned in and won't accept signatures from a new private key). Users would
have to manually reinstall.

## Release flow

One workflow (`.github/workflows/release.yml`) builds both Windows and
macOS in parallel and publishes a single GitHub Release with one
assembled `latest.json`. No more local-build-and-drag-drop.

```
                ┌─ build-windows (windows-latest, ~25 min)
                │     install Vulkan SDK → build whisper.cpp Vulkan
workflow_       │     → fetch yt-dlp.exe + ffmpeg.exe
dispatch  ──────┤     → pnpm tauri build --bundles msi
                │     → upload .msi + .msi.sig artifact
                │
                └─ build-macos (macos-14, ~10 min)
                      build whisper.cpp Metal → install_name_tool
                      → fetch yt-dlp + ffmpeg arm64
                      → pnpm tauri build (.dmg + .app.tar.gz + .sig)
                      → upload artifact
                                       │
                                       ▼
                          publish (ubuntu-latest, ~30 s)
                          download both artifacts
                          → create release on rjxznb/whatsub-releases
                          → upload all 5 files
                          → assemble + upload latest.json
                            (windows-x86_64 + darwin-aarch64)
```

### 1. Bump the version (3 places must match)

Commit + push these before triggering the workflow:

- `client/package.json` → `"version": "X.Y.Z"`
- `client/src-tauri/tauri.conf.json` → `"version": "X.Y.Z"`
- `client/src-tauri/Cargo.toml` → `version = "X.Y.Z"`

Semver:
- Patch (0.1.0 → 0.1.1) — bug fixes only
- Minor (0.1.0 → 0.2.0) — new features, backward compatible
- Major (0.1.0 → 1.0.0) — breaking changes (rare)

If versions don't agree, the Cargo build fails inside the runner — cheap
to catch but expensive in wall time, so double-check before triggering.

### 2. Trigger the workflow

GitHub UI → **Actions** → **Release** → **Run workflow**. Inputs:

| Input | Default | Notes |
|---|---|---|
| `release_notes` | `Bug fixes and improvements` | Markdown OK; shown in the in-app update toast |
| `whisper_tag` | `v1.8.4` | whisper.cpp git tag built from source on both runners |
| `vulkan_sdk_version` | `1.4.341.0` | LunarG Vulkan SDK for the Windows whisper-cli build |
| `ffmpeg_url_macos` | `https://www.osxexperts.net/ffmpeg711arm.zip` | Static arm64 ffmpeg |
| `ffmpeg_url_windows` | `https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip` | Static Windows ffmpeg (zip must contain `bin/ffmpeg.exe`) |
| `dry_run` | `false` | If `true`: produce artifacts only, skip the publish job |

Total wall time ~25 min (Windows is the slow one — Vulkan SDK install +
whisper.cpp Vulkan build + Tauri MSI bundling). Cost: ~25 min Windows
(2x weight) + ~10 min macOS (10x weight) = ~150 weighted minutes per
release out of the 2000/month free quota.

### 3. Test before publishing (optional but recommended)

For the first run, or when changing whisper.cpp / SDK versions, set
`dry_run=true`. The build jobs run, the publish job is skipped, and you
can download the artifacts from the workflow run page → `windows-bundle`
and `macos-bundle`. Install the .msi / .dmg on a real machine to verify.

If everything looks good, re-trigger with `dry_run=false`. (Or, since the
artifacts are retained 7 days, you can re-run only the publish job.)

### 4. What the publish job does

Runs only when `dry_run=false` and both build jobs succeeded. On
`ubuntu-latest`:

1. Reads version from `client/src-tauri/tauri.conf.json`
2. Creates `vX.Y.Z` release on `rjxznb/whatsub-releases` if missing
   (using `RELEASES_REPO_TOKEN` PAT)
3. Uploads `.msi`, `.msi.sig`, `.dmg`, `.app.tar.gz`, `.app.tar.gz.sig`
   with `gh release upload --clobber`
4. Assembles `latest.json` from scratch — both platforms in one call,
   with raw `.sig` text content (Tauri 2 spec, jq-escaped) — and uploads

### 5. Verify

```bash
curl -s https://github.com/rjxznb/whatsub-releases/releases/latest/download/latest.json | jq .
```

Should show `version`, `pub_date`, and a `platforms` object with both
`windows-x86_64` and `darwin-aarch64` entries.

On a machine with the previous version installed:

1. Restart the app
2. ~3 seconds after launch, the bottom-right toast appears:
   "发现新版本 vX.Y.Z"
3. Click "立即更新" → progress bar → app restarts → new version

Or trigger manually: Settings → 应用版本 → 「检查更新」.

For the `.dmg` on a fresh Mac, first launch hits Gatekeeper "已损坏" —
documented user bypass is System Settings → 隐私与安全性 → 仍要打开
(or `xattr -cr <app>`). No notarization yet (no Apple Developer account).

## Required secrets

Set these once on the **private** repo (Settings → Secrets and variables
→ Actions → Repository secrets):

| Secret | Purpose | Format |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Sign installers → produce `.sig` (Win + Mac share the same key) | Full PEM contents of `~/.tauri/whatsub.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Decrypt the key | Empty string for our key |
| `RELEASES_REPO_TOKEN` | Publish job uses `gh` to upload assets to the public release repo | Fine-grained PAT, expiry ≥ next release, **resource owner = your account, repository access = `rjxznb/whatsub-releases` only**, permissions: `Contents: Read and write` |

The Tauri signing key in CI must match the public key embedded at
`client/src-tauri/tauri.conf.json` `plugins.updater.pubkey`. They were
generated together; don't re-key without rotating both (see "One-time
setup" above).

## How users experience updates

- **Auto-check on every launch** — 3 s after app starts
- **Toast at bottom-right** if a new version is available, with:
  - "立即更新" → download + install + auto-restart
  - "稍后" → dismisses for this session
  - "✓ 不再提醒此版本" → permanently silences for THIS specific version
- **Manual check** — Settings → 应用版本 → 「检查更新」
- Users who skipped vX.Y.Z see no toast for it, but still get a toast for
  vX.Y.(Z+1) when that ships
- If the user has no internet or the release repo is unreachable, the toast
  silently doesn't appear — no error nag

## Troubleshooting

### `signature verification failed` in user's app
The `.sig` content in `latest.json` doesn't match what Tauri's signing
produced for the .msi / .app.tar.gz. Common causes:
- The public key in `tauri.conf.json` doesn't match the private key used
  in CI — shouldn't happen unless keys were re-generated. Don't re-key
  without rotating both sides.
- The `.sig` text was mangled in transit. The publish job uses `jq --arg`
  which preserves multi-line text correctly; if you ever hand-author
  `latest.json`, paste the **whole** `.sig` content (multiple lines, as
  produced by Tauri) — do NOT base64-encode it.

### `Failed to fetch latest.json`
- Release wasn't actually published (still draft): check the public repo
- Asset name typo: must be exactly `latest.json`, lowercase
- `/latest/download/` only works on the release marked "latest" — usually
  automatic, but if you've published a newer-tagged draft on top of an
  older live release, check the "Set as latest release" checkbox.

### Vulkan SDK installer step fails
LunarG occasionally rotates installer URLs. Verify
`https://sdk.lunarg.com/sdk/download/<version>/windows/VulkanSDK-<version>-Installer.exe`
returns 200, and bump `vulkan_sdk_version` workflow input as needed.

### Whisper.cpp DLL / dylib missing after build
Build script copies `whisper.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`,
`ggml-vulkan.dll` on Windows; matching `lib*.0.dylib` set on Mac. If
whisper.cpp ever splits the GGML modules differently in a newer tag, the
"Stage Windows binaries/" / "Stage whisper artifacts" steps fail with
`missing <name>` — list the actual outputs and update the file lists in
both the workflow and `client/src-tauri/build.rs`.

### Auto-check seems disabled
In dev mode (`pnpm tauri dev`), the auto-check still runs but Tauri's
endpoint check often fails because the dev binary's version (0.1.0) matches
or exceeds whatever's deployed. Test the update path with an installed
build (the `.msi` from the workflow artifact) instead.

## File locations summary

| File | Purpose | Where |
|---|---|---|
| Private signing key | Sign installers → produce `.sig` (shared by Win + Mac) | `secrets/whatsub.key` (repo backup) + `%USERPROFILE%\.tauri\whatsub.key` (active local copy) + `TAURI_SIGNING_PRIVATE_KEY` GitHub secret |
| Public verification key | Verify `.sig` in user's app | `client/src-tauri/tauri.conf.json` `plugins.updater.pubkey` (committed) |
| `RELEASES_REPO_TOKEN` | Publish job → upload assets to public release repo | GitHub secret (fine-grained PAT, scoped only to `rjxznb/whatsub-releases`, contents: read+write) |
| `release.yml` | Unified Win+Mac release workflow | `.github/workflows/release.yml` |
| `build-mac-binaries.yml` | (separate concern) Refresh Mac sidecar binaries committed to repo for local dev | `.github/workflows/build-mac-binaries.yml` |
| Built `.msi` + `.msi.sig` | Windows installer + signature | Built in CI runner, uploaded to release |
| Built `.dmg` | Mac installer (first install) | Built in CI runner, uploaded to release |
| Built `.app.tar.gz` + `.sig` | Mac updater bundle + signature | Built in CI runner, uploaded to release |
| `latest.json` | Update manifest the app fetches | Generated by the `publish` job each release, both platforms in one file |
