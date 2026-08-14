import { describe, expect, it } from "vitest";
import { validateCueOutput } from "./cueOutput";
import type { SrtCue } from "./types";

const source: SrtCue = {
  index: 54,
  time: 157.46,
  endTime: 162.5,
  text: "actual stack questions",
};

const requested = new Map([[source.index, source]]);

describe("validateCueOutput", () => {
  it("assembles source identity locally and keeps only valid highlights", () => {
    const result = validateCueOutput({
      index: 54,
      translation: "真实的堆栈问题",
      isKeyPoint: true,
      highlights: [
        {
          source: "stack questions",
          translation: "堆栈问题",
          note: "表示一组连续相关的问题",
        },
        {
          source: "not in source",
          translation: "堆栈问题",
          note: "invalid",
        },
      ],
      text: "model must not win",
      time: 999,
      endTime: 1_000,
    }, requested);

    expect(result).toEqual({
      status: "resolved",
      index: 54,
      needsAnnotationRepair: false,
      subtitle: {
        time: 157.46,
        endTime: 162.5,
        text: "actual stack questions",
        translation: "真实的堆栈问题",
        isKeyPoint: true,
        highlightWords: ["stack questions"],
        keyNotes: { "stack questions": "表示一组连续相关的问题" },
        highlightTranslations: { "stack questions": "堆栈问题" },
      },
    });
  });

  it("accepts compact tuples and derives isKeyPoint", () => {
    const result = validateCueOutput({
      i: 54,
      zh: "真实的堆栈问题",
      p: [["stack questions", "堆栈问题", "表示一组连续相关的问题"]],
    }, requested);

    expect(result).toMatchObject({
      status: "resolved",
      needsAnnotationRepair: false,
      subtitle: {
        translation: "真实的堆栈问题",
        isKeyPoint: true,
        highlightWords: ["stack questions"],
      },
    });
  });

  it("recovers the previous highlightWords maps safely", () => {
    const result = validateCueOutput({
      index: 54,
      translation: "真实的堆栈问题",
      isKeyPoint: true,
      highlightWords: ["stack questions"],
      keyNotes: { "stack questions": "表示一组连续相关的问题" },
      highlightTranslations: { "stack questions": "堆栈问题" },
    }, requested);

    expect(result).toMatchObject({
      status: "resolved",
      needsAnnotationRepair: false,
      subtitle: { highlightWords: ["stack questions"] },
    });
  });

  it("preserves translation and requests annotation repair for an overlong phrase", () => {
    const longSource = "actual stack questions one two three four five six";
    const longRequested = new Map([[54, { ...source, text: longSource }]]);
    const result = validateCueOutput({
      i: 54,
      zh: "这是一个完整长句",
      p: [[longSource, "完整长句", "模型错误地选中了整句"]],
    }, longRequested);

    expect(result).toMatchObject({
      status: "resolved",
      needsAnnotationRepair: true,
      subtitle: {
        translation: "这是一个完整长句",
        isKeyPoint: false,
        highlightWords: [],
      },
    });
  });

  it.each([
    ["unknown index", { index: 99, translation: "译文" }, null],
    ["missing index", { translation: "译文" }, null],
    ["empty translation", { index: 54, translation: "  " }, 54],
    ["non-string translation", { index: 54, translation: 123 }, 54],
  ])("leaves %s unresolved", (_name, output, index) => {
    expect(validateCueOutput(output, requested)).toMatchObject({
      status: "unresolved",
      index,
    });
  });

  it("drops malformed highlights without discarding a valid translation", () => {
    const result = validateCueOutput({
      index: 54,
      translation: "真实的堆栈问题",
      isKeyPoint: "false",
      highlights: [
        null,
        { source: "stack questions", translation: "不存在", note: "wrong target" },
        { source: "stack questions", translation: "堆栈问题", note: "" },
      ],
    }, requested);

    expect(result).toMatchObject({
      status: "resolved",
      subtitle: {
        translation: "真实的堆栈问题",
        isKeyPoint: false,
        highlightWords: [],
        keyNotes: {},
        highlightTranslations: {},
      },
    });
  });

  it("keeps the first valid entry when a highlight source is duplicated", () => {
    const result = validateCueOutput({
      index: 54,
      translation: "真实的堆栈问题",
      highlights: [
        { source: "stack questions", translation: "堆栈问题", note: "first" },
        { source: "stack questions", translation: "堆栈问题", note: "second" },
      ],
    }, requested);

    expect(result).toMatchObject({
      status: "resolved",
      subtitle: {
        highlightWords: ["stack questions"],
        keyNotes: { "stack questions": "first" },
      },
    });
  });
});
