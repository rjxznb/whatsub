/**
 * Import-queue auto-poll orchestrator.
 *
 * Every ~30 s (while the app is running and the user is logged in) this
 * module:
 *  1. Calls GET /api/library/import-queue?status=pending → oldest item
 *  2. Marks it "processing"
 *  3. Runs the existing desktop pipeline:
 *       import_video  (yt-dlp download + Whisper transcription)
 *     → atomically open transcript analysis session
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
import { listPending, setStatus, claimItem, type ImportQueueItem } from "../lib/api/importQueue";
import { runInBackground, useBgAnalyses } from "./backgroundAnalyses";
import { openStoredAnalysisSession } from "../llm/analysisSession";
import { useSettings } from "./settings";
import { extractYouTubeId } from "../lib/syncSourceUrl";
import {
  completeReplacement,
  stageReplacement,
  syncToCloud,
  type ReplacementPayload,
} from "../lib/api/librarySync";
import { useLibrary } from "./library";
import { useDownloadQueue } from "./downloadQueue";

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
  const claim = await claimItem(item.id);
  if (!claim.claimed) {
    console.info(`[importQueue] item ${item.id} already claimed elsewhere, skipping`);
    return;
  }

  await processClaimedItem(item, claim.attemptToken, liveProcessorDependencies);
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

interface ImportedVideo {
  videoId: string;
}

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export interface QueueProcessorDependencies {
  getWhisperModel(): string | undefined;
  importVideo(item: ImportQueueItem, whisperModel: string): Promise<ImportedVideo>;
  analyze(videoId: string, label: string): Promise<void>;
  syncImport(videoId: string, sourceUrl: string): Promise<void>;
  stageReplacement(queueId: string, targetId: string, attemptToken: string, localVideoId: string): Promise<ReplacementPayload>;
  completeReplacement(queueId: string, targetId: string, attemptToken: string, payload: ReplacementPayload): Promise<void>;
  setStatus(id: string, status: "done" | "failed", error?: string, attemptToken?: string | null): Promise<void>;
}

export async function processClaimedItem(
  item: ImportQueueItem,
  attemptToken: string | null,
  deps: QueueProcessorDependencies,
): Promise<void> {
  try {
    const isReplacement = (item.mode ?? "import") === "replace";
    const replacementTarget = isReplacement
      ? item.targetLibraryEntryId?.trim()
      : undefined;
    const replacementYoutubeId = replacementTarget
      ? extractYouTubeId(item.url)
      : null;
    if (isReplacement && !replacementTarget) {
      throw new Error("replacement_target_missing");
    }
    if (isReplacement && !attemptToken?.trim()) {
      throw new Error("replacement_attempt_missing");
    }
    if (
      replacementTarget
      && (!replacementYoutubeId || !YOUTUBE_VIDEO_ID.test(replacementYoutubeId))
    ) {
      throw new Error("replacement_youtube_invalid");
    }

    const whisperModel = deps.getWhisperModel();
    if (!whisperModel) throw new Error("whisper_model_not_configured");
    const { videoId } = await deps.importVideo(item, whisperModel);
    if (replacementTarget && videoId !== replacementYoutubeId) {
      throw new Error("replacement_youtube_mismatch");
    }
    await deps.analyze(videoId, item.url);
    if (replacementTarget) {
      const payload = await deps.stageReplacement(item.id, replacementTarget, attemptToken!, videoId);
      if (
        !payload.videoKey
        || payload.youtubeId !== replacementYoutubeId
        || extractYouTubeId(payload.sourceUrl) !== replacementYoutubeId
      ) {
        throw new Error("replacement_staging_invalid");
      }
      await deps.completeReplacement(item.id, replacementTarget, attemptToken!, payload);
    } else {
      await deps.syncImport(videoId, item.url);
      await deps.setStatus(item.id, "done");
    }
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    const msg = friendlyQueueError(raw);
    try {
      await deps.setStatus(
        item.id,
        "failed",
        msg,
        (item.mode ?? "import") === "replace" ? attemptToken : undefined,
      );
    } catch (statusError) {
      console.warn("[importQueue] could not mark item failed:", statusError);
    }
  }
}

const liveProcessorDependencies: QueueProcessorDependencies = {
  getWhisperModel: () => useSettings.getState().settings.whisperModel,
  importVideo: async (item, whisperModel) => invoke<ImportedVideo>("import_video", {
    req: {
      sourceKind: "url",
      sourceValue: item.url,
      whisperModel,
      quality: "standard",
      analysisStyle: "neutral",
      background: true,
    },
  }),
  analyze: async (videoId, label) => {
    const stored = await openStoredAnalysisSession(videoId);
    if (!stored) throw new Error("transcript_not_found_after_import");
    const { cues, session } = stored;
    runInBackground({ videoId, label, cues, session, style: "neutral" });
    await waitForAnalysisDone(videoId);
  },
  syncImport: async (videoId, sourceUrl) => {
    useDownloadQueue.getState().upsert(videoId, {
      videoId,
      sourceKind: "url",
      sourceValue: sourceUrl,
      label: sourceUrl,
      phase: "uploading",
      percent: 0,
      startedAt: Date.now(),
    });
    const result = await syncToCloud(videoId);
    applyUploadResult(videoId, result.videoUploaded);
    await useLibrary.getState().reload();
  },
  stageReplacement,
  completeReplacement,
  setStatus,
};
