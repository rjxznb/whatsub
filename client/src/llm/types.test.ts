import { describe, it, expect } from "vitest";
import type { Subtitle, KeyPhrase, AnalysisResult } from "./types";

const _kp: KeyPhrase = { expression: "", meaningZh: "", usage: "" };
void _kp;

describe("types module", () => {
  it("Subtitle shape", () => {
    const s: Subtitle = {
      time: 0,
      endTime: 1.5,
      text: "Hi",
      translation: "嗨",
      isKeyPoint: false,
      highlightWords: [],
      keyNotes: {},
      highlightTranslations: {},
    };
    expect(s.text).toBe("Hi");
  });

  it("AnalysisResult shape", () => {
    const a: AnalysisResult = { subtitles: [], keyPhrases: [] };
    expect(a.subtitles).toEqual([]);
  });
});
