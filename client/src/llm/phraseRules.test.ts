import { describe, expect, it } from "vitest";
import {
  compactHighlightCapacity,
  countPhraseTokens,
  HighlightBudget,
  isAllowedLearningPhrase,
} from "./phraseRules";

describe("learning phrase rules", () => {
  it("counts contractions and hyphenated terms as one token", () => {
    expect(countPhraseTokens("wouldn't have a state-of-the-art solver")).toBe(5);
  });

  it("accepts four tokens and rejects five tokens", () => {
    expect(isAllowedLearningPhrase("one two three four", "one two three four five")).toBe(true);
    expect(isAllowedLearningPhrase("one two three four five", "one two three four five six")).toBe(false);
  });

  it("rejects a long complete cue but permits a short complete expression", () => {
    expect(isAllowedLearningPhrase(
      "would you mind if I opened the window",
      "Would you mind if I opened the window?",
    )).toBe(false);
    expect(isAllowedLearningPhrase("give it a shot", "Give it a shot!")).toBe(true);
  });

  it("calculates compact highlight capacity", () => {
    expect(compactHighlightCapacity(0)).toBe(0);
    expect(compactHighlightCapacity(1)).toBe(1);
    expect(compactHighlightCapacity(13)).toBe(6);
    expect(compactHighlightCapacity(50)).toBe(20);
  });

  it("tracks accepted highlighted cues only", () => {
    const budget = new HighlightBudget(10);
    for (let i = 0; i < 10; i++) expect(budget.accept()).toBe(true);
    expect(budget.accept()).toBe(false);
    expect(budget.remaining).toBe(0);
  });
});
