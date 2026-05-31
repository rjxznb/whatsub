import { describe, it, expect, vi } from "vitest";

vi.mock("../../tutor/learnerProfile", () => ({
  loadLearnerProfile: vi.fn().mockResolvedValue({
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    estimate: { cefr: "B1", vocabSize: 3000, listeningLevel: "mid", confidence: 0.7 },
    errorEvents: [
      {
        id: "e1",
        ts: 100,
        source: { type: "lesson", videoId: "v1", cueIdx: 3, questionId: null },
        pattern: "past_tense_irregular",
        detail: "x",
        userInput: "I goed",
        correction: "I went",
        resolved: false,
        resolvedAt: null,
      },
    ],
    masteryIndex: {
      weakPatterns: [
        {
          pattern: "past_tense_irregular",
          occurrences: 3,
          lastSeenAt: 100,
          sampleErrorIds: ["e1"],
          lastRemediatedAt: null,
        },
      ],
      knownWords: [],
      weakWords: [],
    },
    goals: [],
  }),
}));

import { queryLearnerProfileTool } from "./query_learner_profile";

const signal = new AbortController().signal;
const ctx = { signal };

describe("query_learner_profile tool", () => {
  it("id and riskTier are correct", () => {
    expect(queryLearnerProfileTool.id).toBe("query_learner_profile");
    expect(queryLearnerProfileTool.riskTier).toBe("LOW");
  });

  it("availableOn returns true on any page", () => {
    expect(queryLearnerProfileTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(queryLearnerProfileTool.availableOn({ pathname: "/player/abc" })).toBe(true);
  });

  it("summary field returns a string containing CEFR level", async () => {
    const r = await queryLearnerProfileTool.execute({ field: "summary" }, ctx);
    expect(typeof r.text).toBe("string");
    expect(r.text).toContain("B1");
    expect(r.text).toContain("3000");
  });

  it("default field (no field arg) returns summary", async () => {
    const r = await queryLearnerProfileTool.execute({}, ctx);
    expect(r.text).toContain("B1");
  });

  it("weak field returns the top weakPatterns", async () => {
    const r = await queryLearnerProfileTool.execute({ field: "weak" }, ctx);
    expect(r.text).toContain("past_tense_irregular");
    expect(r.text).toContain("×3");
  });

  it("recent field returns latest error events", async () => {
    const r = await queryLearnerProfileTool.execute({ field: "recent" }, ctx);
    expect(r.text).toContain("past_tense_irregular");
    expect(r.text).toContain("I goed");
    expect(r.text).toContain("I went");
  });

  it("doneLabel is constant", () => {
    const label = queryLearnerProfileTool.doneLabel({ text: "anything" });
    expect(label).toBe("已读取学习档案");
  });
});
