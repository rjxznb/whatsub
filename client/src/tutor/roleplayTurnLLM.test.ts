import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTurnFromStream } from "./roleplayTurnLLM";

function fixture(n: string): string {
  return readFileSync(join(__dirname, "__fixtures__", n), "utf8");
}

describe("parseTurnFromStream", () => {
  it("separates visible reply from observed errors (clean case)", async () => {
    const t = await parseTurnFromStream(fixture("roleplay_turn_clean.txt"));
    expect(t.visibleText.length).toBeGreaterThan(0);
    expect(t.observedErrors).toEqual([]);
    // The OBSERVATIONS block MUST be stripped from visibleText
    expect(t.visibleText).not.toMatch(/OBSERVATIONS/);
  });

  it("extracts 1+ errors when present (chinglish case)", async () => {
    const t = await parseTurnFromStream(fixture("roleplay_turn_with_errors.txt"));
    expect(t.observedErrors.length).toBeGreaterThanOrEqual(1);
    expect(t.observedErrors[0].pattern).toBeTruthy();
    expect(t.observedErrors[0].correction).toBeTruthy();
  });

  it("malformed OBSERVATIONS → visibleText still works + errors empty", async () => {
    const stream = `data: {"choices":[{"delta":{"content":"Hello.\\n<<<OBSERVATIONS>>>\\nnot json\\n<<<END>>>"}}]}\n\ndata: [DONE]\n`;
    const t = await parseTurnFromStream(stream);
    expect(t.visibleText.trim()).toBe("Hello.");
    expect(t.observedErrors).toEqual([]);
  });
});
