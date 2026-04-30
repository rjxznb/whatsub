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
}

export function ProgressBanner({ onStop, onContinue }: Props) {
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
