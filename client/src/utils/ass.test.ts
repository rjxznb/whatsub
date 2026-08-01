import { describe, it, expect } from "vitest";
import { normalizeCaptionOffset, subtitlesToAss } from "./ass";
import type { Subtitle } from "../llm/types";

function cue(overrides: Partial<Subtitle> = {}): Subtitle {
  return {
    time: 0,
    endTime: 1,
    text: "hello world",
    translation: "你好 世界",
    isKeyPoint: false,
    highlightWords: [],
    keyNotes: {},
    highlightTranslations: {},
    ...overrides,
  };
}

describe("subtitlesToAss", () => {
  it("normalizes player pixel displacement against the current viewport", () => {
    expect(normalizeCaptionOffset(128, -72, 1280, 720)).toEqual({
      xRatio: 0.1,
      yRatio: -0.1,
    });
  });

  it.each([
    [10, 20, 0, 720],
    [10, 20, 1280, 0],
    [Number.NaN, 20, 1280, 720],
    [10, Number.POSITIVE_INFINITY, 1280, 720],
  ])(
    "falls back to zero displacement for invalid geometry",
    (x, y, width, height) => {
      expect(normalizeCaptionOffset(x, y, width, height)).toEqual({
        xRatio: 0,
        yRatio: 0,
      });
    },
  );

  it("emits a header with PlayRes and two styles", () => {
    const out = subtitlesToAss([cue()], {
      includeEnglish: true,
      includeChinese: true,
      highlightKeyPhrases: true,
    });
    expect(out).toContain("[Script Info]");
    expect(out).toContain("PlayResX: 1280");
    expect(out).toContain("PlayResY: 720");
    expect(out).toContain("Style: EN,Arial");
    expect(out).toContain("Style: ZH,Microsoft YaHei");
    expect(out).toContain("[Events]");
  });

  it("keeps default ASS events free of explicit position overrides", () => {
    const out = subtitlesToAss([cue()], {
      includeEnglish: true,
      includeChinese: true,
      highlightKeyPhrases: false,
      captionPosition: { xRatio: 0, yRatio: 0 },
    });
    expect(out).not.toContain("\\pos(");
  });

  it("scales one normalized displacement into both ASS language anchors", () => {
    const out = subtitlesToAss([cue()], {
      includeEnglish: true,
      includeChinese: true,
      highlightKeyPhrases: false,
      playResX: 1920,
      playResY: 1080,
      captionPosition: { xRatio: 0.1, yRatio: -0.2 },
    });
    expect(out).toContain(",EN,,0,0,0,,{\\pos(1152,774)}hello world");
    expect(out).toContain(",ZH,,0,0,0,,{\\pos(1152,822)}");
  });

  it("formats centiseconds in event times", () => {
    const out = subtitlesToAss([cue({ time: 65.42, endTime: 67.91 })], {
      includeEnglish: true,
      includeChinese: false,
      highlightKeyPhrases: false,
    });
    // 65.42s → 0:01:05.42 ; 67.91s → 0:01:07.91
    expect(out).toContain("Dialogue: 0,0:01:05.42,0:01:07.91,EN");
  });

  it("emits two Dialogue rows when both languages selected", () => {
    const out = subtitlesToAss([cue()], {
      includeEnglish: true,
      includeChinese: true,
      highlightKeyPhrases: false,
    });
    const rows = out.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(",EN,");
    expect(rows[1]).toContain(",ZH,");
  });

  it("wraps highlights in BGR yellow override tag", () => {
    const out = subtitlesToAss(
      [
        cue({
          text: "hello big world",
          highlightWords: ["big"],
        }),
      ],
      {
        includeEnglish: true,
        includeChinese: false,
        highlightKeyPhrases: true,
      },
    );
    expect(out).toContain("hello {\\c&H00FFFF&}big{\\r} world");
  });

  it("skips highlights when highlightKeyPhrases is false", () => {
    const out = subtitlesToAss(
      [
        cue({
          text: "hello big world",
          highlightWords: ["big"],
        }),
      ],
      {
        includeEnglish: true,
        includeChinese: false,
        highlightKeyPhrases: false,
      },
    );
    expect(out).not.toContain("\\c&H00FFFF&");
    expect(out).toContain("hello big world");
  });

  it("escapes ASS-special characters in user text", () => {
    const out = subtitlesToAss(
      [cue({ text: "a {b} \\c", translation: "" })],
      {
        includeEnglish: true,
        includeChinese: false,
        highlightKeyPhrases: false,
      },
    );
    expect(out).toContain("a \\{b\\} \\\\c");
  });

  it("turns newlines into ASS line-break sequence", () => {
    const out = subtitlesToAss([cue({ text: "line1\nline2", translation: "" })], {
      includeEnglish: true,
      includeChinese: false,
      highlightKeyPhrases: false,
    });
    expect(out).toContain("line1\\Nline2");
  });

  it("highlights Chinese spans using highlightTranslations map", () => {
    const out = subtitlesToAss(
      [
        cue({
          text: "I love it",
          translation: "我 非常 喜欢 它",
          highlightWords: ["love"],
          highlightTranslations: { love: "非常" },
        }),
      ],
      {
        includeEnglish: false,
        includeChinese: true,
        highlightKeyPhrases: true,
      },
    );
    expect(out).toContain("我 {\\c&H00FFFF&}非常{\\r} 喜欢 它");
  });

  it("omits a language entirely when its text is empty after stripping", () => {
    const out = subtitlesToAss([cue({ translation: "" })], {
      includeEnglish: true,
      includeChinese: true,
      highlightKeyPhrases: false,
    });
    const rows = out.split("\n").filter((l) => l.startsWith("Dialogue:"));
    // English row exists, Chinese row skipped (empty translation).
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(",EN,");
  });
});
