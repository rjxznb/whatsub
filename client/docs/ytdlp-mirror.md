# Manually refreshing the JiHuLab yt-dlp mirror

The desktop app checks `.../releases/yt-dlp/downloads/yt-dlp-version.json` on the
JiHuLab `whatsub-release` project (a fixed release tag named `yt-dlp`) and prompts
users to update. That mirror is refreshed manually — you decide when.

## The easy way: run the mirror workflow

GitHub → Actions → **Mirror yt-dlp to JiHuLab** → Run workflow (optional `notes`
shown in the in-app prompt). It pulls the official latest from GitHub, uploads
all three assets to the `yt-dlp` tag, and verifies the public URLs — ~1 min,
no local downloads or tokens needed (uses the repo's `GITLAB_TOKEN` secret).
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
4. Upload all THREE assets to the `yt-dlp` release tag on
   `rjxznb-group/whatsub-release` (overwrite/clobber the existing ones), so the
   fixed download URLs keep pointing at the new files.

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
