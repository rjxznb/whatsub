# Refreshing the DogeCloud yt-dlp mirror

The desktop app checks the DogeCloud CDN manifest and prompts users to
update. The manifest URL is stable, while binaries are immutable and versioned:

- `https://download.eversay.cc/yt-dlp/yt-dlp-version.json`
- `https://download.eversay.cc/yt-dlp/<version>/yt-dlp.exe`
- `https://download.eversay.cc/yt-dlp/<version>/yt-dlp_macos`

The binary and version-manifest requests use DogeCloud first and official yt-dlp
GitHub endpoints as fallback.

## The easy way: run the mirror workflow

GitHub → Actions → **Mirror yt-dlp to DogeCloud** → Run workflow (optional `notes`
shown in the in-app prompt). It pulls the official latest from GitHub, uploads
both binaries, then promotes the small version manifest last and verifies all
three public CDN URLs. No local downloads or tokens are needed; it uses the four
`DOGECLOUD_*` repository secrets.
Still read the compatibility checklist below first.

## The manual way (fallback if CI is unavailable)

1. Download the target yt-dlp from upstream GitHub:
   - `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe`
   - `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos`
   (Or a specific nightly if you track that channel.)
2. Get its version: `yt-dlp.exe --version` → e.g. `2026.07.01`.
3. Write `yt-dlp-version.json`:
   ```json
   { "version": "2026.07.01", "notes": "修复 YouTube 下载" }
   ```
4. Export the four `DOGECLOUD_*` variables, install `boto3`, and use
   `scripts/dogecloud_upload.py` to upload both binaries under their version directory first. Upload
   `yt-dlp-version.json` last with `--cache-control 'no-cache, max-age=60'`.

After either path, verify every public asset anonymously. Use an HTTP GET with
`Range: bytes=0-0`; do not use `HEAD`. Each request must return exactly `206` and
`Content-Range: bytes 0-0/<positive-size>`. Retry the workflow after transient
upstream or DogeCloud failures; its replacement upload is safe to rerun. If an asset
was partially refreshed, rerun the workflow to backfill all three assets—do not
create a new app version for a yt-dlp mirror repair.

## Before publishing a newer yt-dlp, re-check compatibility

Newer yt-dlp can change CLI flags or runtime requirements. whatsub passes these
flags (`pipeline/ytdlp.rs`): `--js-runtimes node:<path>`, `--cookies`,
`--ffmpeg-location`, `-f`, `-o`, `--merge-output-format`, `--no-playlist`,
`--continue`, `--retries`, `--fragment-retries`, `--retry-sleep`,
`--socket-timeout`, `--newline`, `--progress-template`, `--postprocessor-args`,
`--write-info-json`, `--write-thumbnail`, `--proxy`.

Skim the target release's changelog for:
- Any of those flags being removed/renamed (especially `--js-runtimes`).
- Raised **runtime minimums** — whatsub bundles a `node` sidecar; e.g. yt-dlp
  2026.06.09 requires Node ≥ v22 and whatsub bundles v22.11.0. If a newer yt-dlp
  requires a higher Node, the bundled node sidecar must be upgraded IN THE SAME
  app release (they are coupled). GitHub fallback is always the official latest,
  so this coupling matters most when the app's bundled node lags.
