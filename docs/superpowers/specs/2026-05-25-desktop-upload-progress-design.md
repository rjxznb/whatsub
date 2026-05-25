# 桌面端 OSS 上传进度 + 失败可见 — Design

**Date:** 2026-05-25
**Status:** design — pending user review before plan
**Repo:** Get_Video (Tauri 桌面端：React client + Rust src-tauri)

## Problem / Goal

桌面端把视频同步到云时，AI 解析完成后会**静默**地转码 + 上传到 OSS，UI 上没有任何指示——队列项的进度卡在解析"done"后直接消失。更糟的是 `upload_video` 是 **best-effort**：转码/取签名 URL/PUT 任何一步失败都返回 `None`，`library_sync_to_cloud` 仍然 POST `/api/library/sync`（videoKey 为 null），队列项被标 `done`，桌面显示 ☁️ 已同步——但手机端拉到的是没有 OSS 视频的条目，只能走 YouTube 内嵌（需 VPN）。失败完全不可见（无日志、无 UI）。

**目标：** 让 OSS 上传这一步**可见**——运行时显示进度（转码真实 % + 上传转圈），失败时显示明确的「上传失败 · 重试上传」而不是静默标记完成。

## Key decisions（brainstorming 已确认）

1. **进度粒度：转码真实 % + 上传转圈。** 转码阶段复用现有 ffmpeg 进度机制（与字幕烧录 Export 的 `Exporting{percent}` 同源）显示真实 %；OSS PUT 阶段显示「正在上传…」转圈（不做字节级 %）。
2. **上传失败时：保留条目 + 显「上传失败 · 重试」。** 字幕/元数据照常同步（条目存在，手机暂时需 VPN），但在桌面队列卡片 + Library 卡片上明确标「视频上传失败 · 重试上传」，点击只重跑 `upload_video`（不重新下载/解析）。保留字幕价值 + 可见 + 可重试。
3. **配额超限仍是硬失败**（`Err("quota_exceeded …")`，现状不变）——与"上传失败"区分开。
4. **复用现有事件 + UI 基础设施**：`PipelineEvent`（`app.emit("pipeline-event", …)`）+ `DownloadQueueWidget`（已统一 download + analysis 两类阶段）。不新建并行系统。
5. **覆盖两条上传路径**：队列驱动（`importQueue.ts` step 5）+ 手动同步（`SyncButton` → `syncToCloud`）。两者都走同一个 Rust `library_sync_to_cloud` → `upload_video`，所以进度事件从 Rust 发出可同时覆盖。

## Architecture / components

### A. Rust（`src-tauri`）— 发事件 + 回报上传结果

**A1. `core/progress.rs` — 新增事件变体**
```rust
/// OSS 上传进度。percent = 转码 0–100；转码完成后前端把 PUT 显示为转圈。
Uploading { video_id: String, percent: u8 },
```
（沿用现有 tagged enum + `emit(app, PipelineEvent::Uploading{..})`。成功/失败不单独发事件——由命令返回值 + 现有 `Failed` 承载，见 A3。）

**A2. `pipeline/ffmpeg.rs` `transcode_720p` — 发转码 %**
现状只 `make_log_emitter`（发 `Log` 行），不发 percent。改为：解析 ffmpeg 进度（复用 Export 路径解析 `time=` / `-progress` 对 `duration_sec` 求 % 的同一机制），在转码过程中 `emit(PipelineEvent::Uploading{ video_id, percent })`。`transcode_720p` 需要拿到 `duration_sec`（调用方 `upload_video` 有 `entry.duration_sec`，按需透传一个参数）。

**A3. `commands/library_sync.rs`**
- `upload_video`：转码前/中发 `Uploading{percent}`；进入 PUT 前发 `Uploading{ percent: 100 }`（前端据此切到「正在上传…」转圈）。返回值不变（`Option<String>`）。
- `SyncOk` 结构新增字段 `#[serde(rename = "videoUploaded")] video_uploaded: bool`。
- `library_sync_to_cloud`：`let video_key = upload_video(...).await;` 之后，**照常 POST `/sync`**（保留条目）。POST 成功后：
  - 把 `synced_at` 写回 library entry（现状已做）；
  - 若 `video_key.is_none()`（且不是配额硬失败——配额在上传前已 `return Err`），把该 entry 的 `sync_error = Some("video_upload_failed")` 写回 library.json；成功则 `sync_error = None`。
  - 返回 `SyncOk{ …, video_uploaded: video_key.is_some() }`。
- **重试**：无需新命令。`library_sync_to_cloud(id)` 对已同步条目重跑（`synced_at.is_some()` → 跳过配额预检 → 重跑 `upload_video` → 重新 POST，覆盖同一 OSS key + 清 `sync_error`）。

### B. TS/React（`client/src`）— 监听 + 展示

**B1. `lib/api/librarySync.ts`** — `syncToCloud` 返回类型加 `videoUploaded: boolean`（透传 `SyncOk.videoUploaded`）。`friendlySyncError` 不变。

**B2. 上传进度 store / 监听**
现有 `pipeline-event` 监听集中在 `store/downloadQueue.ts`（+ `hooks/useTauriEvent.ts`）。在该监听里新增对 `Uploading{video_id, percent}` 的处理：把对应 video 的"上传"进度写入统一队列项（见 B3）。

**B3. `store/backgroundAnalyses.ts` + `components/DownloadQueueWidget.tsx`** — 新增 uploading / upload-failed 阶段
- 给统一队列项加阶段：`uploading`（带转码 % / 上传转圈）+ `upload_failed`（终态，带「重试上传」按钮）。最小侵入做法：在 `BgAnalysisJob.phase` 增加 `"uploading" | "upload_failed"`，并加 `uploadPercent?: number`、`uploadPutInFlight?: boolean`。
- `DownloadQueueWidget` 的 `phaseText` / `PhaseIcon` / 进度条渲染这两个新阶段：`uploading` → 「上传到云端 · 转码 X%」或转码完成后「正在上传…」转圈；`upload_failed` → 红色「视频上传失败」+「重试上传」按钮。

**B4. `store/importQueue.ts` step 5（队列驱动）**
- 调 `syncToCloud` 前：把该 video 的 bg job（解析完成后本会 linger→drop）转成 `phase:"uploading"`（不让它消失）。
- `Uploading` 事件经 B2 更新 `uploadPercent` / `uploadPutInFlight`。
- `syncToCloud` resolve 后：`videoUploaded===true` → job `phase:"done"`（linger 4s 后 drop，现状逻辑），队列项 `setStatus(done)`；`videoUploaded===false` → job `phase:"upload_failed"`（不自动 drop），队列项仍 `setStatus(done)`（条目已同步，保留），但 widget 显示「上传失败 · 重试上传」。
- 「重试上传」按钮 → 再次 `syncToCloud(videoId)` + 重置该 job 回 `uploading`。

**B5. 手动同步路径 `components/LibraryCard/SyncButton.tsx` + Library 卡片**
- 点击同步时同样进入 `uploading` 展示（监听同一 `Uploading` 事件）。
- 同步后 `videoUploaded===false` → 卡片持久显示「视频上传失败 · 重试上传」（数据源：library entry 的 `sync_error === "video_upload_failed"`）。点击重试 → `syncToCloud(id)`。

## Data flow（精确）

```
importQueue step5 / SyncButton
  → syncToCloud(id)  [TS invoke library_sync_to_cloud]
      Rust: transcode_720p → emit Uploading{percent} … (转码 %)
            emit Uploading{percent:100}  (进入 PUT → 前端转圈)
            PUT to OSS
            POST /sync (videoKey = Some|None)         ← 条目总是同步
            write sync_error = video_key? None : "video_upload_failed"
      ← SyncOk{ videoUploaded: video_key.is_some() }
  → videoUploaded ? job=done : job=upload_failed(+重试)
pipeline-event(Uploading) → downloadQueue listener → unified job.uploadPercent
```

## Testing

- **Rust**：`library_sync_to_cloud` 现有逻辑用真实 OSS，难单测；重点是手动验证 + 保持 `cargo build`/`cargo clippy` 干净。`SyncOk.videoUploaded` 字段加 serde rename 单测可选。
- **TS**：`syncToCloud` 返回 `videoUploaded` 的解析；`importQueue` step5 分支（done vs upload_failed）可对 `syncToCloud` 打桩单测。`DownloadQueueWidget` 的新阶段渲染快照可选。
- **手动验证（桌面真机）**：① 正常推送 → 看到「上传到云端 转码 X%」→「正在上传…」→「✓ 已上传」，手机免 VPN；② 断网/造一个上传失败 → 看到「视频上传失败 · 重试上传」、队列不静默消失、条目仍在（手机需 VPN）；③ 点「重试上传」→ 重跑成功 → 免 VPN；④ 手动 SyncButton 路径同样可见。

## Out of scope（YAGNI）

- OSS PUT 真实字节级 %（需把"读整文件 + 单次 body"改成流式 body + 进度回调，留待以后）。
- 手机端「导入队列」视图对 upload-failed 的呈现（本次聚焦桌面端，用户明确要求）。
- 重试时若 `mobile.mp4` 已存在则跳过转码的优化（可后续加）。
- 后端改动（无）——后端 `/upload-url`、`/sync`、配额都不动。

## Key file pointers

- Rust：`src-tauri/src/core/progress.rs`（PipelineEvent）、`src-tauri/src/pipeline/ffmpeg.rs`（transcode_720p）、`src-tauri/src/commands/library_sync.rs`（library_sync_to_cloud + upload_video + SyncOk + sync_error）
- TS：`client/src/store/downloadQueue.ts`（pipeline-event 监听）、`client/src/store/backgroundAnalyses.ts`（BgAnalysisJob 阶段）、`client/src/components/DownloadQueueWidget.tsx`（渲染）、`client/src/store/importQueue.ts`（step5）、`client/src/lib/api/librarySync.ts`（syncToCloud 返回）、`client/src/components/LibraryCard/SyncButton.tsx`（手动路径 + 卡片失败态）
- 相关：刚修复的 prod OSS env 缺失（`reference_deploy_oss_env` memory）——上传现在应能成功，本功能让未来失败可见可重试。
