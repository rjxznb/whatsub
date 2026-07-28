import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, CheckCircle2, AlertCircle } from "lucide-react";
import { useDownloadQueue, type QueueItem, type QueuePhase } from "../store/downloadQueue";
import {
  useBgAnalyses,
  cancelBackground,
  resumeBackgroundAnalysis,
  type BgAnalysisJob,
} from "../store/backgroundAnalyses";
import { syncToCloud } from "../lib/api/librarySync";
import { friendlyError } from "../utils/friendlyError";
import { SiteLoginModal } from "./SiteLoginModal";
import { useSettings } from "../store/settings";

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

export function FailedActions({
  error,
  sourceValue,
  onRetry,
}: {
  error: string;
  sourceValue: string;
  onRetry: () => void;
}) {
  const [loginOpen, setLoginOpen] = useState(false);
  const fe = friendlyError(error, "downloading", sourceValue);
  const requiredLoginAction = fe.loginRequired ? fe.action : undefined;
  return (
    <span className="ml-auto flex items-center gap-2">
      <span className="text-amber-400 truncate max-w-[160px]" title={error}>
        {fe.title}
      </span>
      {requiredLoginAction && (
        <button
          className="px-2 py-0.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-[10px]"
          onClick={() => setLoginOpen(true)}
        >
          立即登录{requiredLoginAction.siteLabel}
        </button>
      )}
      {!fe.loginRequired && (
        <button
          className="px-2 py-0.5 rounded bg-blue-700 hover:bg-blue-600 text-white text-[10px]"
          onClick={onRetry}
        >
          重试
        </button>
      )}
      {loginOpen && requiredLoginAction && (
        <SiteLoginModal
          open={loginOpen}
          action={requiredLoginAction}
          onClose={() => setLoginOpen(false)}
          onSuccess={onRetry}
        />
      )}
    </span>
  );
}

/**
 * Floating bottom-right widget for the unified background-jobs queue.
 * Hidden when there's nothing to show. Clicking the badge expands a
 * panel listing every in-flight item (downloads + background analyses)
 * with per-item progress + ✕ cancel.
 *
 * Mounted at App root so it stays above all routes — user can navigate
 * freely while jobs run.
 */
type UnifiedItem =
  | {
      kind: "download";
      videoId: string;
      label: string;
      phase: QueuePhase;
      percent: number;
      sourceKind: string;
      sourceValue: string;
      speed?: string | null;
      eta?: string | null;
      error?: string | null;
      /** Optional Rust-side phase note (e.g. "正在上传视频 · 8 MB",
       *  "正在提取音频", "正在上传音频 · 0.3 MB"). When set, overrides the
       *  default percent-based phase text — see phaseText(). */
      note?: string | null;
      startedAt: number;
    }
  | {
      kind: "analysis";
      videoId: string;
      label: string;
      phase: BgAnalysisJob["phase"];
      percent: number;
      subtitleCount: number;
      committedCueOffset: number;
      totalCues: number;
      retryMessage?: string | null;
      error?: string | null;
      startedAt: number;
    };

export function DownloadQueueWidget() {
  const downloads = useDownloadQueue((s) => s.entries);
  const cancelDownload = useDownloadQueue((s) => s.cancel);
  const removeDownload = useDownloadQueue((s) => s.remove);
  const analyses = useBgAnalyses((s) => s.jobs);
  const [expanded, setExpanded] = useState(false);

  const items: UnifiedItem[] = [
    ...Object.values(downloads).map<UnifiedItem>((d: QueueItem) => ({
      kind: "download",
      videoId: d.videoId,
      label: d.label,
      phase: d.phase,
      percent: d.percent,
      sourceKind: d.sourceKind,
      sourceValue: d.sourceValue,
      speed: d.speed,
      eta: d.eta,
      error: d.error,
      note: d.note,
      startedAt: d.startedAt,
    })),
    ...Object.values(analyses).map<UnifiedItem>((a) => ({
      kind: "analysis",
      videoId: a.videoId,
      label: a.label,
      phase: a.phase,
      percent: a.totalCues > 0
        ? Math.min(100, (a.committedCueOffset / a.totalCues) * 100)
        : 0,
      subtitleCount: a.subtitleCount,
      committedCueOffset: a.committedCueOffset,
      totalCues: a.totalCues,
      retryMessage: a.retryMessage,
      error: a.errorMessage,
      startedAt: a.startedAt,
    })),
  ].sort((a, b) => b.startedAt - a.startedAt);

  if (items.length === 0) return null;

  // Badge color: amber if anything errored, blue while actively
  // working, green only when everything finished (and is still
  // lingering pre-auto-remove).
  const activeCount = items.filter((i) => !isTerminalPhase(i)).length;
  const errorCount = items.filter((i) => i.phase === "error").length;
  const badgeColor =
    errorCount > 0
      ? "bg-amber-500"
      : activeCount > 0
      ? "bg-blue-500"
      : "bg-green-500";

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {expanded && (
        <div className="w-80 max-w-[calc(100vw-2rem)] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
            <span className="text-sm font-semibold text-zinc-100">
              后台任务（{items.length}）
            </span>
            <button
              onClick={() => setExpanded(false)}
              className="text-zinc-500 hover:text-zinc-200 text-lg leading-none"
              title="收起"
            >
              ×
            </button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto divide-y divide-zinc-800">
            {items.map((item) => (
              <Row
                key={`${item.kind}:${item.videoId}`}
                item={item}
                onCancel={() => {
                  if (item.kind === "download") void cancelDownload(item.videoId);
                  else cancelBackground(item.videoId);
                }}
                onDismiss={() => {
                  if (item.kind === "download") removeDownload(item.videoId);
                  else cancelBackground(item.videoId);
                }}
                onRetry={() => {
                  if (item.kind === "download") void retryUpload(item.videoId);
                  else resumeBackgroundAnalysis(item.videoId);
                }}
              />
            ))}
          </div>
        </div>
      )}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="relative h-12 w-12 rounded-full bg-zinc-900 border border-zinc-700 hover:border-zinc-500 shadow-lg flex items-center justify-center text-zinc-200 transition-colors"
        title={`后台任务（${items.length}）`}
      >
        <Download className="h-5 w-5" />
        <span
          className={
            "absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full text-[10px] font-semibold text-white flex items-center justify-center " +
            badgeColor
          }
        >
          {items.length}
        </span>
      </button>
    </div>
  );
}

function isTerminalPhase(item: UnifiedItem): boolean {
  return item.phase === "done" || item.phase === "error" || item.phase === "upload_failed";
}

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
  const isTerminal = isTerminalPhase(item);
  const phaseTextValue = phaseText(item);
  // No measurable progress for the OSS upload PUT (percent is pinned at 100
  // once transcode finishes) or a background re-transcribe — show a sliding
  // indeterminate bar instead of a stuck/empty one.
  const indeterminate =
    (item.phase === "uploading" && item.percent >= 100) ||
    (item.kind === "analysis" && item.phase === "transcribing");
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <PhaseIcon phase={item.phase} />
        <span
          className="flex-1 text-xs text-zinc-200 truncate"
          title={item.label}
        >
          {item.kind === "analysis" ? "🤖 " : ""}
          {item.label}
        </span>
        <button
          onClick={isTerminal ? onDismiss : onCancel}
          className="text-zinc-500 hover:text-zinc-200 text-base leading-none px-1 -mr-1"
          title={isTerminal ? "移除" : "取消"}
        >
          ×
        </button>
      </div>
      {!isTerminal && (
        <div className="h-1 bg-zinc-800 rounded-full overflow-hidden relative">
          {indeterminate ? (
            <div className="animate-indeterminate-bar bg-blue-500 rounded-full" />
          ) : (
            <div
              className="h-full transition-all duration-300 bg-blue-500"
              style={{ width: `${Math.max(2, item.percent)}%` }}
            />
          )}
        </div>
      )}
      <div className="flex items-center gap-2 mt-1.5 text-[10px] text-zinc-500">
        <span>{phaseTextValue}</span>
        {item.kind === "download" && item.phase === "downloading" && item.speed && (
          <span className="tabular-nums">{item.speed}</span>
        )}
        {item.kind === "download" && item.phase === "downloading" && item.eta && (
          <span className="tabular-nums">ETA {item.eta}</span>
        )}
        {item.kind === "analysis" && item.phase === "analyzing" && (
          <span className="tabular-nums">
            已处理 {item.committedCueOffset}/{item.totalCues} 条
          </span>
        )}
        {item.kind === "analysis" && item.phase === "analyzing" && item.retryMessage && (
          <span className="text-amber-300 truncate" title={item.retryMessage}>
            {item.retryMessage}
          </span>
        )}
        {item.phase === "error" && item.error && item.kind === "download" && (
          <FailedActions
            error={item.error}
            sourceValue={item.sourceValue}
            onRetry={() =>
              void invoke("import_video", {
                req: {
                  sourceKind: item.sourceKind,
                  sourceValue: item.sourceValue,
                  whisperModel: useSettings.getState().settings.whisperModel,
                  quality: "standard",
                  background: true,
                },
              })
            }
          />
        )}
        {item.phase === "error" && item.error && item.kind !== "download" && (
          <>
            <span className="text-amber-400 truncate" title={item.error}>
              {shortError(item.error)}
            </span>
            <button
              onClick={onRetry}
              className="ml-auto px-2 py-0.5 rounded bg-blue-700 hover:bg-blue-600 text-white text-[10px]"
            >
              继续解析
            </button>
          </>
        )}
        {item.phase === "upload_failed" && (
          <button
            onClick={onRetry}
            className="ml-auto px-2 py-0.5 rounded bg-blue-700 hover:bg-blue-600 text-white text-[10px]"
          >
            重试上传
          </button>
        )}
      </div>
    </div>
  );
}

function PhaseIcon({ phase }: { phase: UnifiedItem["phase"] }) {
  if (phase === "done") {
    return <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />;
  }
  if (phase === "error") {
    return <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />;
  }
  if (phase === "upload_failed") {
    return <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />;
  }
  return (
    <div className="h-3 w-3 rounded-full border-2 border-blue-500 border-t-transparent animate-spin shrink-0" />
  );
}

function phaseText(item: UnifiedItem): string {
  if (item.kind === "download") {
    switch (item.phase) {
      case "started":
        return "准备中";
      case "downloading":
        return "下载中";
      case "extracting":
        return "提取音频";
      case "transcribing":
        return "转录字幕";
      case "uploading":
        // Prefer Rust-emitted note if present (sub-step text like "正在上传视频 · 8 MB",
        // "正在提取音频", "正在上传音频 · 0.3 MB") — those break the otherwise
        // indistinguishable post-transcode silent phase into visible steps.
        if (item.note) return item.note;
        return item.percent >= 100 ? "正在上传到云端…" : `上传到云端 · 转码 ${Math.round(item.percent)}%`;
      case "upload_failed":
        return "视频上传失败";
      case "done":
        return "完成";
      case "error":
        return "失败";
    }
  }
  switch (item.phase) {
    case "transcribing":
      return "重新转写中";
    case "analyzing":
      return "AI 解析";
    case "done":
      return "完成";
    case "error":
      return "失败";
  }
}

/** One-line summary of a long subprocess stderr so the queue row stays
 *  compact. Full text still surfaces via the title attribute. */
function shortError(raw: string): string {
  const first = raw.split("\n").find((line) => line.trim().length > 0) ?? raw;
  return first.length > 40 ? first.slice(0, 40) + "…" : first;
}
