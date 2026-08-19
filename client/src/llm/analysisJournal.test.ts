import { describe, expect, it } from "vitest";
import type { Subtitle } from "./types";
import {
  journalMatchesSession,
  journalSubtitles,
  mergeInflightEntries,
  parseAnalysisInflightJournal,
  type AnalysisInflightJournal,
} from "./analysisJournal";

function subtitle(text: string): Subtitle {
  return {
    time: 1,
    endTime: 2,
    text,
    translation: `译：${text}`,
    isKeyPoint: false,
    highlightWords: [],
    keyNotes: {},
    highlightTranslations: {},
  };
}

function validJournal(): AnalysisInflightJournal {
  return {
    version: 1,
    journalId: "journal-1",
    transcriptGeneration: "sha256:raw",
    transcriptFingerprint: "sha256:semantic",
    analysisStyle: "neutral",
    baseRevision: 2,
    startCueOffset: 50,
    endCueOffset: 100,
    entries: [{ cueOffset: 50, subtitle: subtitle("first") }],
  };
}

describe("analysis inflight journal", () => {
  it("parses valid entries and orders them by cue offset", () => {
    const parsed = parseAnalysisInflightJournal({
      ...validJournal(),
      entries: [
        { cueOffset: 51, subtitle: subtitle("second") },
        { cueOffset: 50, subtitle: subtitle("first") },
      ],
    });

    expect(parsed?.entries.map((entry) => entry.cueOffset)).toEqual([50, 51]);
    expect(journalSubtitles(parsed!).map((entry) => entry.text)).toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps identical subtitle payloads distinct when cue offsets differ", () => {
    const repeated = subtitle("same source cue");
    const parsed = parseAnalysisInflightJournal({
      ...validJournal(),
      entries: [
        { cueOffset: 50, subtitle: repeated },
        { cueOffset: 51, subtitle: repeated },
      ],
    });

    expect(parsed?.entries.map((entry) => entry.cueOffset)).toEqual([50, 51]);
    expect(journalSubtitles(parsed!)).toHaveLength(2);
  });

  it("rejects duplicate, out-of-range, malformed, and oversized entry sets", () => {
    const duplicate = {
      ...validJournal(),
      entries: [
        { cueOffset: 50, subtitle: subtitle("first") },
        { cueOffset: 50, subtitle: subtitle("duplicate") },
      ],
    };
    const outOfRange = {
      ...validJournal(),
      entries: [{ cueOffset: 100, subtitle: subtitle("outside") }],
    };
    const malformed = {
      ...validJournal(),
      entries: [{ cueOffset: 50, subtitle: { text: "missing fields" } }],
    };
    const oversized = {
      ...validJournal(),
      entries: Array.from({ length: 51 }, (_, index) => ({
        cueOffset: index,
        subtitle: subtitle(String(index)),
      })),
      startCueOffset: 0,
      endCueOffset: 51,
    };

    expect(parseAnalysisInflightJournal(duplicate)).toBeNull();
    expect(parseAnalysisInflightJournal(outOfRange)).toBeNull();
    expect(parseAnalysisInflightJournal(malformed)).toBeNull();
    expect(parseAnalysisInflightJournal(oversized)).toBeNull();
  });

  it("requires exact transcript, style, revision, offset, and cue-count identity", () => {
    const context = {
      transcriptGeneration: "sha256:raw",
      transcriptFingerprint: "sha256:semantic",
      analysisStyle: "neutral" as const,
      baseRevision: 2,
      nextCueOffset: 50,
      cueCount: 100,
    };

    expect(journalMatchesSession(validJournal(), context)).toBe(true);
    expect(journalMatchesSession(validJournal(), {
      ...context,
      transcriptGeneration: "sha256:other",
    })).toBe(false);
    expect(journalMatchesSession(validJournal(), {
      ...context,
      analysisStyle: "formal",
    })).toBe(false);
    expect(journalMatchesSession(validJournal(), {
      ...context,
      baseRevision: 3,
    })).toBe(false);
    expect(journalMatchesSession(validJournal(), {
      ...context,
      nextCueOffset: 49,
    })).toBe(false);
    expect(journalMatchesSession(validJournal(), {
      ...context,
      cueCount: 99,
    })).toBe(false);
  });

  it("merges monotonic additions, accepts identical retries, and rejects rewrites", () => {
    const journal = validJournal();
    const appended = mergeInflightEntries(journal, [
      { cueOffset: 51, subtitle: subtitle("second") },
    ]);
    const retried = mergeInflightEntries(appended, [
      { cueOffset: 50, subtitle: subtitle("first") },
    ]);

    expect(appended.entries.map((entry) => entry.cueOffset)).toEqual([50, 51]);
    expect(retried).toEqual(appended);
    expect(() => mergeInflightEntries(appended, [
      { cueOffset: 50, subtitle: subtitle("changed") },
    ])).toThrow("analysis inflight entry rewrite rejected");
  });

  it("permits one annotation-repair completion without permitting content rewrites", () => {
    const pending = {
      ...validJournal(),
      entries: [{
        cueOffset: 50,
        subtitle: subtitle("first"),
        annotationRepair: true as const,
      }],
    };
    const repairedSubtitle: Subtitle = {
      ...subtitle("first"),
      isKeyPoint: true,
      highlightWords: ["first"],
      keyNotes: { first: "用于测试重点标注修复" },
      highlightTranslations: { first: "译" },
    };

    const repaired = mergeInflightEntries(pending, [{
      cueOffset: 50,
      subtitle: repairedSubtitle,
    }]);

    expect(repaired.entries).toEqual([{ cueOffset: 50, subtitle: repairedSubtitle }]);
    expect(() => mergeInflightEntries(repaired, [{
      cueOffset: 50,
      subtitle: { ...repairedSubtitle, translation: "被改写的翻译" },
    }])).toThrow("analysis inflight entry rewrite rejected");
  });

  it("permits a fill pass to add annotations to an already previewed cue", () => {
    const pending = validJournal();
    const filled: Subtitle = {
      ...subtitle("first"),
      isKeyPoint: true,
      highlightWords: ["first"],
      keyNotes: { first: "用于测试重点标注补充" },
      highlightTranslations: { first: "译" },
    };
    expect(mergeInflightEntries(pending, [{ cueOffset: 50, subtitle: filled }]).entries)
      .toEqual([{ cueOffset: 50, subtitle: filled }]);
  });
});
