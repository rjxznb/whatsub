# Releasing whatsub

How to ship a new version that existing users will pick up via auto-update.

## One-time setup

### Public distribution repositories

GitHub is canonical: `https://github.com/rjxznb/whatsub-releases` holds the
published release and source `latest.json`. DogeCloud stores the mainland copy at
`download.eversay.cc`. The app tries DogeCloud first, then falls back to GitHub:

1. `https://download.eversay.cc/latest.json`
2. `https://github.com/rjxznb/whatsub-releases/releases/latest/download/latest.json`

These are the configured `plugins.updater.endpoints` in `src-tauri/tauri.conf.json`.

### Signing keys (already done)

Located at `secrets/whatsub.key` (private repo backup) and
`%USERPROFILE%\.tauri\whatsub.key` (active local copy).

The public key is embedded in `tauri.conf.json` `plugins.updater.pubkey`.

**Don't re-generate** unless you've truly lost the private key — re-keying
breaks auto-update for all existing installs (they have the old public key
burned in and won't accept signatures from a new private key). Users would
have to manually reinstall.

## Release flow

One workflow (`.github/workflows/release.yml`) builds both Windows and macOS,
publishes the canonical GitHub Release, uploads versioned files to DogeCloud,
then promotes the DogeCloud `latest.json` only after every binary succeeds.

```
                ┌─ build-windows (windows-latest, ~25 min)
                │     install Vulkan SDK → build whisper.cpp Vulkan
workflow_       │     → fetch yt-dlp.exe + ffmpeg.exe
dispatch  ──────┤     → pnpm tauri build --bundles nsis
                │     → upload *-setup.exe + *-setup.exe.sig artifact
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
                          → upload 5 release assets (Windows setup + sig;
                            macOS DMG, updater app.tar.gz + sig)
                          → assemble + upload latest.json
                            (windows-x86_64 + darwin-aarch64)
                                       │
                                       ▼
                          DogeCloud CDN publish
                          → upload versioned updater assets
                          → upload latest.json last
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
| `dry_run` | `false` | If `true`: produce artifacts only; neither GitHub nor DogeCloud publishes |

Total wall time ~25 min (Windows is the slow one — Vulkan SDK install +
whisper.cpp Vulkan build + Tauri NSIS setup bundling). Cost: ~25 min Windows
(2x weight) + ~10 min macOS (10x weight) = ~150 weighted minutes per
release out of the 2000/month free quota.

### 3. Test before publishing (optional but recommended)

For the first run, or when changing whisper.cpp / SDK versions, set
`dry_run=true`. The build jobs run; neither GitHub nor DogeCloud receives a release
or manifest update. The publish job is skipped, and you
can download the artifacts from the workflow run page → `windows-bundle`
and `macos-bundle`. Install the Windows `*-setup.exe` / macOS `.dmg` on real
machines to verify.

If everything looks good, re-trigger with `dry_run=false`; do not invent a new
app version merely to retry a failed publish. A failed DogeCloud upload is safe to
rerun with the same version/tag: versioned objects are overwritten and the public
manifest remains on the prior version until the final promotion succeeds.

### 4. What the publish job does

Runs only when `dry_run=false` and both build jobs succeeded. On
`ubuntu-latest`:

1. Reads version from `client/src-tauri/tauri.conf.json`
2. Creates `vX.Y.Z` release on the canonical `rjxznb/whatsub-releases` repository
3. Uploads the five release assets with `gh release upload --clobber`:
   Windows `*-setup.exe` and `*-setup.exe.sig`; macOS `.dmg`, `.app.tar.gz`,
   and `.app.tar.gz.sig`
4. Assembles `latest.json` from scratch — both platforms in one call,
    with raw `.sig` text content (Tauri 2 spec, jq-escaped) — and uploads
5. Rewrites updater URLs to `https://download.eversay.cc/app/vX.Y.Z/<run-id>/...`, uploads
   all updater files, and publishes `https://download.eversay.cc/latest.json` last.

### 5. Verify

```bash
curl -fsSL 'https://download.eversay.cc/latest.json' | jq .
curl -fsSL https://github.com/rjxznb/whatsub-releases/releases/latest/download/latest.json | jq .
```

Both manifests should show `version`, `pub_date`, and `platforms` entries for
`windows-x86_64` and `darwin-aarch64`. DogeCloud platform URLs must target `download.eversay.cc`;
the canonical GitHub manifest continues to target GitHub.

For every mirrored public asset, make an anonymous range GET—not `HEAD`—and require
the exact partial response:

```bash
curl -sS -o /dev/null -D - -H 'Range: bytes=0-0' \
  https://download.eversay.cc/app/vX.Y.Z/<run-id>/<asset>
```

The status should be `206` with a positive `Content-Range`; the workflow performs
the same range-GET health check after publishing.

On a machine with the previous version installed:

1. Restart the app
2. ~3 seconds after launch, the bottom-right toast appears:
   "发现新版本 vX.Y.Z"
3. Click "立即更新" → progress bar → app restarts → new version

Or trigger manually: Settings → 应用版本 → 「检查更新」.

For the `.dmg` on a fresh Mac, first launch hits Gatekeeper "已损坏" —
documented user bypass is System Settings → 隐私与安全性 → 仍要打开
(or `xattr -cr <app>`). No notarization yet (no Apple Developer account).

## Required secrets and DogeCloud setup

Set these once on the **private** repo (Settings → Secrets and variables
→ Actions → Repository secrets):

| Secret | Purpose | Format |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Sign installers → produce `.sig` (Win + Mac share the same key) | Full PEM contents of `~/.tauri/whatsub.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Decrypt the key | Empty string for our key |
| `RELEASES_REPO_TOKEN` | Publish the canonical release across repositories to `rjxznb/whatsub-releases` | Fine-grained GitHub PAT: resource owner = your account; repository access = `rjxznb/whatsub-releases` only; `Contents: Read and write` |
| `DOGECLOUD_ACCESS_KEY` | Requests narrowly scoped temporary upload credentials | DogeCloud permanent AccessKey |
| `DOGECLOUD_SECRET_KEY` | Signs the temporary-token request | DogeCloud permanent SecretKey |
| `DOGECLOUD_BUCKET` | Destination object-storage bucket | DogeCloud bucket name |
| `DOGECLOUD_DOWNLOAD_DOMAIN` | Public HTTPS CDN origin used in manifests | `https://download.eversay.cc` |

The DogeCloud permanent keys must exist only in GitHub repository secrets. CI signs
`/auth/tmp_token.json` requests and receives a temporary S3 credential scoped to
one exact object path. The workflow never prints permanent or temporary secrets.

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
produced for the Windows `*-setup.exe` / macOS `.app.tar.gz`. Common causes:
- The public key in `tauri.conf.json` doesn't match the private key used
  in CI — shouldn't happen unless keys were re-generated. Don't re-key
  without rotating both sides.
- The `.sig` text was mangled in transit. The publish job uses `jq --arg`
  which preserves multi-line text correctly; if you ever hand-author
  `latest.json`, paste the **whole** `.sig` content (multiple lines, as
  produced by Tauri) — do NOT base64-encode it.

### `Failed to fetch latest.json`
- Confirm the GitHub release is published, not a draft, and includes lowercase
  `latest.json`.
- Re-run **Release** for that existing version/tag to backfill DogeCloud; do not
  bump the app version for a CDN-only repair.
- Fetch `https://download.eversay.cc/latest.json` directly. If it is stale, the
  publish job did not complete its final manifest promotion.
- Test the affected CDN object with the anonymous `Range: bytes=0-0` GET above.

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
build (the `*-setup.exe` from the workflow artifact) instead.

## File locations summary

| File | Purpose | Where |
|---|---|---|
| Private signing key | Sign installers → produce `.sig` (shared by Win + Mac) | `secrets/whatsub.key` (repo backup) + `%USERPROFILE%\.tauri\whatsub.key` (active local copy) + `TAURI_SIGNING_PRIVATE_KEY` GitHub secret |
| Public verification key | Verify `.sig` in user's app | `client/src-tauri/tauri.conf.json` `plugins.updater.pubkey` (committed) |
| `RELEASES_REPO_TOKEN` | Cross-repository canonical GitHub release publication | Private-repo Actions secret; fine-grained PAT scoped to `rjxznb/whatsub-releases` with `Contents: Read and write` |
| `DOGECLOUD_*` | Permanent API keys, bucket, and public CDN domain | Four private-repo Actions secrets; never commit them |
| `release.yml` | Unified Win+Mac release workflow | `.github/workflows/release.yml` |
| `dogecloud_upload.py` | Scoped temporary-token S3 uploader | `scripts/dogecloud_upload.py` |
| `build-mac-binaries.yml` | (separate concern) Refresh Mac sidecar binaries committed to repo for local dev | `.github/workflows/build-mac-binaries.yml` |
| Built `*-setup.exe` + `*-setup.exe.sig` | Windows NSIS installer + updater signature | Built in CI runner, uploaded to release |
| Built `.dmg` | macOS installer (first install) | Built in CI runner, uploaded to release |
| Built `.app.tar.gz` + `.app.tar.gz.sig` | macOS updater bundle + signature | Built in CI runner, uploaded to release |
| GitHub `latest.json` | Canonical updater manifest | Generated by the `publish` job each release |
| DogeCloud `latest.json` | Stable mainland-first updater manifest | `https://download.eversay.cc/latest.json`, promoted after all assets |
