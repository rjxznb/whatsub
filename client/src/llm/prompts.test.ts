import { describe, expect, it } from "vitest";
import {
  buildAnnotationRepairPrompt,
  buildContinuationPrompt,
  buildRepairPrompt,
  buildSummaryPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from "./prompts";
import type { Subtitle } from "./types";

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
    expect(prompt).toContain("one to four English words");
    expect(prompt).toContain("25 to 90 Chinese characters");
    expect(prompt).not.toContain('"isKeyPoint": boolean');
    expect(prompt).not.toContain('"highlights": [{');
    expect(prompt).not.toContain('"type": "summary"');
    expect(prompt).not.toContain('"keyPhrases": [{');
  });

  it("builds a repair request containing only unresolved cues", () => {
    const prompt = buildRepairPrompt([
      { index: 17, time: 1, endTime: 2, text: "missing seventeen" },
      { index: 38, time: 3, endTime: 4, text: "missing thirty eight" },
    ], { maxHighlightedCues: 3 });

    expect(prompt).toContain("missing seventeen");
    expect(prompt).toContain("missing thirty eight");
    expect(prompt).toContain("17\t1.00\t2.00");
    expect(prompt).toContain("38\t3.00\t4.00");
    expect(prompt).not.toContain("source-0");
    expect(prompt).toContain("At most 3 cues in this request may have a non-empty p array");
  });

  it("builds an annotation-only repair request from accepted translations", () => {
    const prompt = buildAnnotationRepairPrompt([{
      index: 17,
      text: "give it a shot",
      translation: "试试看吧",
    }], { maxHighlightedCues: 2 });

    expect(prompt).toContain("give it a shot");
    expect(prompt).toContain("试试看吧");
    expect(prompt).toContain('{"i":12,"p":');
    expect(prompt).toContain("Do not translate again");
    expect(prompt).not.toContain('"zh"');
    expect(prompt).toContain("This is a hard ceiling, not a quota");
    expect(prompt).toContain("roughly 60% to 100%");
  });

  it("requests a compact global phrase summary with the same length boundary", () => {
    const subtitle: Subtitle = {
      time: 0,
      endTime: 1,
      text: "give it a shot",
      translation: "试试看",
      isKeyPoint: true,
      highlightWords: ["give it a shot"],
      keyNotes: { "give it a shot": "用于鼓励别人尝试" },
      highlightTranslations: { "give it a shot": "试试看" },
    };
    const prompt = buildSummaryPrompt([subtitle]);

    expect(prompt).toContain('{"p":[["catch up"');
    expect(prompt).toContain("one to four English words");
    expect(prompt).toContain("25-90 Unicode code points");
    expect(prompt).not.toContain('"type":"summary"');
  });

  it.each([
    ["cue", buildUserPrompt],
    ["continuation", buildContinuationPrompt],
  ])("includes the exact compact allowance in the %s prompt", (_name, builder) => {
    const prompt = builder([
      { index: 1, time: 0, endTime: 1, text: "give it a shot" },
    ], { maxHighlightedCues: 3 });
    expect(prompt).toContain("At most 3 cues in this request may have a non-empty p array");
    expect(prompt).toContain("one to four English words");
    expect(prompt).toContain("25 to 90 Chinese characters");
    expect(prompt).toContain("This is a hard ceiling, not a quota");
    expect(prompt).toContain("usually select 12 to 20 cues");
  });

  it("preserves translation-style guidance", () => {
    expect(buildSystemPrompt("formal")).toContain("FORMAL WRITTEN CHINESE");
    expect(buildSystemPrompt("colloquial")).toContain("NATURAL CHINESE CONVERSATION");
  });
});
