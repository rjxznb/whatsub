import { describe, it, expect } from "vitest";
import {
  ERROR_PATTERNS,
  ERROR_PATTERN_LABELS,
  isErrorPattern,
  coerceErrorPattern,
} from "./errorPatterns";

describe("errorPatterns", () => {
  it("every pattern has a Chinese label", () => {
    for (const p of ERROR_PATTERNS) {
      expect(ERROR_PATTERN_LABELS[p]).toBeTruthy();
      expect(typeof ERROR_PATTERN_LABELS[p]).toBe("string");
    }
  });

  it("isErrorPattern accepts valid + rejects invalid", () => {
    expect(isErrorPattern("past_tense_irregular")).toBe(true);
    expect(isErrorPattern("other")).toBe(true);
    expect(isErrorPattern("made_up_pattern")).toBe(false);
    expect(isErrorPattern("")).toBe(false);
  });

  it("coerceErrorPattern returns 'other' for unknown values", () => {
    expect(coerceErrorPattern("past_tense_irregular")).toBe("past_tense_irregular");
    expect(coerceErrorPattern("madeup")).toBe("other");
    expect(coerceErrorPattern(undefined)).toBe("other");
    expect(coerceErrorPattern(null)).toBe("other");
  });

  it("no duplicate patterns", () => {
    const set = new Set(ERROR_PATTERNS);
    expect(set.size).toBe(ERROR_PATTERNS.length);
  });
});
