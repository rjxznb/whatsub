import { useState } from "react";
import type { RemediationRuntime } from "../../tutor/remediationRuntime";
import { ERROR_PATTERN_LABELS } from "../../tutor/errorPatterns";
import { LessonOverlay } from "./LessonOverlay";
import { TUTOR_CARD, TUTOR_EYEBROW, TUTOR_TEXTAREA, BTN_PRIMARY } from "./styles";
import { VoiceDictationButton } from "../voice/VoiceDictationButton";

interface Props {
  runtime: RemediationRuntime | null;
  onFinish: () => void;
  onClose: () => void;
}

export function RemediationOverlay({ runtime, onFinish, onClose }: Props) {
  const [draft, setDraft] = useState("");
  const [version, setVersion] = useState(0); // force re-render after submitAnswer
  const open = runtime !== null;

  if (!runtime) return <LessonOverlay open={false} onClose={onClose}>{null}</LessonOverlay>;

  const total = runtime.state.questions.length;
  const idx = runtime.state.currentIdx;
  const q = runtime.state.questions[idx];

  return (
    <LessonOverlay open={open} onClose={onClose}>
      <div className={`${TUTOR_CARD} w-full max-w-[560px] p-7`}>
        <div className="flex items-center justify-between mb-4">
          <div className={TUTOR_EYEBROW}>3 分钟专项</div>
          <div className="text-xs text-zinc-500">
            {ERROR_PATTERN_LABELS[runtime.state.pattern]}
          </div>
        </div>

        {!runtime.isComplete() && q && (
          <>
            <div className="text-xs text-zinc-500 mb-2">
              {idx + 1} / {total}
            </div>
            <div className="text-base text-zinc-100 mb-4">{q.prompt}</div>

            {q.type === "choice" && q.choices ? (
              <div className="space-y-2 mb-4">
                {q.choices.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      runtime.submitAnswer(c);
                      setVersion((v) => v + 1);
                      setDraft("");
                    }}
                    className="w-full text-left px-3 py-2 rounded-md text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-100 transition-colors"
                  >
                    {c}
                  </button>
                ))}
              </div>
            ) : (
              <>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={2}
                  placeholder="作答…（也可点麦克风语音作答）"
                  className={`${TUTOR_TEXTAREA} mb-3`}
                />
                <div className="flex items-center gap-2">
                  <VoiceDictationButton
                    onText={(t) => setDraft((d) => (d.trim() ? `${d.trim()} ${t}` : t))}
                  />
                  <button
                    type="button"
                    disabled={draft.trim().length === 0}
                    onClick={() => {
                      runtime.submitAnswer(draft);
                      setVersion((v) => v + 1);
                      setDraft("");
                    }}
                    className={BTN_PRIMARY}
                  >
                    提交
                  </button>
                </div>
              </>
            )}
            {q.hint && (
              <div className="text-xs text-zinc-500 mt-2">提示: {q.hint}</div>
            )}
            <div className="hidden">{version /* anchor re-renders */}</div>
          </>
        )}

        {runtime.isComplete() && (
          <div className="space-y-4">
            <div className="text-base text-zinc-100">
              答对 {runtime.state.correctCount} / {total}
            </div>
            <div
              className={
                "text-sm " +
                (runtime.passPercent() >= 0.7 ? "text-emerald-400" : "text-amber-400")
              }
            >
              {runtime.passPercent() >= 0.7
                ? "✓ 通过 — 相关错误已标记掌握"
                : "继续多练几次吧"}
            </div>
            <button
              type="button"
              onClick={async () => {
                await runtime.finish();
                onFinish();
              }}
              className={BTN_PRIMARY}
            >
              完成
            </button>
          </div>
        )}
      </div>
    </LessonOverlay>
  );
}
