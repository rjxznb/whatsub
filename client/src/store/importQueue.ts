/**
 * Import-queue auto-poll orchestrator.
 *
 * Every ~30 s (while the app is running and the user is logged in) this
 * module:
 *  1. Calls GET /api/library/import-queue?status=pending → oldest item
 *  2. Marks it "processing"
 *  3. Runs the existing desktop pipeline:
 *       import_video  (yt-dlp download + Whisper transcription)
 *     → load_transcript + parseSrt  (get SrtCue[])
 *     → runInBackground             (LLM analysis → writes analysis.json + sets library status=ready)
 *     → await "done" phase (poll useBgAnalyses)
 *     → library_sync_to_cloud       (push to backend)
 *  4. Marks item "done" (or "failed" on any error)
 *
 * Concurrency = 1 (isProcessing guard). Skips silently when not authenticated
 * or offline (all errors caught + logged at warn).
 *
 * Start with startImportQueuePolling() — called once from App.tsx when the
 * user is logged in. Idempotent (second call is ignored if already running).
 */

import { invoke } from "@tauri-apps/api/core";
import { listPending, setStatus, claimItem } from "../lib/api/importQueue";
import { runInBackground, useBgAnalyses } from "./backgroundAnalyses";
import { parseSrt } from "../llm/parseSrt";
import { useSettings } from "./settings";
import { syncToCloud } from "../lib/api/librarySync";
import { useLibrary } from "./library";
import { useDownloadQueue } from "./downloadQueue";
import type { SrtCue } from "../llm/types";

const POLL_INTERVAL_MS = 30_000;
/** Maximum time to wait for LLM analysis to reach "done". 10 minutes. */
const ANALYSIS_TIMEOUT_MS = 10 * 60 * 1_000;
/** How often to check the bg-analysis phase while waiting. */
const PHASE_CHECK_INTERVAL_MS = 2_000;

let isProcessing = false;
let pollingStarted = false;

/** Map a raw pipeline error to actionable Chinese copy for login-walled sites. */
function friendlyQueueError(raw: string): string {
  if (raw.includes("quota_exceeded")) {
    const m = raw.match(/"used":\s*(\d+).*?"limit":\s*(\d+)/);
    const tail = m ? `（${m[1]}/${m[2]}）` : "";
    return `云端视频已达上限${tail}：删掉一些或购买授权解锁 50 个`;
  }
  const t = raw.toLowerCase();
  if (
    raw.includes("登录") || raw.includes("会员") ||
    t.includes("login") || t.includes("cookies") || t.includes("account")
  ) {
    return `需要登录该网站后重试（桌面端 设置 → 登录对应站点 Cookie）。原始错误：${raw}`;
  }
  return raw;
}

/** Reflect the OSS-upload outcome into the queue widget. true → drop the row;
 *  false → keep it as upload_failed (retryable). Exported for tests. */
export function applyUploadResult(videoId: string, videoUploaded: boolean): void {
  if (videoUploaded) {
    useDownloadQueue.getState().remove(videoId);
  } else {
    useDownloadQueue.getState().update(videoId, { phase: "upload_failed", error: "video_upload_failed" });
  }
}

/**
 * Start the background poll loop. Call once from App.tsx when the user is
 * authenticated. Safe to call multiple times — subsequent calls are no-ops.
 */
export function startImportQueuePolling(): void {
  if (pollingStarted) return;
  pollingStarted = true;
  // Run immediately on first mount, then on the interval.
  void processTick();
  setInterval(() => {
    void processTick();
  }, POLL_INTERVAL_MS);
}

async function processTick(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  try {
    await processNextPendingItem();
  } catch (err) {
    // Broad catch: network offline, not authenticated, etc. Suppress — the
    // next tick will retry.
    console.warn("[importQueue] tick error (will retry next interval):", err);
  } finally {
    isProcessing = false;
  }
}

async function processNextPendingItem(): Promise<void> {
  // listPending throws "auth_required" if get_session_token returns null.
  // This propagates to processTick's catch, silencing the tick.
  const items = await listPending();
  if (items.length === 0) return;

  // Sort ascending by createdAt → take the oldest.
  const item = items.slice().sort((a, b) => a.createdAt - b.createdAt)[0];

  console.info(`[importQueue] processing item ${item.id} url=${item.url}`);

  // Atomically claim it; if another desktop already claimed it, skip this tick.
  const won = await claimItem(item.id);
  if (!won) {
    console.info(`[importQueue] item ${item.id} already claimed elsewhere, skipping`);
    return;
  }

  try {
    // ---- Step 1: import_video (yt-dlp + Whisper) ----
    const settings = useSettings.getState().settings;
    if (!settings.whisperModel) {
      throw new Error("whisper_model_not_configured");
    }

    const importResult = await invoke<{
      videoId: string;
      srtPath: string;
      durationSec: number;
    }>("import_video", {
      req: {
        sourceKind: "url",
        sourceValue: item.url,
        whisperModel: settings.whisperModel,
        quality: "standard",
        analysisStyle: "neutral",
        background: true,
      },
    });

    const videoId = importResult.videoId;
    console.info(`[importQueue] import_video done, videoId=${videoId}`);

    // ---- Step 2: load transcript cues ----
    const srtContent = await invoke<string | null>("load_transcript", { videoId });
    if (!srtContent) {
      throw new Error("transcript_not_found_after_import");
    }
    const cues: SrtCue[] = parseSrt(srtContent);
    console.info(`[importQueue] loaded ${cues.length} cues for ${videoId}`);

    // ---- Step 3: start LLM analysis in background ----
    // runInBackground is fire-and-forget; it writes analysis.json and flips
    // library status to "ready" on completion.
    runInBackground({
      videoId,
      label: item.url,
      cues,
      previouslyAnalyzed: [],
      previousSummary: null,
      style: "neutral",
    });

    // ---- Step 4: wait for analysis to reach "done" (or "error") ----
    await waitForAnalysisDone(videoId);

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

    // ---- Step 6: mark queue item done ----
    // Captions-only success counts as queue "done"; a failed video upload is
    // surfaced separately via the upload_failed row + the card's sync_error.
    await setStatus(item.id, "done");
    console.info(`[importQueue] item ${item.id} done`);
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    const msg = friendlyQueueError(raw);
    console.error(`[importQueue] item ${item.id} failed:`, msg);
    try {
      await setStatus(item.id, "failed", msg);
    } catch (e2) {
      console.warn("[importQueue] could not mark item failed:", e2);
    }
  }
}

/**
 * Poll `useBgAnalyses` until the job for `videoId` reaches "done" or "error",
 * or the job disappears (meaning it completed and the 4s linger expired).
 * Throws on "error" phase or timeout.
 */
function waitForAnalysisDone(videoId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();

    const check = () => {
      const job = useBgAnalyses.getState().jobs[videoId];

      if (!job) {
        // Job was removed: either it completed (lingered 4s then dropped) or
        // it was never registered (e.g. 0-cue transcript → runInBackground
        // exits immediately). Either way, treat as success.
        resolve();
        return;
      }

      if (job.phase === "done") {
        resolve();
        return;
      }

      if (job.phase === "error") {
        reject(new Error(`analysis_error: ${job.errorMessage ?? "unknown"}`));
        return;
      }

      // Still "analyzing" — check timeout.
      if (Date.now() - startedAt > ANALYSIS_TIMEOUT_MS) {
        reject(new Error("analysis_timeout"));
        return;
      }

      // Schedule next check.
      setTimeout(check, PHASE_CHECK_INTERVAL_MS);
    };

    // First check after a short initial delay so runInBackground has a chance
    // to register the job.
    setTimeout(check, PHASE_CHECK_INTERVAL_MS);
  });
}
