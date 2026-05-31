import { describe, it, expect, vi, beforeEach } from "vitest";
import { LessonRuntime } from "./lessonRuntime";
import type { LessonPlan } from "./types";

const plan: LessonPlan = {
  videoId: "abc",
  estimateTokens: 3000,
  overview: "x",
  anchors: [
    { cueIdx: 3, topic: "T1", whyThisOne: "y", targetPatterns: ["preposition_wrong"] },
    { cueIdx: 12, topic: "T2", whyThisOne: "y", targetPatterns: ["present_perfect_vs_past"] },
  ],
};

const mockLlm = {
  explain: vi.fn(),
  question: vi.fn(),
  feedback: vi.fn(),
};

const mockProfile = {
  logEvent: vi.fn(),
};

const mockPersist = {
  save: vi.fn(),
  clear: vi.fn(),
};

const mockPlayer = {
  seek: vi.fn(),
};

beforeEach(() => {
  for (const v of Object.values(mockLlm)) v.mockReset();
  mockProfile.logEvent.mockReset();
  mockPersist.save.mockReset();
  mockPersist.clear.mockReset();
  mockPlayer.seek.mockReset();
});

describe("LessonRuntime", () => {
  it("starts at anchor 0, step 1 + seeks player", async () => {
    const r = new LessonRuntime({ plan, llm: mockLlm, profile: mockProfile, persist: mockPersist, player: mockPlayer });
    await r.start();
    expect(r.state.currentAnchorIdx).toBe(0);
    expect(r.state.currentStep).toBe(1);
    expect(mockPlayer.seek).toHaveBeenCalledWith(3);
  });

  it("advanceToExplain calls explain LLM + transitions to step 2", async () => {
    mockLlm.explain.mockResolvedValue("讲解内容");
    const r = new LessonRuntime({ plan, llm: mockLlm, profile: mockProfile, persist: mockPersist, player: mockPlayer });
    await r.start();
    await r.advanceToExplain();
    expect(mockLlm.explain).toHaveBeenCalled();
    expect(r.state.currentStep).toBe(2);
    expect(r.state.currentExplainText).toBe("讲解内容");
  });

  it("advanceToQuestion calls question LLM + transitions to step 3", async () => {
    mockLlm.explain.mockResolvedValue("x");
    mockLlm.question.mockResolvedValue({
      question: "Q?", expectedAnswer: "A.", targetPattern: "preposition_wrong",
    });
    const r = new LessonRuntime({ plan, llm: mockLlm, profile: mockProfile, persist: mockPersist, player: mockPlayer });
    await r.start();
    await r.advanceToExplain();
    await r.advanceToQuestion();
    expect(r.state.currentStep).toBe(3);
    expect(r.state.currentQuestion?.question).toBe("Q?");
  });

  it("correct answer: feedback emit no events + advance to next anchor", async () => {
    mockLlm.explain.mockResolvedValue("x");
    mockLlm.question.mockResolvedValue({ question: "Q?", expectedAnswer: "A.", targetPattern: "preposition_wrong" });
    mockLlm.feedback.mockResolvedValue({ verdict: "correct", feedback: "好", errors: [] });
    const r = new LessonRuntime({ plan, llm: mockLlm, profile: mockProfile, persist: mockPersist, player: mockPlayer });
    await r.start();
    await r.advanceToExplain();
    await r.advanceToQuestion();
    await r.submitAnswer("A.");
    expect(r.state.currentFeedback?.verdict).toBe("correct");
    expect(mockProfile.logEvent).not.toHaveBeenCalled();
    await r.continueToNextAnchor();
    expect(r.state.currentAnchorIdx).toBe(1);
    expect(mockPlayer.seek).toHaveBeenLastCalledWith(12);
  });

  it("incorrect answer: 1st attempt → logs event + enters hint mode (canRetry)", async () => {
    mockLlm.explain.mockResolvedValue("x");
    mockLlm.question.mockResolvedValue({ question: "Q?", expectedAnswer: "A.", targetPattern: "preposition_wrong" });
    mockLlm.feedback.mockResolvedValue({
      verdict: "incorrect",
      feedback: "想想 come 还是 here",
      errors: [{ pattern: "preposition_wrong", userText: "wrong", correction: "right", detail: "x" }],
    });
    const r = new LessonRuntime({ plan, llm: mockLlm, profile: mockProfile, persist: mockPersist, player: mockPlayer });
    await r.start();
    await r.advanceToExplain();
    await r.advanceToQuestion();
    await r.submitAnswer("wrong");
    expect(r.state.attemptsThisAnchor).toBe(1);
    // EventS still get written even on wrong-attempt-1 (spec: 错误事件无条件)
    expect(mockProfile.logEvent).toHaveBeenCalledTimes(1);
    // But user stays at step 3 (the question) for another attempt
    expect(r.state.canRetry).toBe(true);
  });

  it("incorrect answer: 2nd attempt → reveal answer + force-advance", async () => {
    mockLlm.explain.mockResolvedValue("x");
    mockLlm.question.mockResolvedValue({ question: "Q?", expectedAnswer: "A.", targetPattern: "preposition_wrong" });
    mockLlm.feedback.mockResolvedValue({
      verdict: "incorrect",
      feedback: "答案是 A.",
      errors: [{ pattern: "preposition_wrong", userText: "wrong2", correction: "A.", detail: "x" }],
    });
    const r = new LessonRuntime({ plan, llm: mockLlm, profile: mockProfile, persist: mockPersist, player: mockPlayer });
    await r.start();
    await r.advanceToExplain();
    await r.advanceToQuestion();
    await r.submitAnswer("wrong1");
    await r.submitAnswer("wrong2");
    expect(r.state.attemptsThisAnchor).toBe(2);
    expect(r.state.canRetry).toBe(false);
    expect(r.state.answerRevealed).toBe(true);
    expect(mockProfile.logEvent).toHaveBeenCalledTimes(2);
  });

  it("persists state after each step transition", async () => {
    mockLlm.explain.mockResolvedValue("x");
    const r = new LessonRuntime({ plan, llm: mockLlm, profile: mockProfile, persist: mockPersist, player: mockPlayer });
    await r.start();
    expect(mockPersist.save).toHaveBeenCalled();
    mockPersist.save.mockClear();
    await r.advanceToExplain();
    expect(mockPersist.save).toHaveBeenCalled();
  });

  it("clears persisted state on completion", async () => {
    mockLlm.explain.mockResolvedValue("x");
    mockLlm.question.mockResolvedValue({ question: "Q?", expectedAnswer: "A.", targetPattern: "preposition_wrong" });
    mockLlm.feedback.mockResolvedValue({ verdict: "correct", feedback: "好", errors: [] });
    const r = new LessonRuntime({ plan, llm: mockLlm, profile: mockProfile, persist: mockPersist, player: mockPlayer });
    await r.start();
    for (let i = 0; i < plan.anchors.length; i++) {
      await r.advanceToExplain();
      await r.advanceToQuestion();
      await r.submitAnswer("A.");
      if (i < plan.anchors.length - 1) await r.continueToNextAnchor();
    }
    await r.finish();
    expect(mockPersist.clear).toHaveBeenCalled();
    expect(r.state.completed).toBe(true);
  });
});
