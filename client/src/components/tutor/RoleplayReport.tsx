import type { ForensicReport } from "../../tutor/types";
import { ERROR_PATTERN_LABELS } from "../../tutor/errorPatterns";

interface Props {
  report: ForensicReport;
  onAnother: () => void;
  onRemediate: () => void;
  onClose: () => void;
}

export function RoleplayReport({ report, onAnother, onRemediate, onClose }: Props) {
  return (
    <div className="bg-zinc-900/80 backdrop-blur-2xl ring-1 ring-white/10 rounded-2xl shadow-2xl shadow-black/40 w-full max-w-[600px] p-7 text-zinc-100">
      <div className="text-xs text-zinc-500 uppercase tracking-wider mb-2">复盘</div>
      <div className="text-base text-zinc-100 mb-5">
        共 {report.totalUserTurns} 轮 · {report.naturalCount} 句很自然 ✓
      </div>

      {report.fallback && (
        <div className="text-xs text-amber-400 bg-amber-500/10 px-3 py-2 rounded mb-4">
          使用更强模型可看趋势分析
        </div>
      )}

      {report.chinglishExamples.length > 0 && (
        <div className="mb-4">
          <div className="text-sm text-zinc-400 mb-2">📝 中式英语</div>
          <ul className="space-y-1.5">
            {report.chinglishExamples.map((e, i) => (
              <li key={i} className="text-sm text-zinc-300">
                <span className="text-rose-300">{e.original}</span>
                <span className="text-zinc-500 mx-2">→</span>
                <span className="text-emerald-300">{e.better}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.patternHits.length > 0 && (
        <div className="mb-4">
          <div className="text-sm text-zinc-400 mb-2">⏰ 重复出错</div>
          <ul className="space-y-1.5">
            {report.patternHits.map((p, i) => (
              <li key={i} className="text-sm text-zinc-200">
                {ERROR_PATTERN_LABELS[p.pattern]} ×{p.count}
                {p.monthCount !== undefined && (
                  <span className="text-zinc-500"> · 本月第 {p.monthCount} 次</span>
                )}
                {p.example && <div className="text-xs text-zinc-500 ml-3 mt-0.5">"{p.example}"</div>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.registerNotes.length > 0 && (
        <div className="mb-4">
          <div className="text-sm text-zinc-400 mb-2">💡 语体提醒</div>
          <ul className="space-y-1.5">
            {report.registerNotes.map((n, i) => (
              <li key={i} className="text-sm text-zinc-200">{n}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="text-xs text-zinc-500 mb-4">所有错误已记录到学习档案</div>

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 rounded-md text-sm text-zinc-300 hover:bg-white/5"
        >
          回主页
        </button>
        <button
          type="button"
          onClick={onRemediate}
          className="px-4 py-2 rounded-md text-sm bg-amber-500/20 hover:bg-amber-500/30 text-amber-200"
        >
          开专项
        </button>
        <button
          type="button"
          onClick={onAnother}
          className="px-4 py-2 rounded-md text-sm bg-sky-500 hover:bg-sky-400 text-white"
        >
          再来一轮
        </button>
      </div>
    </div>
  );
}
