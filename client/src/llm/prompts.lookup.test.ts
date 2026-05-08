import { describe, it, expect } from "vitest";
import { buildLookupPrompt } from "./prompts";

describe("buildLookupPrompt", () => {
  it("includes expression and cue text in the prompt", () => {
    const out = buildLookupPrompt("apparently", "She apparently left early.");
    expect(out).toContain("apparently");
    expect(out).toContain("She apparently left early.");
  });

  it("requests strict JSON object with two fields", () => {
    const out = buildLookupPrompt("catch up", "I need to catch up on emails");
    expect(out).toMatch(/JSON/);
    expect(out).toContain("meaningZh");
    expect(out).toContain("usage");
  });

  it("escapes nothing — passes raw cue text including quotes", () => {
    const out = buildLookupPrompt("uh", `He said "uh" a lot.`);
    expect(out).toContain(`He said "uh" a lot.`);
  });
});
