import { useState } from "react";
import type { RemediationRuntime } from "../../tutor/remediationRuntime";
import { ERROR_PATTERN_LABELS } from "../../tutor/errorPatterns";
import { LessonOverlay } from "./LessonOverlay";

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
      <div className="bg-zinc-900/80 backdrop-blur-2xl ring-1 ring-white/10 rounded-2xl shadow-2xl shadow-black/40 w-full max-w-[560px] p-7 text-zinc-100">
        <div className="flex items-center justify-between mb-4">
          <div className="text-xs text-zinc-500 uppercase tracking-wider">3 分钟专项</div>
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
                    className="w-full text-left px-3 py-2 rounded-md text-sm bg-white/5 hover:bg-white/10 text-zinc-100"
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
                  className="w-full bg-zinc-900/60 ring-1 ring-white/10 rounded-md p-3 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-sky-500 mb-3"
                />
                <button
                  type="button"
                  disabled={draft.trim().length === 0}
                  onClick={() => {
                    runtime.submitAnswer(draft);
                    setVersion((v) => v + 1);
                    setDraft("");
                  }}
                  className="px-4 py-2 rounded-md text-sm bg-sky-500 hover:bg-sky-400 disabled:bg-zinc-700 disabled:text-zinc-500 text-white"
                >
                  提交
                </button>
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
              className="px-4 py-2 rounded-md text-sm bg-sky-500 hover:bg-sky-400 text-white"
            >
              完成
            </button>
          </div>
        )}
      </div>
    </LessonOverlay>
  );
}
