import { useState } from "react";
import { Download, CheckCircle2, AlertCircle } from "lucide-react";
import { useDownloadQueue, type QueueItem, type QueuePhase } from "../store/downloadQueue";

/**
 * Floating bottom-right widget for the background download queue.
 * Hidden when the queue is empty. Clicking the badge expands a panel
 * showing every active item with per-item progress + ✕ cancel.
 *
 * Mounted at App root so it sits above all routes — user can navigate
 * freely while imports run.
 */
export function DownloadQueueWidget() {
  const entries = useDownloadQueue((s) => s.entries);
  const cancel = useDownloadQueue((s) => s.cancel);
  const remove = useDownloadQueue((s) => s.remove);
  const [expanded, setExpanded] = useState(false);

  const items = Object.values(entries).sort((a, b) => b.startedAt - a.startedAt);
  if (items.length === 0) return null;

  // Active count = anything not done / not errored (i.e. actively
  // working). Determines the badge color: blue while active, green
  // when everything finished, amber when something errored.
  const activeCount = items.filter(
    (i) => i.phase !== "done" && i.phase !== "error"
  ).length;
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
              后台下载（{items.length}）
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
              <QueueRow
                key={item.videoId}
                item={item}
                onCancel={() => void cancel(item.videoId)}
                onDismiss={() => remove(item.videoId)}
              />
            ))}
          </div>
        </div>
      )}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="relative h-12 w-12 rounded-full bg-zinc-900 border border-zinc-700 hover:border-zinc-500 shadow-lg flex items-center justify-center text-zinc-200 transition-colors"
        title={`后台下载（${items.length}）`}
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

function QueueRow({
  item,
  onCancel,
  onDismiss,
}: {
  item: QueueItem;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const isTerminal = item.phase === "done" || item.phase === "error";
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <PhaseIcon phase={item.phase} />
        <span
          className="flex-1 text-xs text-zinc-200 truncate"
          title={item.sourceValue}
        >
          {item.label}
        </span>
        <button
          onClick={isTerminal ? onDismiss : onCancel}
          className="text-zinc-500 hover:text-zinc-200 text-base leading-none px-1 -mr-1"
          title={isTerminal ? "移除" : "取消下载"}
        >
          ×
        </button>
      </div>
      {/* Progress bar: shown for active phases. Hidden once done/error
          (the phase icon + label already convey the terminal state). */}
      {!isTerminal && (
        <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={
              "h-full transition-all duration-300 " +
              (item.phase === "started" ? "bg-zinc-600" : "bg-blue-500")
            }
            style={{ width: `${item.phase === "started" ? 5 : item.percent}%` }}
          />
        </div>
      )}
      <div className="flex items-center gap-2 mt-1.5 text-[10px] text-zinc-500">
        <span>{phaseLabel(item.phase)}</span>
        {item.phase === "downloading" && item.speed && (
          <span className="tabular-nums">{item.speed}</span>
        )}
        {item.phase === "downloading" && item.eta && (
          <span className="tabular-nums">ETA {item.eta}</span>
        )}
        {item.phase === "error" && item.error && (
          <span className="text-amber-400 truncate" title={item.error}>
            {shortError(item.error)}
          </span>
        )}
      </div>
    </div>
  );
}

function PhaseIcon({ phase }: { phase: QueuePhase }) {
  if (phase === "done") {
    return <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />;
  }
  if (phase === "error") {
    return <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />;
  }
  return (
    <div className="h-3 w-3 rounded-full border-2 border-blue-500 border-t-transparent animate-spin shrink-0" />
  );
}

function phaseLabel(p: QueuePhase): string {
  switch (p) {
    case "started":
      return "准备中";
    case "downloading":
      return "下载中";
    case "extracting":
      return "提取音频";
    case "transcribing":
      return "转录字幕";
    case "done":
      return "完成";
    case "error":
      return "失败";
  }
}

/** Trim a multi-line subprocess stderr to a single useful line so the
 *  queue row stays compact. Full text remains on the title attribute. */
function shortError(raw: string): string {
  const first = raw.split("\n").find((line) => line.trim().length > 0) ?? raw;
  return first.length > 40 ? first.slice(0, 40) + "…" : first;
}
