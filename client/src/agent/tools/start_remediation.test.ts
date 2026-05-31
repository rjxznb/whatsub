import { describe, it, expect, beforeEach } from "vitest";
import { startRemediationTool } from "./start_remediation";
import { useTutorRuntime } from "../../store/tutorRuntime";

const signal = new AbortController().signal;
const ctx = { signal };

beforeEach(() => {
  useTutorRuntime.setState({ mode: { kind: "none" } });
});

describe("start_remediation tool", () => {
  it("id and riskTier are correct", () => {
    expect(startRemediationTool.id).toBe("start_remediation");
    expect(startRemediationTool.riskTier).toBe("MID");
  });

  it("availableOn returns true on any page", () => {
    expect(startRemediationTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(startRemediationTool.availableOn({ pathname: "/player/abc" })).toBe(true);
  });

  it("execute pushes remediation mode with the requested pattern", async () => {
    const result = await startRemediationTool.execute(
      { pattern: "past_tense_irregular" },
      ctx,
    );
    expect(result.launched).toBe(true);
    expect(result.pattern).toBe("past_tense_irregular");
    const mode = useTutorRuntime.getState().mode;
    expect(mode.kind).toBe("remediation");
    if (mode.kind === "remediation") {
      expect(mode.pattern).toBe("past_tense_irregular");
      expect(mode.candidateErrorIds).toEqual([]);
    }
  });

  it("throws on unknown patterns", async () => {
    await expect(
      startRemediationTool.execute({ pattern: "made_up_pattern" }, ctx),
    ).rejects.toThrow("未知错误类别");
  });

  it("throws when pattern has no question bank", async () => {
    // "other" is a valid ErrorPattern but has no bank in remediationQuestions
    await expect(
      startRemediationTool.execute({ pattern: "other" }, ctx),
    ).rejects.toThrow("暂无题库");
  });

  it("doneLabel includes the pattern name", () => {
    const label = startRemediationTool.doneLabel({
      launched: true,
      pattern: "article_missing",
    });
    expect(label).toContain("article_missing");
  });
});
