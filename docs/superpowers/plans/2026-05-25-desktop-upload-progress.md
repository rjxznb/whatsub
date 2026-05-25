# 桌面端 OSS 上传进度 + 失败可见 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop OSS-upload step visible — real transcode % + an "uploading" spinner in the existing background-jobs widget — and surface upload failure as a retryable 「上传失败」 instead of silently marking the entry done.

**Architecture:** Rust `upload_video` emits a new `PipelineEvent::Uploading{video_id,percent}` during the 720p transcode (reusing the export feature's `extract_time_field` ffmpeg-progress pattern) and `library_sync_to_cloud` returns `videoUploaded` + writes `sync_error="video_upload_failed"` on failure (keeping the entry). The frontend rides the existing `useDownloadQueue` pipeline-event store + `DownloadQueueWidget`: callers (queue worker + manual SyncButton) upsert an "uploading" row before sync and set the terminal `done`/`upload_failed` state from `videoUploaded`; the Library card's existing `syncError` path shows persistent failed+retry.

**Tech Stack:** Tauri (Rust `src-tauri` + React/TS `client`), zustand stores, vitest (client tests), `pipeline-event` Tauri events.

---

## Repo & branch

All work in **`C:\Users\renjx\Desktop\Get_Video`**. Create a branch first:
`git checkout -b feat/desktop-upload-progress`

**Build/verify commands (run from `Get_Video/client`):**
- Rust: `cd src-tauri && cargo build && cargo clippy --all-targets -- -D warnings && cargo test` (the existing `extract_time_field` tests live here).
- TS: `pnpm typecheck` (or `pnpm tsc --noEmit`), `pnpm test` (vitest), `pnpm build`.
- (No `cargo build` of the full Tauri app needed to compile Rust; `cargo build` in `src-tauri` is enough.)

## File structure (what changes & why)

**Rust (`src-tauri/src`):**
- `core/progress.rs` — add `Uploading { video_id, percent }` event variant.
- `commands/analysis.rs` — make `extract_time_field` `pub(crate)` (reuse from ffmpeg.rs).
- `pipeline/ffmpeg.rs` — `transcode_720p` gains `duration_sec` + emits `Uploading{percent}` per ffmpeg `time=` line.
- `commands/library_sync.rs` — pass duration to `upload_video`; emit `Uploading{percent:100}` before the PUT; `SyncOk` gains `video_uploaded`; set `sync_error="video_upload_failed"` when the upload returns None (entry still synced).

**TS (`client/src`):**
- `lib/api/librarySync.ts` — `SyncOk.videoUploaded`.
- `store/downloadQueue.ts` — `QueuePhase` gains `"uploading" | "upload_failed"`; extract a testable `applyPipelineEvent`; handle the `Uploading` event.
- `components/DownloadQueueWidget.tsx` — render `uploading` (transcode % / "正在上传…" spinner) + `upload_failed` (with 「重试上传」).
- `store/importQueue.ts` — step 5: upsert an "uploading" row before `syncToCloud`; branch on `videoUploaded`.
- `components/LibraryCard/SyncButton.tsx` — check `videoUploaded`; `friendlySyncError` maps `video_upload_failed`.

---

# PART A — Rust (src-tauri)

## Task A1: Add the `Uploading` pipeline event

**Files:**
- Modify: `src-tauri/src/core/progress.rs` (the `PipelineEvent` enum, after the `Exported` variant ~line 94-97)

- [ ] **Step 1: Add the variant**

In `core/progress.rs`, inside `pub enum PipelineEvent { … }`, after the `Exported { … }` variant, add:

```rust
    /// OSS upload progress for library cloud-sync. `percent` = 720p transcode
    /// 0–99; once transcode is done we emit percent=100 to mean "transcode
    /// finished, PUT in flight" (frontend shows an indeterminate spinner).
    Uploading {
        video_id: String,
        percent: u8,
    },
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds clean (no other code references it yet).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/core/progress.rs
git commit -m "feat(progress): add Uploading pipeline event for OSS upload"
```

## Task A2: Emit real transcode % from `transcode_720p`

**Files:**
- Modify: `src-tauri/src/commands/analysis.rs` (make `extract_time_field` reusable, ~line 322)
- Modify: `src-tauri/src/pipeline/ffmpeg.rs` (`transcode_720p`, lines 139-165)

- [ ] **Step 1: Make `extract_time_field` reusable**

In `commands/analysis.rs`, change the helper's visibility (line ~322) from `fn extract_time_field` to:

```rust
pub(crate) fn extract_time_field(line: &str) -> Option<f64> {
```

(Body unchanged. Its existing `#[cfg(test)]` tests stay.)

- [ ] **Step 2: Add `duration_sec` + progress emission to `transcode_720p`**

In `pipeline/ffmpeg.rs`, replace the whole `transcode_720p` function (lines 139-165) with:

```rust
pub async fn transcode_720p(
    app: &AppHandle,
    src_path: &Path,
    out_path: &Path,
    video_id: &str,
    duration_sec: f64,
    cancel: Option<&CancellationToken>,
) -> AppResult<()> {
    use crate::commands::analysis::extract_time_field;
    use crate::core::progress::{emit, PipelineEvent};

    let src = src_path.to_string_lossy().to_string();
    let out = out_path.to_string_lossy().to_string();

    // Progress-aware stderr sink: surface raw ffmpeg lines as Log events (same
    // as make_log_emitter) AND parse `time=` → emit Uploading{percent} (0–99),
    // mirroring the burn-in export progress in commands/analysis.rs.
    let app_for_log = app.clone();
    let vid = video_id.to_string();
    let mut last_percent: u8 = 0;
    let log = move |line: &str| {
        emit(
            &app_for_log,
            PipelineEvent::Log {
                video_id: vid.clone(),
                source: "ffmpeg".into(),
                line: line.into(),
            },
        );
        if let Some(secs) = extract_time_field(line) {
            if duration_sec > 0.0 {
                let pct = ((secs / duration_sec) * 100.0).clamp(0.0, 99.0) as u8;
                if pct != last_percent {
                    last_percent = pct;
                    emit(
                        &app_for_log,
                        PipelineEvent::Uploading {
                            video_id: vid.clone(),
                            percent: pct,
                        },
                    );
                }
            }
        }
    };

    run_sidecar(
        app,
        "ffmpeg",
        &[
            "-y", "-i", &src,
            "-vf", "scale=-2:'min(720,ih)'",
            "-c:v", "libx264", "-crf", "23", "-preset", "veryfast",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            &out,
        ],
        log,
        cancel,
    )
    .await?;
    Ok(())
}
```

(`run_sidecar` takes `F: FnMut(&str)`, so the `mut last_percent` capture is fine. The old `make_log_emitter(app, video_id)` line is removed — replaced by the closure above.)

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: FAILS — `transcode_720p`'s only caller (`commands/library_sync.rs:332`) now passes the wrong number of args. That's fixed in Task A3. (If you want a green checkpoint here, temporarily skip; A3 fixes the caller. Proceed to A3 before committing.)

- [ ] **Step 4: (after A3) build + clippy + test**

Run: `cd src-tauri && cargo build && cargo clippy --all-targets -- -D warnings && cargo test`
Expected: PASS (incl. the existing `extract_time_field` tests).

- [ ] **Step 5: Commit (together with A3)**

See A3 Step 4.

## Task A3: Thread duration + report `videoUploaded` + mark `sync_error`

**Files:**
- Modify: `src-tauri/src/commands/library_sync.rs` — `SyncOk` (lines 23-28), `upload_video` (lines 319-390), `library_sync_to_cloud` (the `upload_video` call ~149-150, the transcode call ~332, the return ~199-206)

- [ ] **Step 1: Extend `SyncOk`**

Replace the `SyncOk` struct (lines 23-28) with:

```rust
#[derive(Serialize)]
pub struct SyncOk {
    pub ok: bool,
    #[serde(rename = "syncedAt")]
    pub synced_at: i64,
    /// Whether the OSS video upload succeeded. false → entry synced
    /// captions-only (iOS needs VPN); UI shows 上传失败 · 重试上传.
    #[serde(rename = "videoUploaded")]
    pub video_uploaded: bool,
}
```

- [ ] **Step 2: Give `upload_video` the duration + emit the PUT marker**

Change `upload_video`'s signature (line 319-324) to add `duration_sec: f64`:

```rust
async fn upload_video(
    app: &AppHandle,
    video_dir: &str,
    id: &str,
    token: &str,
    duration_sec: f64,
) -> Option<String> {
```

Update its transcode call (line 332) to pass `duration_sec`:

```rust
    crate::pipeline::ffmpeg::transcode_720p(app, &src, &mobile, id, duration_sec, None)
        .await
        .ok()?;
```

Immediately AFTER the transcode call (before "Step 2: request a presigned PUT URL"), add the "entering upload" marker so the frontend switches to the spinner:

```rust
    // Transcode done — signal the PUT phase (frontend shows an indeterminate
    // "正在上传…" spinner; we don't track byte-level PUT progress).
    crate::core::progress::emit(
        app,
        crate::core::progress::PipelineEvent::Uploading {
            video_id: id.to_string(),
            percent: 100,
        },
    );
```

- [ ] **Step 3: Pass duration at the call site + report videoUploaded + sync_error**

In `library_sync_to_cloud`, change the `upload_video` call (lines 149-150) to pass the entry duration:

```rust
    let video_key: Option<String> =
        upload_video(&app, video_dir, &id, &auth_state.session_token, entry.duration_sec as f64).await;
```

Then replace the `// 5. Persist syncedAt` block + the `Ok(SyncOk{…})` (lines 199-206) with:

```rust
    // 5. Persist syncedAt. On OSS-upload failure keep the entry (captions
    // synced) but record sync_error so the card + queue show 上传失败 · 重试.
    let sync_error = if video_key.is_none() {
        Some("video_upload_failed".to_string())
    } else {
        None
    };
    crate::commands::library::set_synced_at(&id, Some(now), sync_error)
        .map_err(|e| format!("library write: {e}"))?;

    Ok(SyncOk {
        ok: true,
        synced_at: now,
        video_uploaded: video_key.is_some(),
    })
```

- [ ] **Step 4: Build + clippy + test, then commit A2+A3**

Run: `cd src-tauri && cargo build && cargo clippy --all-targets -- -D warnings && cargo test`
Expected: PASS.

```bash
git add src-tauri/src/commands/analysis.rs src-tauri/src/pipeline/ffmpeg.rs src-tauri/src/commands/library_sync.rs
git commit -m "feat(library-sync): emit transcode % + report videoUploaded + sync_error on upload fail"
```

---

# PART B — TS (client)

> Run from `Get_Video/client`. `pnpm test` = vitest.

## Task B1: `videoUploaded` in the sync API

**Files:**
- Modify: `client/src/lib/api/librarySync.ts` (`SyncOk`, lines 13-16)

- [ ] **Step 1: Extend the `SyncOk` interface**

Replace (lines 13-16):

```ts
export interface SyncOk {
  ok: boolean;
  syncedAt: number;
  /** false → captions synced but the OSS video upload failed (iOS needs VPN). */
  videoUploaded: boolean;
}
```

- [ ] **Step 2: Add the friendly message for the new failure code**

In `friendlySyncError` (after the `quota_exceeded` block, before `if (raw.startsWith("http "))`):

```ts
  if (raw === "video_upload_failed") {
    return "视频上传失败 · 点重试上传（字幕已同步，手机暂需 VPN）";
  }
```

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add client/src/lib/api/librarySync.ts
git commit -m "feat(ios? no, desktop)/sync-api: SyncOk.videoUploaded + video_upload_failed message"
```

## Task B2: Handle the `Uploading` event in the download-queue store

**Files:**
- Modify: `client/src/store/downloadQueue.ts` (QueuePhase line 16-22; PipelineEvent union 109-117; refactor listener switch into a testable `applyPipelineEvent`)
- Test: `client/src/store/downloadQueue.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `client/src/store/downloadQueue.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useDownloadQueue, applyPipelineEvent } from "./downloadQueue";

describe("applyPipelineEvent — Uploading", () => {
  beforeEach(() => {
    useDownloadQueue.setState({ entries: {} });
  });

  it("upserts an uploading entry with transcode percent", () => {
    applyPipelineEvent({ stage: "Uploading", video_id: "vid1", percent: 42 });
    const e = useDownloadQueue.getState().entries["vid1"];
    expect(e).toBeTruthy();
    expect(e.phase).toBe("uploading");
    expect(e.percent).toBe(42);
  });

  it("updates an existing entry's percent", () => {
    useDownloadQueue.getState().upsert("vid1", {
      videoId: "vid1", sourceKind: "url", sourceValue: "u", label: "L",
      phase: "uploading", percent: 10, startedAt: 1,
    });
    applyPipelineEvent({ stage: "Uploading", video_id: "vid1", percent: 90 });
    expect(useDownloadQueue.getState().entries["vid1"].percent).toBe(90);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test downloadQueue`
Expected: FAIL — `applyPipelineEvent` is not exported.

- [ ] **Step 3: Implement**

In `client/src/store/downloadQueue.ts`:

(a) Extend `QueuePhase` (lines 16-22):

```ts
export type QueuePhase =
  | "started"
  | "downloading"
  | "extracting"
  | "transcribing"
  | "uploading"
  | "done"
  | "upload_failed"
  | "error";
```

(b) Add `Uploading` to the `PipelineEvent` types (after `Failed`, line 109):

```ts
type Uploading = { stage: "Uploading"; video_id: string; percent: number };
```

and add `| Uploading` to the `PipelineEvent` union (line 110-117).

(c) Extract the switch into an exported pure function. Replace the body of the `listen` callback (lines 145-210) so it delegates, and add the function. Specifically, replace:

```ts
  unlisten = await listen<PipelineEvent>("pipeline-event", (e) => {
    const ev = e.payload;
    const store = useDownloadQueue.getState();

    switch (ev.stage) {
      case "Started": {
        ...
      }
      ...
    }
  });
```

with:

```ts
  unlisten = await listen<PipelineEvent>("pipeline-event", (e) => {
    applyPipelineEvent(e.payload);
  });
```

and define (e.g. just above `mountDownloadQueueListener`):

```ts
/** Pure reducer for pipeline events → download-queue store. Exported for tests. */
export function applyPipelineEvent(ev: PipelineEvent): void {
  const store = useDownloadQueue.getState();
  switch (ev.stage) {
    case "Started": {
      const s = ev as Started;
      if (!s.background) return;
      store.upsert(s.video_id, {
        videoId: s.video_id,
        sourceKind: s.source_kind ?? "url",
        sourceValue: s.source_value ?? "",
        label: deriveLabel(s.source_kind ?? "url", s.source_value ?? ""),
        phase: "started",
        percent: 0,
        startedAt: Date.now(),
      });
      break;
    }
    case "Downloading": {
      const d = ev as Downloading;
      store.update(d.video_id, {
        phase: "downloading",
        percent: d.percent,
        speed: d.speed ?? null,
        eta: d.eta ?? null,
        total: d.total ?? null,
      });
      break;
    }
    case "ExtractingAudio": {
      const x = ev as Extracting;
      store.update(x.video_id, { phase: "extracting", percent: 0 });
      break;
    }
    case "Transcribing": {
      const t = ev as Transcribing;
      store.update(t.video_id, { phase: "transcribing", percent: t.percent });
      break;
    }
    case "Transcribed": {
      const t = ev as Transcribed;
      store.update(t.video_id, { phase: "done", percent: 100 });
      setTimeout(() => {
        useDownloadQueue.getState().remove(t.video_id);
      }, 4000);
      break;
    }
    case "Uploading": {
      const u = ev as Uploading;
      const cur = store.entries[u.video_id];
      if (cur) {
        store.update(u.video_id, { phase: "uploading", percent: u.percent, error: null });
      } else {
        // Upload events can arrive after the download entry was auto-removed
        // (download → analysis → upload are temporally separate). Upsert a
        // minimal row; the caller (importQueue/SyncButton) normally upserts a
        // labelled one first, so this is a fallback.
        store.upsert(u.video_id, {
          videoId: u.video_id,
          sourceKind: "url",
          sourceValue: "",
          label: u.video_id,
          phase: "uploading",
          percent: u.percent,
          startedAt: Date.now(),
        });
      }
      break;
    }
    case "Failed": {
      const f = ev as Failed;
      store.update(f.video_id, { phase: "error", error: f.error });
      break;
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test downloadQueue`
Expected: PASS (2 tests). Also `pnpm typecheck` PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/store/downloadQueue.ts client/src/store/downloadQueue.test.ts
git commit -m "feat(download-queue): uploading/upload_failed phases + Uploading event reducer"
```

## Task B3: Render uploading + upload_failed in the widget

**Files:**
- Modify: `client/src/components/DownloadQueueWidget.tsx`

- [ ] **Step 1: `isTerminalPhase` + retry plumbing**

Replace `isTerminalPhase` (lines 144-146):

```ts
function isTerminalPhase(item: UnifiedItem): boolean {
  return item.phase === "done" || item.phase === "error" || item.phase === "upload_failed";
}
```

Add an `onRetry` prop to `Row` and wire it from the widget. In the `<Row … />` usage (lines 109-120), add:

```tsx
                onRetry={() => {
                  if (item.kind === "download") void retryUpload(item.videoId);
                }}
```

Add the import + retry helper near the top of the file (after the existing imports):

```ts
import { syncToCloud } from "../lib/api/librarySync";

async function retryUpload(videoId: string): Promise<void> {
  useDownloadQueue.getState().update(videoId, { phase: "uploading", percent: 0, error: null });
  try {
    const r = await syncToCloud(videoId);
    if (r.videoUploaded) {
      useDownloadQueue.getState().remove(videoId);
    } else {
      useDownloadQueue.getState().update(videoId, { phase: "upload_failed", error: "video_upload_failed" });
    }
  } catch (e) {
    useDownloadQueue.getState().update(videoId, { phase: "upload_failed", error: String(e) });
  }
}
```

- [ ] **Step 2: `Row` — render uploading spinner + upload_failed + retry button**

Update the `Row` signature (lines 148-156) to accept `onRetry`:

```tsx
function Row({
  item,
  onCancel,
  onDismiss,
  onRetry,
}: {
  item: UnifiedItem;
  onCancel: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}) {
```

Inside `Row`, the progress bar currently shows for `!isTerminal`. For `uploading` with `percent>=100` we want a spinner-feel (no determinate bar). Replace the progress-bar block (lines 178-185) with:

```tsx
      {!isTerminal && !(item.phase === "uploading" && item.percent >= 100) && (
        <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full transition-all duration-300 bg-blue-500"
            style={{ width: `${Math.max(2, item.percent)}%` }}
          />
        </div>
      )}
```

In the meta row (after the `error` span, line 199-203), add a retry button for `upload_failed`:

```tsx
        {item.phase === "upload_failed" && (
          <button
            onClick={onRetry}
            className="ml-auto px-2 py-0.5 rounded bg-blue-700 hover:bg-blue-600 text-white text-[10px]"
          >
            重试上传
          </button>
        )}
```

- [ ] **Step 3: `phaseText` + `PhaseIcon` for the new phases**

In `phaseText`, the `download` switch (lines 222-236), add cases (before `case "done"`):

```ts
      case "uploading":
        return item.percent >= 100 ? "正在上传到云端…" : `上传到云端 · 转码 ${Math.round(item.percent)}%`;
      case "upload_failed":
        return "视频上传失败";
```

(`phaseText` returns `string`; these cases keep it exhaustive for the new `QueuePhase` values on the download branch.)

In `PhaseIcon` (lines 209-219), add before the trailing spinner return:

```tsx
  if (phase === "upload_failed") {
    return <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />;
  }
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS (no type errors; the new `QueuePhase` members are handled in `phaseText`/`PhaseIcon`/`isTerminalPhase`).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/DownloadQueueWidget.tsx
git commit -m "feat(queue-widget): render uploading progress + upload_failed with 重试上传"
```

## Task B4: Queue worker drives the uploading row + branches on result

**Files:**
- Modify: `client/src/store/importQueue.ts` (step 5, lines 152-165)
- Test: `client/src/store/importQueue.uploadbranch.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `client/src/store/importQueue.uploadbranch.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDownloadQueue } from "./downloadQueue";
import { applyUploadResult } from "./importQueue";

describe("applyUploadResult", () => {
  beforeEach(() => useDownloadQueue.setState({ entries: {} }));

  it("removes the row when videoUploaded is true", () => {
    useDownloadQueue.getState().upsert("v1", {
      videoId: "v1", sourceKind: "url", sourceValue: "u", label: "L",
      phase: "uploading", percent: 100, startedAt: 1,
    });
    applyUploadResult("v1", true);
    expect(useDownloadQueue.getState().entries["v1"]).toBeUndefined();
  });

  it("marks upload_failed when videoUploaded is false", () => {
    useDownloadQueue.getState().upsert("v1", {
      videoId: "v1", sourceKind: "url", sourceValue: "u", label: "L",
      phase: "uploading", percent: 100, startedAt: 1,
    });
    applyUploadResult("v1", false);
    expect(useDownloadQueue.getState().entries["v1"].phase).toBe("upload_failed");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test importQueue.uploadbranch`
Expected: FAIL — `applyUploadResult` not exported.

- [ ] **Step 3: Implement**

In `client/src/store/importQueue.ts`:

(a) Add the import at top (after the existing `useLibrary` import, line 29):

```ts
import { useDownloadQueue } from "./downloadQueue";
```

(b) Add the exported helper (e.g. just below `friendlyQueueError`):

```ts
/** Reflect the OSS-upload outcome into the queue widget. true → drop the row;
 *  false → keep it as upload_failed (retryable). Exported for tests. */
export function applyUploadResult(videoId: string, videoUploaded: boolean): void {
  if (videoUploaded) {
    useDownloadQueue.getState().remove(videoId);
  } else {
    useDownloadQueue.getState().update(videoId, { phase: "upload_failed", error: "video_upload_failed" });
  }
}
```

(c) Replace step 5 (lines 152-161, the `console.info("syncing…")` + `await syncToCloud(videoId)` + the reload) with:

```ts
    // ---- Step 5: sync to cloud (with visible upload progress) ----
    console.info(`[importQueue] syncing ${videoId} to cloud`);
    // Show an "uploading" row in the queue widget; Uploading events update its
    // transcode %, then the result branches it to done(removed)/upload_failed.
    useDownloadQueue.getState().upsert(videoId, {
      videoId,
      sourceKind: "url",
      sourceValue: item.url,
      label: item.url,
      phase: "uploading",
      percent: 0,
      startedAt: Date.now(),
    });
    const syncRes = await syncToCloud(videoId);
    applyUploadResult(videoId, syncRes.videoUploaded);

    // Refresh the library store so the card's ☁️ / sync_error reflects reality.
    await useLibrary.getState().reload();
```

(The `setStatus(item.id, "done")` at step 6 stays — the cloud entry exists either way; upload failure is surfaced via the widget + the card's `syncError`, not by failing the queue item.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm test importQueue.uploadbranch && pnpm typecheck`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/store/importQueue.ts client/src/store/importQueue.uploadbranch.test.ts
git commit -m "feat(import-queue): show uploading row + branch on videoUploaded (upload_failed retryable)"
```

## Task B5: Manual SyncButton — surface upload failure

**Files:**
- Modify: `client/src/components/LibraryCard/SyncButton.tsx` (`doSync`, lines 32-49)

- [ ] **Step 1: Branch `doSync` on `videoUploaded`**

Replace `doSync` (lines 32-49) with:

```tsx
  async function doSync() {
    setBusy(true);
    setError(null);
    try {
      const res = await syncToCloud(entry.id);
      if (!res.videoUploaded) {
        // Entry synced (captions) but the OSS video upload failed — show the
        // retryable failed state (also persisted via entry.syncError on reload).
        setError(friendlySyncError("video_upload_failed"));
      }
      await onChanged();
    } catch (err) {
      const raw = String(err);
      setError(friendlySyncError(raw));
      if (raw.includes("quota_exceeded")) {
        if (window.confirm("云端视频已达上限。前往官网购买授权解锁 50 个？")) {
          void openUrl("https://whatsub.eversay.cc/#pricing").catch(() => {});
        }
      }
    } finally {
      setBusy(false);
    }
  }
```

(The card already renders `state==="failed"` from `error`/`entry.syncError` with click-to-retry → `doSync` re-runs `library_sync_to_cloud` which re-runs `upload_video`. No other change needed. `friendlySyncError("video_upload_failed")` was added in Task B1.)

- [ ] **Step 2: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/LibraryCard/SyncButton.tsx
git commit -m "feat(sync-button): surface video_upload_failed as retryable on the library card"
```

---

# PART C — Full verify + manual

- [ ] **C1 — Full build/test gate.**
  - `cd src-tauri && cargo build && cargo clippy --all-targets -- -D warnings && cargo test` → green.
  - `cd client && pnpm typecheck && pnpm test && pnpm build` → green.

- [ ] **C2 — Manual (run the desktop app: `pnpm tauri dev` from `client`).**
  - Phone-push (or desktop import) a YouTube URL → after AI 解析, the background-jobs widget shows a row **「上传到云端 · 转码 X%」** climbing, then **「正在上传到云端…」** spinner, then the row disappears on success; iOS Library plays 免VPN.
  - Force a failure (e.g. temporarily break OSS / disconnect) → row shows **「视频上传失败」 + 重试上传**, does NOT silently vanish; the entry still exists (☁️) and the Library card shows the rose CloudOff failed state; clicking 重试上传 (widget) or the card re-runs the upload.
  - Manual ☁️ on a desktop card → button spins through the upload; on upload failure the card flips to the failed/retry state.

- [ ] **C3 — Integrate.** `superpowers:finishing-a-development-branch` (merge `feat/desktop-upload-progress` → Get_Video `main`; desktop has no TestFlight/cert concern — a normal merge). Update the `project_video_oss` + `reference_deploy_oss_env` memories' "still TODO" note (upload progress now done).

---

## Self-Review

**Spec coverage:** §A1 Uploading event → Task A1. §A2 transcode % (reuse export pattern) → A2. §A3 videoUploaded + sync_error (keep entry) + PUT marker → A3. §B1 syncToCloud return → B1. §B2/B3 widget uploading/upload_failed → B2+B3. §B4 queue step5 branch → B4. §B5 manual path + card → B5. Quota stays hard-Err (untouched in A3). Retry = re-invoke syncToCloud (B3 widget `retryUpload` + B5 card). ✓

**Placeholder scan:** none — every step has full code or exact commands.

**Type/name consistency:** `PipelineEvent::Uploading{video_id,percent:u8}` (A1) ↔ TS `Uploading{stage,video_id,percent:number}` (B2). `transcode_720p(app,src,out,id,duration_sec,cancel)` (A2) ↔ called with `entry.duration_sec as f64` (A3). `upload_video(…,duration_sec)` (A3 Step 2) ↔ call site (A3 Step 3). `SyncOk.video_uploaded`→serde `videoUploaded` (A3) ↔ TS `SyncOk.videoUploaded` (B1) ↔ used in B3/B4/B5. `QueuePhase` adds `"uploading"|"upload_failed"` (B2) ↔ rendered in B3 (`phaseText`/`PhaseIcon`/`isTerminalPhase`) ↔ set in B4 `applyUploadResult` + B3 `retryUpload`. `applyPipelineEvent` (B2) + `applyUploadResult` (B4) exported for tests. `friendlySyncError("video_upload_failed")` defined B1, used B5. ✓
