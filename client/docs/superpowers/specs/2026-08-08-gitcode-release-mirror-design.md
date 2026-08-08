# GitCode Release Mirror Design

## Goal

Replace the expired JiHuLab release mirror with the public GitCode project
`rjxznb/whatsub-release`, while keeping GitHub as the canonical international
release source and preserving signed Tauri updates on Windows and macOS.

## Confirmed platform behaviour

- GitCode accepts Release attachments up to 2 GB.
- A real 273 MiB attachment uploaded successfully.
- Anonymous `GET` downloads redirect to GitCode CDN and support byte ranges
  (`206 Partial Content`).
- Anonymous `HEAD` returns `401`, so health checks must use
  `GET` with `Range: bytes=0-0`.
- The stable public asset pattern is
  `https://gitcode.com/rjxznb/whatsub-release/releases/download/<tag>/<file>`.

## Architecture

GitHub remains the source of truth. The existing release workflow builds and
publishes the signed artifacts to `rjxznb/whatsub-releases` first. A separate,
retryable GitCode mirror workflow then reads the complete GitHub Release and
its `latest.json`, uploads all required files into versioned GitCode Releases,
verifies each uploaded file anonymously, and only then updates the public
GitCode `main/latest.json` pointer.

The desktop updater endpoints become:

1. `https://gitcode.com/rjxznb/whatsub-release/raw/main/latest.json`
2. `https://github.com/rjxznb/whatsub-releases/releases/latest/download/latest.json`

The JiHuLab endpoint is removed from new builds. GitCode's manifest contains
GitCode asset URLs but the same minisign signatures produced by Tauri.

## Workflow boundaries

### GitCode mirror workflow

A reusable workflow supports both `workflow_call` and manual
`workflow_dispatch` with an explicit release tag. This gives the normal
release workflow an automatic mirror stage and also provides a no-build repair
or backfill path.

For a requested tag it:

1. Downloads that GitHub Release's assets and complete `latest.json`.
2. Creates or updates the matching GitCode tag and Release.
3. Uploads the current version's installer, updater bundles and signatures.
4. Mirrors any updater artifact referenced by the GitHub manifest but carried
   over from an older tag, if it is not already present on GitCode.
5. Rewrites platform URLs to their GitCode versioned asset URLs without
   changing signatures.
6. Verifies every referenced asset using an anonymous one-byte range request.
7. Updates `main/latest.json` only after every platform passes verification.

The workflow is idempotent: rerunning a tag replaces matching assets and
regenerates the manifest. A mirror failure marks the workflow failed but does
not roll back or delete the already-valid GitHub release.

### Application release workflow

The JiHuLab upload block is removed. After the GitHub publish job succeeds, the
release workflow invokes the reusable GitCode mirror workflow with the current
tag. A regular `dry_run=true` still builds artifacts only and does not publish
to either release repository.

### yt-dlp mirror

The manual yt-dlp mirror workflow publishes `yt-dlp.exe`, `yt-dlp_macos`, and
`yt-dlp-version.json` to a fixed GitCode Release/tag. Runtime update URLs use
GitCode first and official GitHub second. A GitCode failure remains advisory;
the official GitHub fallback continues to work.

## Authentication and secret handling

A GitCode personal access token is scoped to repository/Release write access
for `rjxznb/whatsub-release`. It is stored only as the GitHub Actions secret
`GITCODE_TOKEN`. It must not be written into repository files, command output,
release notes, or persistent local files. CI passes it in an authorization
header or a temporary credential file that is deleted before the job exits.

## Partial-platform releases

The GitHub `latest.json` is authoritative for which platform entries must
remain available. When a single-platform release carries the other platform
from an older GitHub tag, the GitCode workflow preserves that older tag in the
rewritten URL and ensures the referenced asset exists on GitCode. A retry may
therefore never silently remove `windows-x86_64` or `darwin-aarch64`.

## Old-client migration

Clients through 0.1.108 still try JiHuLab before GitHub. JiHuLab currently
serves an old but syntactically valid manifest, preventing fallback. After the
GitCode mirror and GitHub fallback are verified, the JiHuLab `latest.json`
must be made unavailable (private project or removed latest asset). Old clients
then fail that endpoint and continue to GitHub. Mainland users who cannot reach
GitHub must manually install the first GitCode-enabled release once.

Existing historical GitHub releases are never deleted. The JiHuLab yt-dlp URLs
may fail after decommissioning, which is safe because the runtime already has
an official GitHub fallback.

## Documentation changes

`README.md`, `RELEASE.md`, `CLAUDE.md`, `CLAUDE-FEATURES.md`, and the yt-dlp
mirror runbook must describe GitCode instead of JiHuLab, including the 2 GB
limit, GET-range health check, token rotation, manual backfill, and old-client
bridge behaviour.

## Verification

- Parse all modified YAML and JSON.
- Run tests covering updater endpoint configuration and yt-dlp URL ordering.
- Run the existing frontend and Rust test suites affected by configuration.
- Manually dispatch the GitCode mirror workflow for `v0.1.108` without a new
  app build.
- Confirm public `main/latest.json` is valid and contains both platforms.
- Confirm each manifest URL returns `206` for `Range: bytes=0-0` without auth.
- Confirm the GitCode Release shows the expected file sizes.
- Only after those checks, disable the stale JiHuLab manifest.

## Out of scope

- Moving the private source repository away from GitHub.
- Changing Tauri signing keys or updater signatures.
- Publishing a new application version as part of the migration dry-run.
- Adding a new paid storage or proxy service.
