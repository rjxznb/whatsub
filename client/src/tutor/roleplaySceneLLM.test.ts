import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseScenariosFromStream } from "./roleplaySceneLLM";

function fixture(name: string): string {
  return readFileSync(join(__dirname, "__fixtures__", name), "utf8");
}

describe("parseScenariosFromStream", () => {
  it("returns 1-3 scenarios from DeepSeek fixture", async () => {
    const scenarios = await parseScenariosFromStream(fixture("roleplay_scenes_deepseek.txt"), "v1");
    expect(scenarios.length).toBeGreaterThanOrEqual(1);
    expect(scenarios.length).toBeLessThanOrEqual(3);
    for (const s of scenarios) {
      expect(s.id.length).toBeGreaterThan(0);
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.userRole.length).toBeGreaterThan(0);
      expect(s.agentRole.length).toBeGreaterThan(0);
      expect([1, 2, 3]).toContain(s.difficulty);
    }
  });

  it("returns empty array on malformed input", async () => {
    const s = await parseScenariosFromStream("data: not json\n\ndata: [DONE]\n", "v1");
    expect(s).toEqual([]);
  });
});
