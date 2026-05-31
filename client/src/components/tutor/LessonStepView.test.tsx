import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LessonStepView } from "./LessonStepView";
import type { LessonRuntime } from "../../tutor/lessonRuntime";

// We don't construct a real runtime — we shape-test the component with
// a mocked runtime object exposing only what the view reads. The runtime
// state machine is independently covered in lessonRuntime.test.ts.
function makeRuntime(overrides: Partial<LessonRuntime["state"]> = {}): LessonRuntime {
  const state = {
    plan: { videoId: "x", estimateTokens: 0, overview: "", anchors: [
      { cueIdx: 3, topic: "T1", whyThisOne: "", targetPatterns: [] as never[] }
    ]},
    currentAnchorIdx: 0,
    currentStep: 1 as 1,
    currentExplainText: "",
    currentQuestion: null,
    currentFeedback: null,
    attemptsThisAnchor: 0,
    canRetry: false,
    answerRevealed: false,
    history: [],
    errorsThisSession: [],
    completed: false,
    videoId: "x",
    startedAt: 0,
    ...overrides,
  };
  return { state, hasNextAnchor: () => false } as unknown as LessonRuntime;
}

describe("LessonStepView", () => {
  it("step 1 shows 我准备好了 + 重听", () => {
    render(<LessonStepView runtime={makeRuntime()} onContinue={vi.fn()} onRetry={vi.fn()} onReplayCue={vi.fn()} onSubmitAnswer={vi.fn()} />);
    expect(screen.getByText(/我准备好了/)).toBeTruthy();
    expect(screen.getByText(/重听/)).toBeTruthy();
  });

  it("step 2 with empty explain shows 生成中", () => {
    render(<LessonStepView runtime={makeRuntime({ currentStep: 2 })} onContinue={vi.fn()} onRetry={vi.fn()} onReplayCue={vi.fn()} onSubmitAnswer={vi.fn()} />);
    expect(screen.getByText(/生成中/)).toBeTruthy();
  });

  it("step 5 correct verdict shows ✓ 答对了", () => {
    render(
      <LessonStepView
        runtime={makeRuntime({
          currentStep: 5,
          currentFeedback: { verdict: "correct", feedback: "x", errors: [] },
        })}
        onContinue={vi.fn()}
        onRetry={vi.fn()}
        onReplayCue={vi.fn()}
        onSubmitAnswer={vi.fn()}
      />,
    );
    expect(screen.getByText(/答对了/)).toBeTruthy();
  });
});
