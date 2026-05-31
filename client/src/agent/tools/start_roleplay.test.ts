import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SETTINGS } from "../../types/settings";
import { useSettings } from "../../store/settings";
import { useAnalysis } from "../../store/analysis";
import { useTutorRuntime } from "../../store/tutorRuntime";

vi.mock("../../tutor/roleplaySceneLLM", () => ({
  deriveScenarios: vi.fn().mockResolvedValue([
    {
      id: "1",
      title: "你当旅客我当海关",
      setup: "入境检查场景",
      userRole: "旅客",
      agentRole: "海关",
      difficulty: 2,
      sourceVideoId: "v1",
      vocabHints: [],
    },
  ]),
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

import { startRoleplayTool } from "./start_roleplay";

const signal = new AbortController().signal;
const ctx = { signal };

beforeEach(() => {
  useTutorRuntime.setState({ mode: { kind: "none" } });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useAnalysis.setState({ subtitles: [] });
});

describe("start_roleplay tool", () => {
  it("id and riskTier are correct", () => {
    expect(startRoleplayTool.id).toBe("start_roleplay");
    expect(startRoleplayTool.riskTier).toBe("HIGH");
  });

  it("availableOn returns true on any page", () => {
    expect(startRoleplayTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(startRoleplayTool.availableOn({ pathname: "/player/abc" })).toBe(true);
  });

  it("execute pushes scenarios into roleplay-picker mode", async () => {
    const result = await startRoleplayTool.execute({ sourceVideoId: "v1" }, ctx);
    expect(result.count).toBe(1);
    const mode = useTutorRuntime.getState().mode;
    expect(mode.kind).toBe("roleplay-picker");
    if (mode.kind === "roleplay-picker") {
      expect(mode.loading).toBe(false);
      expect(mode.scenarios).toHaveLength(1);
      expect(mode.scenarios[0].title).toBe("你当旅客我当海关");
      expect(mode.sourceVideoId).toBe("v1");
    }
  });

  it("execute without sourceVideoId uses null in store", async () => {
    await startRoleplayTool.execute({}, ctx);
    const mode = useTutorRuntime.getState().mode;
    expect(mode.kind).toBe("roleplay-picker");
    if (mode.kind === "roleplay-picker") {
      expect(mode.sourceVideoId).toBeNull();
    }
  });

  it("doneLabel includes scenario count", () => {
    const label = startRoleplayTool.doneLabel({ count: 3 });
    expect(label).toContain("3");
  });
});
