import { describe, expect, it } from "vitest";
import { validateSummaryOutput } from "./summaryOutput";

describe("validateSummaryOutput", () => {
  it("accepts compact tuples and deduplicates expressions case-insensitively", () => {
    expect(validateSummaryOutput({ p: [
      ["catch up", "补上", "用于赶上进度"],
      [" Catch Up ", "赶上", "重复项"],
    ] })).toEqual([
      { expression: "catch up", meaningZh: "补上", usage: "用于赶上进度" },
    ]);
  });

  it("drops overlong expressions without invalidating the summary", () => {
    expect(validateSummaryOutput({ p: [
      ["one two three four five six seven eight nine", "长句", "不应保留"],
      ["give it a shot", "试试看", "用于鼓励尝试"],
    ] })).toEqual([
      { expression: "give it a shot", meaningZh: "试试看", usage: "用于鼓励尝试" },
    ]);
  });

  it("continues to accept the verbose summary during migration", () => {
    expect(validateSummaryOutput({
      type: "summary",
      keyPhrases: [{ expression: "catch up", meaningZh: "补上", usage: "用于赶进度" }],
    })).toEqual([
      { expression: "catch up", meaningZh: "补上", usage: "用于赶进度" },
    ]);
  });

  it("treats a valid envelope with only rejected entries as an empty summary", () => {
    expect(validateSummaryOutput({
      p: [["one two three four five six seven eight nine", "长句", "不应保留"]],
    })).toEqual([]);
  });
});
