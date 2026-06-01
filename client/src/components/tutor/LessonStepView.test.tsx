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

  it("step 2 with empty explain shows the 讲解 placeholder", () => {
    render(<LessonStepView runtime={makeRuntime({ currentStep: 2 })} onContinue={vi.fn()} onRetry={vi.fn()} onReplayCue={vi.fn()} onSubmitAnswer={vi.fn()} />);
    expect(screen.getByText(/老师正在讲解/)).toBeTruthy();
  });

  it("auto-plays the original cue when the listen step (1) appears", () => {
    const onReplayCue = vi.fn();
    render(
      <LessonStepView
        runtime={makeRuntime({ currentStep: 1 })}
        onContinue={vi.fn()}
        onRetry={vi.fn()}
        onReplayCue={onReplayCue}
        onSubmitAnswer={vi.fn()}
        onStopVideo={vi.fn()}
      />,
    );
    expect(onReplayCue).toHaveBeenCalledTimes(1);
  });

  it("stops the video when a coaching step (2) appears", () => {
    const onStopVideo = vi.fn();
    render(
      <LessonStepView
        runtime={makeRuntime({ currentStep: 2, currentExplainText: "讲解中" })}
        onContinue={vi.fn()}
        onRetry={vi.fn()}
        onReplayCue={vi.fn()}
        onSubmitAnswer={vi.fn()}
        onStopVideo={onStopVideo}
      />,
    );
    expect(onStopVideo).toHaveBeenCalledTimes(1);
  });

  it("renders markdown bold in the explanation (no literal **)", () => {
    render(
      <LessonStepView
        runtime={makeRuntime({
          currentStep: 2,
          currentExplainText: "这是 **closeout game**",
        })}
        onContinue={vi.fn()}
        onRetry={vi.fn()}
        onReplayCue={vi.fn()}
        onSubmitAnswer={vi.fn()}
      />,
    );
    // bold rendered as <strong>, raw ** stripped
    expect(screen.getByText("closeout game")).toBeTruthy();
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it("shows a Chinese + English voice picker defaulting to 晓晓 + Aria", () => {
    render(
      <LessonStepView
        runtime={makeRuntime({ currentStep: 2, currentExplainText: "讲解中" })}
        onContinue={vi.fn()}
        onRetry={vi.fn()}
        onReplayCue={vi.fn()}
        onSubmitAnswer={vi.fn()}
      />,
    );
    const zh = screen.getByLabelText("中文语音") as HTMLSelectElement;
    const en = screen.getByLabelText("英文语音") as HTMLSelectElement;
    expect(zh.value).toBe("zh-CN-XiaoxiaoNeural");
    expect(en.value).toBe("en-US-AriaNeural");
    // representative options from each language
    expect(screen.getByText("云希（男）")).toBeTruthy();
    expect(screen.getByText("Sonia（女）")).toBeTruthy();
  });

  it("busy: shows the generating spinner + disables the action button", () => {
    render(
      <LessonStepView
        runtime={makeRuntime({ currentStep: 1 })}
        onContinue={vi.fn()}
        onRetry={vi.fn()}
        onReplayCue={vi.fn()}
        onSubmitAnswer={vi.fn()}
        busy
      />,
    );
    expect(screen.getByText("生成中…")).toBeTruthy();
    // the primary action is disabled while generating
    const btn = screen.getByText("生成中…").closest("button");
    expect(btn?.disabled).toBe(true);
  });

  it("calls onExit when the exit button is clicked", () => {
    const onExit = vi.fn();
    render(
      <LessonStepView
        runtime={makeRuntime()}
        onContinue={vi.fn()}
        onRetry={vi.fn()}
        onReplayCue={vi.fn()}
        onSubmitAnswer={vi.fn()}
        onExit={onExit}
      />,
    );
    screen.getByLabelText("退出精讲").click();
    expect(onExit).toHaveBeenCalledTimes(1);
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
