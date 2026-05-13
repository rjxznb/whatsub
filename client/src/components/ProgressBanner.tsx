import { useAnalysis } from "../store/analysis";

const PHASE_LABELS: Record<string, string> = {
  downloading: "下载视频",
  extracting: "抽取音频",
  transcribing: "本地转录",
  analyzing: "AI 解析字幕",
  paused: "已暂停",
  complete: "完成",
  error: "失败",
};

interface Props {
  onStop?: () => void;
  onContinue?: () => void;
  /** Re-run audio extraction + whisper for this video. Surfaces as a retry
   *  button on the error banner so a user whose download succeeded but
   *  whisper failed can recover without re-importing the URL. */
  onRetranscribe?: () => void;
  /** Hand the running analysis off to the background scheduler so the
   *  user can navigate away without losing progress. Shown alongside
   *  「停止解析」 during the analyzing phase. */
  onMoveToBackground?: () => void;
}

export function ProgressBanner({
  onStop,
  onContinue,
  onRetranscribe,
  onMoveToBackground,
}: Props) {
  const { phase, progressPercent, errorMessage, subtitles } = useAnalysis();
  if (phase === "idle" || phase === "complete") return null;

  const isError = phase === "error";
  const isAnalyzing = phase === "analyzing";
  const isPaused = phase === "paused";

  const tone = isError
    ? "bg-red-900/40 text-red-200"
    : isPaused
    ? "bg-amber-900/40 text-amber-100"
    : "bg-blue-900/40 text-blue-100";

  return (
    <div className={"px-4 py-2 text-sm flex items-center gap-3 " + tone}>
      {!isError && !isPaused && (
        <div className="w-3 h-3 border-2 border-blue-300 border-t-transparent rounded-full animate-spin" />
      )}
      <div className="flex-1 font-medium">
        {PHASE_LABELS[phase] ?? phase}
        {(isAnalyzing || isPaused) && ` · 已生成 ${subtitles.length} 行字幕`}
        {errorMessage && ` — ${errorMessage}`}
      </div>

      {isAnalyzing && onMoveToBackground && (
        <button
          onClick={onMoveToBackground}
          className="px-3 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100 text-xs transition-colors"
          title="放到后台继续解析，你可以离开当前页面。完成后会自动保存"
        >
          在后台解析
        </button>
      )}
      {isAnalyzing && onStop && (
        <button
          onClick={onStop}
          className="px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white text-xs transition-colors"
        >
          停止解析
        </button>
      )}
      {isPaused && onContinue && (
        <button
          onClick={onContinue}
          className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white text-xs transition-colors"
        >
          继续解析
        </button>
      )}
      {isError && onRetranscribe && (
        <button
          onClick={onRetranscribe}
          className="px-3 py-1 rounded bg-red-700 hover:bg-red-600 text-white text-xs transition-colors"
        >
          重新解析
        </button>
      )}

      {!isError && !isAnalyzing && !isPaused && (
        <div className="w-32 h-1.5 bg-zinc-700 rounded overflow-hidden">
          <div
            className="h-full bg-blue-400 transition-all"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      )}
    </div>
  );
}
