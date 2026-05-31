import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SETTINGS } from "../../types/settings";
import { useSettings } from "../../store/settings";
import { useAnalysis } from "../../store/analysis";
import { useTutorRuntime } from "../../store/tutorRuntime";

vi.mock("../../tutor/lessonPlanLLM", () => ({
  planLesson: vi.fn(),
}));
vi.mock("../../tutor/learnerProfile", () => ({
  loadLearnerProfile: vi.fn().mockResolvedValue({
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    estimate: { cefr: null, vocabSize: null, listeningLevel: null, confidence: 0 },
    errorEvents: [],
    masteryIndex: { weakPatterns: [], knownWords: [], weakWords: [] },
    goals: [],
  }),
}));

import { planLesson } from "../../tutor/lessonPlanLLM";
const mockPlan = planLesson as ReturnType<typeof vi.fn>;

import { startLessonTool } from "./start_lesson";

const signal = new AbortController().signal;
const ctx = { signal };

beforeEach(() => {
  mockPlan.mockReset();
  useTutorRuntime.setState({ mode: { kind: "none" } });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useAnalysis.setState({ subtitles: [] });
});

describe("start_lesson tool", () => {
  it("id and riskTier are correct", () => {
    expect(startLessonTool.id).toBe("start_lesson");
    expect(startLessonTool.riskTier).toBe("HIGH");
  });

  it("availableOn returns true for /player/* and false elsewhere", () => {
    expect(startLessonTool.availableOn({ pathname: "/player/abc" })).toBe(true);
    expect(startLessonTool.availableOn({ pathname: "/library" })).toBe(false);
    expect(startLessonTool.availableOn({ pathname: "/corpus" })).toBe(false);
  });

  it("execute pushes lesson-preclass mode on success", async () => {
    mockPlan.mockResolvedValue({
      videoId: "abc",
      estimateTokens: 3000,
      overview: "教入境对话",
      anchors: [
        { cueIdx: 3, topic: "T1", whyThisOne: "y", targetPatterns: [] },
        { cueIdx: 10, topic: "T2", whyThisOne: "z", targetPatterns: [] },
      ],
    });
    const result = await startLessonTool.execute({ videoId: "abc" }, ctx);
    expect(result.overview).toBe("教入境对话");
    expect(result.anchorCount).toBe(2);
    expect(result.estimateTokens).toBe(3000);
    const mode = useTutorRuntime.getState().mode;
    expect(mode.kind).toBe("lesson-preclass");
    if (mode.kind === "lesson-preclass") {
      expect(mode.videoId).toBe("abc");
      expect(mode.plan.anchors).toHaveLength(2);
    }
  });

  it("execute throws if planLesson returns null", async () => {
    mockPlan.mockResolvedValue(null);
    await expect(startLessonTool.execute({ videoId: "abc" }, ctx)).rejects.toThrow(
      "无法生成教学计划",
    );
    // mode should remain none
    expect(useTutorRuntime.getState().mode.kind).toBe("none");
  });

  it("doneLabel includes overview and anchor count", () => {
    const label = startLessonTool.doneLabel({
      overview: "测试",
      anchorCount: 5,
      estimateTokens: 2000,
    });
    expect(label).toContain("测试");
    expect(label).toContain("5");
  });
});
