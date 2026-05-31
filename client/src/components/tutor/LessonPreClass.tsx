import type { LessonPlan } from "../../tutor/types";
import { TokenEstimateBadge } from "./TokenEstimateBadge";
import { TUTOR_CARD, TUTOR_EYEBROW, BTN_PRIMARY, BTN_GHOST } from "./styles";

interface Props {
  plan: LessonPlan;
  videoTitle: string;
  videoDuration: number; // seconds
  vendorId: string;
  vendorLabel: string;
  onStart: () => void;
  onCancel: () => void;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function LessonPreClass({
  plan,
  videoTitle,
  videoDuration,
  vendorId,
  vendorLabel,
  onStart,
  onCancel,
}: Props) {
  return (
    // Flat-zinc card — matches Player/Settings surfaces.
    <div className={`${TUTOR_CARD} w-full max-w-[520px] p-7`}>
      <div className={`${TUTOR_EYEBROW} mb-2`}>准备开课</div>
      <div className="text-base text-zinc-100 mb-5">
        {videoTitle} <span className="text-zinc-500 text-sm">· {formatDuration(videoDuration)}</span>
      </div>

      <div className="text-sm text-zinc-400 mb-1">本节课重点</div>
      <ul className="space-y-1.5 mb-5">
        {plan.anchors.map((a, i) => (
          <li key={i} className="text-sm text-zinc-200 flex gap-2">
            <span className="text-zinc-500 shrink-0">•</span>
            <span>{a.topic}</span>
          </li>
        ))}
      </ul>

      <div className="text-sm text-zinc-400 mb-1">总览</div>
      <div className="text-sm text-zinc-300 mb-5 leading-relaxed">{plan.overview}</div>

      <div className="border-t border-zinc-800 pt-4 mb-5">
        <TokenEstimateBadge
          tokens={plan.estimateTokens}
          vendorId={vendorId}
          vendorLabel={vendorLabel}
        />
        <div className="text-xs text-zinc-500 mt-1">
          {plan.anchors.length} 个教学点 · 实际用量在结课屏对账
        </div>
      </div>

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className={BTN_GHOST}
        >
          取消
        </button>
        <button
          type="button"
          onClick={onStart}
          className={BTN_PRIMARY}
        >
          开始上课
        </button>
      </div>
    </div>
  );
}
