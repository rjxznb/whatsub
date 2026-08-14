import { describe, expect, it } from "vitest";
import { countPhraseTokens, isAllowedLearningPhrase } from "./phraseRules";

describe("learning phrase rules", () => {
  it("counts contractions and hyphenated terms as one token", () => {
    expect(countPhraseTokens("wouldn't have a state-of-the-art solver")).toBe(5);
  });

  it("accepts an eight-token fixed expression and rejects nine tokens", () => {
    expect(isAllowedLearningPhrase("one two three four five six seven eight")).toBe(true);
    expect(isAllowedLearningPhrase("one two three four five six seven eight nine")).toBe(false);
  });

  it("rejects a long complete cue but permits a short complete expression", () => {
    expect(isAllowedLearningPhrase(
      "would you mind if I opened the window",
      "Would you mind if I opened the window?",
    )).toBe(false);
    expect(isAllowedLearningPhrase("give it a shot", "Give it a shot!")).toBe(true);
  });
});
