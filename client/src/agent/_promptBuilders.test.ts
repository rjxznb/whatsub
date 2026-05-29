import { describe, it, expect } from "vitest";
import {
  buildExplainPrompt,
  buildQuizPrompt,
  buildLiaisonPrompt,
  contextChars,
  RESPONSE_CHAR_ESTIMATE,
  type TutorContext,
} from "./_promptBuilders";
import type { SrtCue } from "../llm/types";

const sampleCues: SrtCue[] = [
  { index: 0, time: 0, endTime: 2, text: "Hello, world." },
  { index: 1, time: 2, endTime: 4, text: "How are you doing today?" },
];

const sampleCtx: TutorContext = { cues: sampleCues, analyzedSubtitles: [] };

describe("contextChars", () => {
  it("sums lengths of all cue texts", () => {
    expect(contextChars(sampleCtx)).toBe(
      "Hello, world.".length + "How are you doing today?".length,
    );
  });
  it("returns 0 on empty cues", () => {
    expect(contextChars({ cues: [], analyzedSubtitles: [] })).toBe(0);
  });
});

describe("RESPONSE_CHAR_ESTIMATE", () => {
  it("has entries for all 3 actions", () => {
    expect(RESPONSE_CHAR_ESTIMATE.explain).toBeGreaterThan(0);
    expect(RESPONSE_CHAR_ESTIMATE.quiz).toBeGreaterThan(0);
    expect(RESPONSE_CHAR_ESTIMATE.liaison).toBeGreaterThan(0);
  });
});

describe("buildExplainPrompt", () => {
  it("includes every cue text", () => {
    const p = buildExplainPrompt(sampleCtx);
    expect(p).toContain("Hello, world.");
    expect(p).toContain("How are you doing today?");
  });
  it("frames the audience as a Chinese-speaking learner", () => {
    expect(buildExplainPrompt(sampleCtx)).toContain("Chinese-speaking");
  });
});

describe("buildQuizPrompt", () => {
  it("requires JSON Lines output (no surrounding prose)", () => {
    const p = buildQuizPrompt(sampleCtx);
    expect(p).toContain("JSON Lines");
    expect(p).toContain("no surrounding prose");
  });
  it("asks for 5 total questions across 3 types", () => {
    const p = buildQuizPrompt(sampleCtx);
    expect(p).toContain("5");
    expect(p).toContain("vocab");
    expect(p).toContain("comprehension");
    expect(p).toContain("grammar");
  });
});

describe("buildLiaisonPrompt", () => {
  it("embeds the cueIdx in the expected output schema", () => {
    const p = buildLiaisonPrompt({ cues: [sampleCues[0]], analyzedSubtitles: [] }, 7);
    expect(p).toContain('"cueIdx": 7');
  });
  it("quotes the actual cue text for the model", () => {
    const p = buildLiaisonPrompt({ cues: [sampleCues[0]], analyzedSubtitles: [] }, 0);
    expect(p).toContain("Hello, world.");
  });
  it("allows empty-array output when no liaisons", () => {
    const p = buildLiaisonPrompt({ cues: [sampleCues[0]], analyzedSubtitles: [] }, 0);
    expect(p.toLowerCase()).toContain("empty array");
  });
});
