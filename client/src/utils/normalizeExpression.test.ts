import { describe, it, expect } from "vitest";
import { normalizeExpression } from "./normalizeExpression";

describe("normalizeExpression", () => {
  it("returns trimmed text unchanged when no edge punctuation", () => {
    expect(normalizeExpression("apparently")).toBe("apparently");
  });

  it("strips trailing comma", () => {
    expect(normalizeExpression("apparently,")).toBe("apparently");
  });

  it("strips leading and trailing punctuation", () => {
    expect(normalizeExpression('"apparently!"')).toBe("apparently");
  });

  it("preserves internal apostrophes and hyphens", () => {
    expect(normalizeExpression("can't help")).toBe("can't help");
    expect(normalizeExpression("state-of-the-art")).toBe("state-of-the-art");
  });

  it("trims whitespace", () => {
    expect(normalizeExpression("  catch up  ")).toBe("catch up");
  });

  it("returns empty for whitespace-only", () => {
    expect(normalizeExpression("   ")).toBe("");
  });

  it("returns empty for punctuation-only", () => {
    expect(normalizeExpression(".,!?")).toBe("");
  });

  it("collapses internal multiple spaces to single space", () => {
    expect(normalizeExpression("catch  up")).toBe("catch up");
  });
});
