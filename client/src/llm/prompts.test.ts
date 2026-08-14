import { describe, expect, it } from "vitest";
import { buildRepairPrompt, buildSystemPrompt } from "./prompts";

describe("analysis prompt contract", () => {
  it("asks providers for compact generated fields and not source echoes", () => {
    const prompt = buildSystemPrompt("colloquial");

    expect(prompt).toContain('"p"');
    expect(prompt).toContain('"i"');
    expect(prompt).not.toContain('"endTime": number');
    expect(prompt).not.toContain('"highlightWords": string[]');
  });

  it("uses the compact streaming cue schema for every provider", () => {
    const prompt = buildSystemPrompt("colloquial");

    expect(prompt).toContain('{"i":12,"zh":');
    expect(prompt).toContain('"p":[["catch up"');
    expect(prompt).toContain("one to five English words");
    expect(prompt).toContain("NEVER exceed eight English words");
    expect(prompt).not.toContain('"isKeyPoint": boolean');
    expect(prompt).not.toContain('"highlights": [{');
  });

  it("builds a repair request containing only unresolved cues", () => {
    const prompt = buildRepairPrompt([
      { index: 17, time: 1, endTime: 2, text: "missing seventeen" },
      { index: 38, time: 3, endTime: 4, text: "missing thirty eight" },
    ]);

    expect(prompt).toContain("missing seventeen");
    expect(prompt).toContain("missing thirty eight");
    expect(prompt).toContain("17\t1.00\t2.00");
    expect(prompt).toContain("38\t3.00\t4.00");
    expect(prompt).not.toContain("source-0");
  });
});
