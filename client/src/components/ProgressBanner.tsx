import { useAnalysis } from "../store/analysis";

const PHASE_LABELS: Record<string, string> = {
  downloading: "下载视频",
  extracting: "抽取音频",
  transcribing: "本地转录",
  analyzing: "AI 解析字幕",
  complete: "完成",
  error: "失败",
};

export function ProgressBanner() {
  const { phase, progressPercent, errorMessage, subtitles } = useAnalysis();
  if (phase === "idle" || phase === "complete") return null;

  const isError = phase === "error";
  const isAnalyzing = phase === "analyzing";

  return (
    <div
      className={
        "px-4 py-2 text-sm flex items-center gap-3 " +
        (isError ? "bg-red-900/40 text-red-200" : "bg-blue-900/40 text-blue-100")
      }
    >
      {!isError && (
        <div className="w-3 h-3 border-2 border-blue-300 border-t-transparent rounded-full animate-spin" />
      )}
      <div className="flex-1 font-medium">
        {PHASE_LABELS[phase] ?? phase}
        {isAnalyzing && ` · 已生成 ${subtitles.length} 行字幕`}
        {errorMessage && ` — ${errorMessage}`}
      </div>
      {!isError && !isAnalyzing && (
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
