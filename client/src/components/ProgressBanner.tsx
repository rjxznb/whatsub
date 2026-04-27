import { useAnalysis } from "../store/analysis";

const PHASE_LABELS: Record<string, string> = {
  downloading: "下载视频",
  extracting: "抽取音频",
  transcribing: "本地转录",
  analyzing: "AI 分析字幕",
  complete: "完成",
  error: "失败",
};

export function ProgressBanner() {
  const { phase, progressPercent, errorMessage, subtitles } = useAnalysis();
  if (phase === "idle" || phase === "complete") return null;

  return (
    <div
      className={
        "px-4 py-2 text-sm flex items-center gap-3 " +
        (phase === "error" ? "bg-red-900/40 text-red-200" : "bg-blue-900/40 text-blue-100")
      }
    >
      <div className="flex-1">
        {PHASE_LABELS[phase] ?? phase}
        {phase === "analyzing" && ` (${subtitles.length} 行已生成)`}
        {errorMessage && ` — ${errorMessage}`}
      </div>
      {phase !== "error" && phase !== "analyzing" && (
        <div className="w-32 h-1.5 bg-zinc-700 rounded overflow-hidden">
          <div className="h-full bg-blue-400" style={{ width: `${progressPercent}%` }} />
        </div>
      )}
    </div>
  );
}
