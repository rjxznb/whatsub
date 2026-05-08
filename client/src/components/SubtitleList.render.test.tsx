import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { renderEnglishWithHighlights } from "./SubtitleList";
import type { Subtitle } from "../llm/types";

const cue = (overrides: Partial<Subtitle> = {}): Subtitle => ({
  time: 0,
  endTime: 1,
  text: "I need to catch up on emails apparently",
  translation: "我得追一下邮件显然",
  isKeyPoint: false,
  highlightWords: [],
  keyNotes: {},
  highlightTranslations: {},
  ...overrides,
});

const empty = new Map<string, { meaningZh: string; usage: string }>();
const vocab = (
  ...phrases: string[]
): Map<string, { meaningZh: string; usage: string }> =>
  new Map(phrases.map((p) => [p, { meaningZh: "", usage: "" }]));

describe("renderEnglishWithHighlights", () => {
  it("renders plain text when neither LLM highlight nor vocab match", () => {
    const { container } = render(
      <div>{renderEnglishWithHighlights(cue(), empty)}</div>
    );
    expect(container.querySelectorAll("[data-highlight]")).toHaveLength(0);
    expect(container.textContent).toBe("I need to catch up on emails apparently");
  });

  it("wraps a vocab hit in a thin yellow underline span", () => {
    const { container } = render(
      <div>{renderEnglishWithHighlights(cue(), vocab("apparently"))}</div>
    );
    const spans = container.querySelectorAll("[data-highlight=\"true\"]");
    expect(spans.length).toBe(1);
    expect(spans[0].textContent).toBe("apparently");
    expect(spans[0].className).toContain("border-amber-400");
  });

  it("matches case-insensitively (vocab id is lowercased)", () => {
    const c = cue({ text: "Apparently it's late" });
    const { container } = render(
      <div>{renderEnglishWithHighlights(c, vocab("apparently"))}</div>
    );
    const spans = container.querySelectorAll("[data-highlight=\"true\"]");
    expect(spans.length).toBe(1);
    expect(spans[0].textContent).toBe("Apparently");
  });

  it("LLM yellow highlight takes precedence over vocab underline for overlapping ranges", () => {
    const c = cue({
      text: "I catch up later",
      highlightWords: ["catch up"],
      keyNotes: { "catch up": "动词短语" },
      highlightTranslations: { "catch up": "追上" },
    });
    const { container } = render(
      <div>{renderEnglishWithHighlights(c, vocab("catch up"))}</div>
    );
    const all = container.querySelectorAll("[data-highlight=\"true\"]");
    expect(all.length).toBe(1);
    // Yellow LLM HighlightWord uses bg-amber-300 + text-black; vocab uses
    // border-amber-400 — assert the LLM style won (no border-amber on the only span).
    expect(all[0].className).not.toContain("border-amber-400");
    expect(all[0].className).toContain("bg-amber-300");
  });

  it("renders both LLM highlight and a separate vocab match in same cue", () => {
    const c = cue({
      text: "I catch up on emails apparently",
      highlightWords: ["catch up"],
      keyNotes: { "catch up": "动词短语" },
      highlightTranslations: { "catch up": "追上" },
    });
    const { container } = render(
      <div>{renderEnglishWithHighlights(c, vocab("apparently"))}</div>
    );
    const all = container.querySelectorAll("[data-highlight=\"true\"]");
    expect(all.length).toBe(2);
    const vocabSpans = container.querySelectorAll(".border-amber-400\\/70");
    expect(vocabSpans.length).toBe(1);
    expect(vocabSpans[0].textContent).toBe("apparently");
  });

  it("longest phrase wins when shorter phrase is a prefix (longest-first sort)", () => {
    const c = cue({ text: "I catch up later" });
    const { container } = render(
      <div>{renderEnglishWithHighlights(c, vocab("catch", "catch up"))}</div>
    );
    const spans = container.querySelectorAll("[data-highlight=\"true\"]");
    expect(spans.length).toBe(1);
    expect(spans[0].textContent).toBe("catch up");
  });

  it("populates the hover tooltip from vocab map values", () => {
    const m = new Map<string, { meaningZh: string; usage: string }>([
      ["apparently", { meaningZh: "显然", usage: "口语里表达..." }],
    ]);
    const { container } = render(
      <div>{renderEnglishWithHighlights(cue(), m)}</div>
    );
    // Tooltip element is conditionally rendered on hover — but VocabHighlight
    // also sets title="已收藏" only when there's NO note. With a real meaning
    // the title attribute should be omitted.
    const span = container.querySelector("[data-highlight=\"true\"]");
    expect(span?.getAttribute("title")).toBeNull();
  });
});
