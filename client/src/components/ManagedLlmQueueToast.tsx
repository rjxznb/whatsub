import { LoaderCircle } from "lucide-react";
import { useManagedQueueStatus } from "../llm/managedQueueStatus";

/** One app-wide, non-blocking notice for managed LLM admission waits. */
export function ManagedLlmQueueToast() {
  const waitingCount = useManagedQueueStatus((state) => state.waitingCount);
  if (waitingCount <= 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-[65] w-80 -translate-x-1/2 rounded-lg border border-sky-500/30 bg-zinc-900 p-4 shadow-2xl"
    >
      <div className="flex items-start gap-3">
        <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-sky-400" />
        <div>
          <div className="text-sm font-semibold text-zinc-100">
            AI 服务繁忙，正在排队…
          </div>
          <div className="mt-1 text-xs leading-relaxed text-zinc-400">
            可继续等待，或在当前任务中点击停止
          </div>
        </div>
      </div>
    </div>
  );
}
