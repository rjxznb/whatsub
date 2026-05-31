import type { LessonSummary, RemediationOffer } from "../../tutor/lessonSummary";
import { ERROR_PATTERN_LABELS } from "../../tutor/errorPatterns";
import { TUTOR_CARD, TUTOR_EYEBROW, BTN_PRIMARY, BTN_GHOST } from "./styles";

interface Props {
  summary: LessonSummary;
  remediationOffer: RemediationOffer | null;
  onStartRemediation: () => void;
  onStartRoleplay: () => void;
  onClose: () => void;
}

export function LessonEnd({
  summary,
  remediationOffer,
  onStartRemediation,
  onStartRoleplay,
  onClose,
}: Props) {
  return (
    <div className={`${TUTOR_CARD} w-full max-w-[560px] p-7`}>
      <div className={`${TUTOR_EYEBROW} mb-2`}>完成</div>
      <div className="text-2xl text-zinc-100 mb-6">本节课结束</div>

      <div className="space-y-3 mb-6">
        <div className="text-sm text-zinc-400">你今天学了</div>
        <ul className="space-y-1.5">
          {summary.topicsLearned.map((t, i) => (
            <li key={i} className="text-sm text-zinc-200 flex gap-2">
              <span className="text-emerald-500 shrink-0">✓</span>
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-zinc-800 pt-4 mb-6">
        <div className="text-sm text-zinc-400">答题表现</div>
        <div className="text-lg text-zinc-100 mt-1">
          {summary.correctCount} / {summary.totalAnchors} 答对
        </div>
        {summary.errorCount > 0 && (
          <div className="text-xs text-zinc-500 mt-1">
            {summary.errorCount} 条错误已写入学习档案
          </div>
        )}
      </div>

      {remediationOffer && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-4 mb-6">
          <div className="text-sm text-amber-200 mb-2">
            ⚠ 本周第 {remediationOffer.occurrences} 次错「
            {ERROR_PATTERN_LABELS[remediationOffer.pattern]}」
          </div>
          <button
            type="button"
            onClick={onStartRemediation}
            className="px-4 py-2 rounded-md text-sm bg-amber-500 hover:bg-amber-400 text-zinc-900 font-medium"
          >
            来 3 分钟专项
          </button>
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onClose}
          className={BTN_GHOST}
        >
          回主页
        </button>
        <button
          type="button"
          onClick={onStartRoleplay}
          className={BTN_PRIMARY}
        >
          角色扮演巩固
        </button>
      </div>
    </div>
  );
}
