# Existing Video Overwrite Design

## Goal

When a user imports a URL or local file that resolves to a video already present in the local library, show a clear confirmation instead of continuing into a file collision or exposing a technical error. A confirmed replacement must not destroy the usable existing video unless the replacement pipeline completes successfully.

## Current behavior and root cause

`import_video` derives a deterministic `video_id` from the URL or local-file hash and immediately reuses `paths::video_dir(video_id)`. It only fences an import already active in the in-memory registry. It does not classify a completed library entry as a duplicate before starting the pipeline.

Consequently, a second import can reuse old files, overwrite part of an existing result, or surface a low-level task/file error. The frontend has no stable backend signal with which to ask the user whether replacement is intended.

## User experience

- Before a manual foreground or background import starts, the app asks the backend whether that source resolves to an existing local video.
- If none exists, import proceeds normally.
- If the same video is currently being downloaded, transcoded, or transcribed, the app reports that it is already being processed and does not offer destructive replacement.
- If a completed, failed, or crash-leftover library entry exists, the app displays an app-styled confirmation:
  - Title: `视频已存在`
  - Message: `“<title>”已经在语料库中。是否覆盖并重新下载、转录和解析？`
  - Primary action: `覆盖并重新解析`
  - Secondary action: `取消`
  - The primary action uses destructive styling.
- Cancelling leaves the current video untouched and keeps the import form open.
- Confirming starts a staged replacement. Existing playable media, transcript, analysis, metadata, folder membership, and sync metadata remain available until the staged replacement succeeds.

## Backend interfaces

Add a read-only Tauri command:

```rust
import_preflight(
    state: State<'_, ImportState>,
    source_kind: String,
    source_value: String,
) -> AppResult<ImportPreflight>
```

`ImportPreflight` is serialized with camel-case fields and has:

```rust
pub struct ImportPreflight {
    pub video_id: String,
    pub state: ImportPreflightState, // Missing | Existing | Running
    pub title: Option<String>,
}
```

The command and `import_video` share one source-to-ID helper so local files and URL imports cannot disagree about identity.

Extend `ImportRequest` with `overwrite: bool`, defaulting to `false` for all existing callers. The backend remains authoritative:

- Existing entry plus `overwrite == false` returns a stable `video_exists:<video_id>` error before creating or modifying files.
- An active same-video task always returns `import already running:<video_id>`, even if `overwrite == true`.
- `overwrite == true` is accepted only after the same-video registry fence has been acquired.

This defense prevents AI tools, queue retries, older frontends, and race conditions from silently overwriting an entry.

## Staged replacement

For a confirmed overwrite, run the complete download/local conversion, thumbnail extraction, audio extraction, and Whisper transcription in a unique sibling staging directory. Do not call `library_upsert` for the staged result while it is incomplete.

After the pipeline succeeds:

1. Enter the existing analysis-store destructive boundary for the video ID.
2. Rename the current canonical video directory to a unique backup directory when it exists.
3. Rename the staging directory to the canonical video directory.
4. Replace the library entry while preserving its original folder placement. The new entry points at the canonical directory. Existing sync metadata is cleared because the local content has changed.
5. If the index write or directory promotion fails, restore the backup and retain the old library entry.
6. After a successful index update, remove the backup directory.

The returned `srtPath` must reference the canonical directory, never the staging path.

If download, conversion, transcription, cancellation, or shutdown occurs before promotion, remove only the staging directory. The old library entry and its files remain untouched.

## Normal import behavior

New imports keep their current lifecycle and progress events. The overwrite implementation must not change download retry policy, scheduling limits, cancellation semantics, foreground/background behavior, or analysis startup.

The existing same-video registry remains the concurrency authority. Preflight is advisory for UX; `import_video` repeats the duplicate and running checks after acquiring current state so a race cannot bypass safety.

## Frontend flow

`ImportModal.submit()` performs preflight after input/model/quota validation but before changing to the progress view or closing for background mode.

- `Missing`: submit once with `overwrite: false`.
- `Running`: show `该视频正在下载或解析，请等待当前任务完成。`; do not invoke `import_video`.
- `Existing`: await `confirmDialog`; cancel returns to the form, confirm submits once with `overwrite: true`.
- A backend `video_exists:` race is converted into the same confirmation flow rather than the generic troubleshooting checklist.

Only the interactive `ImportModal` can authorize overwrite. Agent and unattended queue imports continue sending the default `overwrite: false` and receive a clear “already exists” result instead of deleting content.

## Error handling

- Preflight read errors use the existing import error surface and do not start an import.
- Promotion errors identify the replacement/promotion step and guarantee rollback is attempted.
- If rollback itself fails, the error includes both promotion and rollback failures; backup and staging paths are retained for recovery rather than deleted blindly.
- Cancellation cleanup distinguishes normal partial imports from staged replacements so it never calls `library_delete` on the old entry.

## Tests

Rust tests cover:

- URL and local source identity shared by preflight and import.
- Missing, existing, and running preflight states.
- Existing entry rejected without overwrite.
- Active job rejected even with overwrite.
- Staged cancellation/failure preserves old files and entry.
- Successful promotion swaps directories, points the result at the canonical path, preserves folder placement, and clears stale sync metadata.
- Failed promotion restores the old directory and entry.

Frontend tests cover:

- Missing source starts import without a dialog and sends `overwrite: false`.
- Existing source opens the exact confirmation and does not start before confirmation.
- Cancel keeps the form open and does not import.
- Confirm starts foreground or background import with `overwrite: true`.
- Running state displays the focused message without opening the generic failure checklist.
- A backend duplicate race reuses the confirmation flow.

## Non-goals

- No automatic overwrite.
- No overwrite confirmation inside AI chat.
- No change to cloud-library replacement or sync conflict behavior.
- No CI or release as part of this change.
