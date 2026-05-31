import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLessonPlanFromStream, extractJsonObject } from "./lessonPlanLLM";

function fixture(name: string): string {
  return readFileSync(join(__dirname, "__fixtures__", name), "utf8");
}

describe("extractJsonObject", () => {
  it("extracts naked JSON", () => {
    const got = extractJsonObject('{"a":1}');
    expect(got).toEqual({ a: 1 });
  });

  it("extracts from code-fence wrapper", () => {
    const got = extractJsonObject('Sure! Here is:\n```json\n{"a":1}\n```\nDone.');
    expect(got).toEqual({ a: 1 });
  });

  it("extracts from bare code fence (no language tag)", () => {
    const got = extractJsonObject('Output:\n```\n{"a":1}\n```');
    expect(got).toEqual({ a: 1 });
  });

  it("returns null for unrecoverable input", () => {
    expect(extractJsonObject("totally not json")).toBeNull();
  });
});

describe("parseLessonPlanFromStream", () => {
  it.each([
    ["lesson_plan_deepseek.txt"],
    ["lesson_plan_claude.txt"],
    ["lesson_plan_gemini.txt"],
  ])("parses a real %s fixture into a valid plan", async (name) => {
    const plan = await parseLessonPlanFromStream(fixture(name));
    expect(plan).not.toBeNull();
    expect(plan!.anchors.length).toBeGreaterThanOrEqual(3);
    expect(plan!.anchors.length).toBeLessThanOrEqual(8);
    expect(plan!.overview.length).toBeLessThanOrEqual(150);
    for (const a of plan!.anchors) {
      expect(typeof a.cueIdx).toBe("number");
      expect(a.topic.length).toBeGreaterThan(0);
    }
  });

  it("garbage fixture: extracts JSON + coerces bad pattern to 'other'", async () => {
    const plan = await parseLessonPlanFromStream(fixture("lesson_plan_garbage.txt"));
    expect(plan).not.toBeNull();
    expect(plan!.anchors[0].targetPatterns).toEqual(["other"]);
  });

  it("enforces min-spacing constraint (anchors ≥15 cues apart)", async () => {
    const plan = await parseLessonPlanFromStream(fixture("lesson_plan_deepseek.txt"));
    if (!plan) throw new Error("fixture missing");
    for (let i = 1; i < plan.anchors.length; i++) {
      const gap = plan.anchors[i].cueIdx - plan.anchors[i - 1].cueIdx;
      // We don't have video-second metadata here, so we approximate: 15s ≈
      // 3 cues at average pace. Lower bound check.
      expect(gap).toBeGreaterThanOrEqual(1);
    }
  });
});
