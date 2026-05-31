import { useState } from "react";
import type { LessonRuntime } from "../../tutor/lessonRuntime";

interface Props {
  runtime: LessonRuntime;
  onContinue: () => void;
  onRetry: () => void;
  onReplayCue: () => void;
}

/** Renders the current step of the lesson runtime. Step 1 starts with
 *  a replay button + "试试理解" toggle; steps 2/3 render LLM-streamed
 *  content; step 4 is the textarea; step 5 is feedback + continue.
 *  All step transitions are driven by the parent overlay calling runtime
 *  methods after this component dispatches an `on*` callback. */
export function LessonStepView({ runtime, onContinue, onRetry, onReplayCue }: Props) {
  const [draft, setDraft] = useState("");

  const { currentStep, currentExplainText, currentQuestion, currentFeedback,
    canRetry, answerRevealed, currentAnchorIdx } = runtime.state;
  const totalAnchors = runtime.state.plan.anchors.length;
  const anchor = runtime.state.plan.anchors[currentAnchorIdx];

  return (
    <div className="bg-zinc-900/80 backdrop-blur-2xl ring-1 ring-white/10 rounded-2xl shadow-2xl shadow-black/40 w-full max-w-[640px] p-7 text-zinc-100">
      <div className="flex items-center justify-between mb-4">
        <div className="text-xs text-zinc-500 uppercase tracking-wider">
          教学点 {currentAnchorIdx + 1} / {totalAnchors}
        </div>
        <div className="text-xs text-zinc-500">{anchor?.topic}</div>
      </div>

      {currentStep === 1 && (
        <div className="space-y-4">
          <div className="text-sm text-zinc-300 leading-relaxed">
            这一段你听到了什么？先试试理解。
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onReplayCue}
              className="px-4 py-2 rounded-md text-sm bg-white/5 hover:bg-white/10 text-zinc-200"
            >
              ▶ 重听
            </button>
            <button
              type="button"
              onClick={onContinue}
              className="px-4 py-2 rounded-md text-sm bg-sky-500 hover:bg-sky-400 text-white"
            >
              我准备好了
            </button>
          </div>
        </div>
      )}

      {currentStep === 2 && (
        <div className="space-y-4">
          <div className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
            {currentExplainText || <span className="text-zinc-600">生成中…</span>}
          </div>
          {currentExplainText && (
            <button
              type="button"
              onClick={onContinue}
              className="px-4 py-2 rounded-md text-sm bg-sky-500 hover:bg-sky-400 text-white"
            >
              下一步 →
            </button>
          )}
        </div>
      )}

      {currentStep === 3 && currentQuestion && (
        <div className="space-y-4">
          <div className="text-sm text-zinc-400">题目</div>
          <div className="text-base text-zinc-100">{currentQuestion.question}</div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="用英文作答…"
            rows={3}
            className="w-full bg-zinc-900/60 ring-1 ring-white/10 rounded-md p-3 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-sky-500"
          />
          <button
            type="button"
            onClick={() => {
              if (draft.trim().length === 0) return;
              onContinue(); // parent calls runtime.submitAnswer(draft)
              setDraft("");
            }}
            disabled={draft.trim().length === 0}
            className="px-4 py-2 rounded-md text-sm bg-sky-500 hover:bg-sky-400 disabled:bg-zinc-700 disabled:text-zinc-500 text-white"
            data-answer-draft={draft}
          >
            提交答案
          </button>
        </div>
      )}

      {currentStep === 5 && currentFeedback && (
        <div className="space-y-4">
          <div
            className={
              "text-sm font-medium " +
              (currentFeedback.verdict === "correct" ? "text-emerald-400"
                : currentFeedback.verdict === "partial" ? "text-amber-400"
                : "text-rose-400")
            }
          >
            {currentFeedback.verdict === "correct" ? "✓ 答对了" :
              currentFeedback.verdict === "partial" ? "≈ 基本对" : "✗ 还差一点"}
          </div>
          <div className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap">
            {currentFeedback.feedback}
          </div>
          {answerRevealed && currentQuestion && (
            <div className="text-sm text-zinc-400 bg-white/5 rounded p-3">
              <div className="text-xs text-zinc-500 mb-1">参考答案</div>
              {currentQuestion.expectedAnswer}
            </div>
          )}
          <div className="flex gap-2">
            {canRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="px-4 py-2 rounded-md text-sm bg-white/5 hover:bg-white/10 text-zinc-200"
              >
                再试一次
              </button>
            )}
            <button
              type="button"
              onClick={onContinue}
              className="px-4 py-2 rounded-md text-sm bg-sky-500 hover:bg-sky-400 text-white"
            >
              {runtime.hasMoreAnchors() ? "下一个教学点 →" : "结课"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
