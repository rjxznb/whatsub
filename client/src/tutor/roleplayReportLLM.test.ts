import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseReportFromStream, fallbackReport } from "./roleplayReportLLM";
import type { ObservedError } from "./types";

function fixture(n: string): string {
  return readFileSync(join(__dirname, "__fixtures__", n), "utf8");
}

describe("parseReportFromStream", () => {
  it("parses well-formed fixture into ForensicReport", async () => {
    const r = await parseReportFromStream(fixture("roleplay_report_good.txt"));
    expect(r).not.toBeNull();
    expect(typeof r!.totalUserTurns).toBe("number");
    expect(r!.fallback).toBe(false);
  });

  it("returns null for malformed fixture", async () => {
    const r = await parseReportFromStream(fixture("roleplay_report_malformed.txt"));
    expect(r).toBeNull();
  });
});

describe("fallbackReport", () => {
  it("builds a minimal report from buffered observations", () => {
    const obs: ObservedError[] = [
      { pattern: "chinglish_directness", userText: "I very like", correction: "I really like", detail: "" },
      { pattern: "chinglish_directness", userText: "I very good", correction: "I'm doing well", detail: "" },
      { pattern: "article_missing", userText: "I'm student", correction: "I'm a student", detail: "" },
    ];
    const r = fallbackReport(5, obs);
    expect(r.totalUserTurns).toBe(5);
    expect(r.fallback).toBe(true);
    // Two patterns, one with count 2 and one with count 1
    expect(r.patternHits).toHaveLength(2);
    const ch = r.patternHits.find((p) => p.pattern === "chinglish_directness");
    expect(ch?.count).toBe(2);
  });
});
