# Releasing Eversay Studio

How to ship a new version that existing users will pick up via auto-update.

## One-time setup

### Public release repo

The auto-updater fetches `latest.json` from a publicly-readable URL. Our
private repo can't serve release assets publicly, so we use a separate
public repo for distribution only.

**Create it once on GitHub** (UI):

1. New → Repository → Name: `Get_Video-releases` → **Public** → Create
2. The endpoint baked into the app is:
   ```
   https://github.com/rjxznb/Get_Video-releases/releases/latest/download/latest.json
   ```
   (configured in `src-tauri/tauri.conf.json` `plugins.updater.endpoints`)
3. If you want a different repo name, update that endpoint AND the URL paths
   below.

### Signing keys (already done)

Located at `secrets/eversay-studio.key` (private repo backup) and
`%USERPROFILE%\.tauri\eversay-studio.key` (active local copy).

The public key is embedded in `tauri.conf.json` `plugins.updater.pubkey`.

**Don't re-generate** unless you've truly lost the private key — re-keying
breaks auto-update for all existing installs (they have the old public key
burned in and won't accept signatures from a new private key). Users would
have to manually reinstall.

## Per-release steps

### 1. Bump the version (3 places must match)

Edit:

- `client/package.json` → `"version": "X.Y.Z"`
- `client/src-tauri/tauri.conf.json` → `"version": "X.Y.Z"`
- `client/src-tauri/Cargo.toml` → `version = "X.Y.Z"`

Semver guidance:
- Patch (0.1.0 → 0.1.1) — bug fixes only
- Minor (0.1.0 → 0.2.0) — new features, backward compatible
- Major (0.1.0 → 1.0.0) — breaking changes (rare)

### 2. Build with signing

```powershell
# PowerShell on Windows
cd C:\Users\renjx\Desktop\Get_Video\client

# Read the private key into env (no password set on this key)
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$env:USERPROFILE\.tauri\eversay-studio.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

pnpm tauri build
```

```bash
# Or in Git Bash
cd "C:/Users/renjx/Desktop/Get_Video/client"
TAURI_SIGNING_PRIVATE_KEY="$(cat $USERPROFILE/.tauri/eversay-studio.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
pnpm tauri build
```

Build takes 5–15 minutes. Watch for `--- Bundling .msi ---` near the end.

### 3. Find the artifacts

```
src-tauri/target/release/bundle/msi/
├── Eversay Studio_X.Y.Z_x64_en-US.msi          ← installer
└── Eversay Studio_X.Y.Z_x64_en-US.msi.sig      ← detached signature
```

> Tauri's `bundle.createUpdaterArtifacts: true` setting (already configured)
> ensures the `.sig` is produced. If missing, double-check the env vars set
> in step 2.

### 4. Author `latest.json`

The file the updater fetches to decide if there's a new version. Create
locally:

```json
{
  "version": "X.Y.Z",
  "notes": "Brief, user-facing release notes (shown in the toast).",
  "pub_date": "2026-04-28T10:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<paste contents of .msi.sig file here, single line>",
      "url": "https://github.com/rjxznb/Get_Video-releases/releases/download/vX.Y.Z/Eversay.Studio_X.Y.Z_x64_en-US.msi"
    }
  }
}
```

Notes on each field:
- `version` — must match the version in `tauri.conf.json` exactly
- `notes` — Markdown is OK; shown in the update toast
- `pub_date` — ISO 8601 UTC, used to display "X days ago"
- `signature` — the **whole text content** of `.msi.sig` (multiple lines),
  paste as-is (or join with `\n` if your JSON requires single-line strings)
- `url` — the full download URL of the .msi as hosted on the release repo.
  Note the URL uses dots not spaces in the filename — Tauri's GitHub release
  upload mangles spaces; either rename the file before upload or write the
  URL with whatever the actual asset URL becomes.

### 5. Cut a GitHub Release

On the public release repo (`rjxznb/Get_Video-releases`):

1. Releases → "Draft a new release"
2. Tag: `vX.Y.Z` (create new)
3. Title: `Eversay Studio vX.Y.Z`
4. Description: paste the same notes as in `latest.json`
5. Drag-drop the three files as release assets:
   - `Eversay Studio_X.Y.Z_x64_en-US.msi`
   - `Eversay Studio_X.Y.Z_x64_en-US.msi.sig`
   - `latest.json`
6. **Mark as latest release** (default if vX.Y.Z is the highest tag)
7. Publish

### 6. Verify

Wait ~30 seconds, then check that the `latest.json` is fetchable from
the URL the app uses:

```bash
curl https://github.com/rjxznb/Get_Video-releases/releases/latest/download/latest.json
```

Should return the JSON you uploaded. If 404, double-check:
- Release was actually published (not still draft)
- Asset filename is exactly `latest.json` (case-sensitive)

### 7. Test the update path

On a machine with the previous version installed:

1. Restart the app
2. ~3 seconds after launch, the bottom-right toast should appear:
   "发现新版本 vX.Y.Z"
3. Click "立即更新" → progress bar → app restarts → new version

Or trigger manually: Settings → 应用版本 → 「检查更新」.

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

### `signature verification failed`
The `.sig` content in `latest.json` doesn't match what Tauri's signing
produced for the .msi. Common causes:
- `.sig` was edited (whitespace, missing trailing newline) — re-export
  fresh and paste the raw contents
- `.msi` URL points to a different file than the `.sig` was signed for —
  re-build and re-upload both together
- The public key in `tauri.conf.json` doesn't match the private key —
  shouldn't happen unless keys were re-generated mid-cycle

### `Failed to fetch latest.json`
- Public repo not actually public: verify in repo settings
- Asset name typo: must be exactly `latest.json` (lowercase, .json suffix)
- The `/latest/download/` URL only works on the most-recent release tagged
  as "latest" — make sure you marked it as such

### Auto-check seems disabled
In dev mode (`pnpm tauri dev`), the auto-check still runs but Tauri's
endpoint check often fails because the dev binary's version (0.1.0) matches
or exceeds whatever's deployed. Test the update path in a built MSI instead.

## File locations summary

| File | Purpose | Where |
|---|---|---|
| Private signing key | Sign .msi → produce .sig | `secrets/eversay-studio.key` (repo backup) + `%USERPROFILE%\.tauri\eversay-studio.key` (active) |
| Public verification key | Verify .sig in user's app | `client/src-tauri/tauri.conf.json` `plugins.updater.pubkey` (committed) |
| Built .msi | The installer | `client/src-tauri/target/release/bundle/msi/*.msi` |
| Built .msi.sig | Detached Ed25519 signature | Same dir as the .msi |
| `latest.json` | Update manifest the app fetches | Hand-authored each release; uploaded to public release repo |
