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

describe("renderEnglishWithHighlights", () => {
  it("renders plain text when neither LLM highlight nor vocab match", () => {
    const { container } = render(
      <div>{renderEnglishWithHighlights(cue(), new Set())}</div>
    );
    expect(container.querySelectorAll("[data-highlight]")).toHaveLength(0);
    expect(container.textContent).toBe("I need to catch up on emails apparently");
  });

  it("wraps a vocab hit in a dashed-underline span", () => {
    const { container } = render(
      <div>{renderEnglishWithHighlights(cue(), new Set(["apparently"]))}</div>
    );
    const spans = container.querySelectorAll("[data-highlight=\"true\"]");
    expect(spans.length).toBe(1);
    expect(spans[0].textContent).toBe("apparently");
    expect(spans[0].className).toContain("border-dashed");
  });

  it("matches case-insensitively (vocab id is lowercased)", () => {
    const c = cue({ text: "Apparently it's late" });
    const { container } = render(
      <div>{renderEnglishWithHighlights(c, new Set(["apparently"]))}</div>
    );
    const spans = container.querySelectorAll("[data-highlight=\"true\"]");
    expect(spans.length).toBe(1);
    expect(spans[0].textContent).toBe("Apparently");
  });

  it("LLM yellow highlight takes precedence over vocab dashed underline for overlapping ranges", () => {
    const c = cue({
      text: "I catch up later",
      highlightWords: ["catch up"],
      keyNotes: { "catch up": "动词短语" },
      highlightTranslations: { "catch up": "追上" },
    });
    const { container } = render(
      <div>{renderEnglishWithHighlights(c, new Set(["catch up"]))}</div>
    );
    const all = container.querySelectorAll("[data-highlight=\"true\"]");
    expect(all.length).toBe(1);
    expect(all[0].className).not.toContain("border-dashed");
  });

  it("renders both LLM highlight and a separate vocab match in same cue", () => {
    const c = cue({
      text: "I catch up on emails apparently",
      highlightWords: ["catch up"],
      keyNotes: { "catch up": "动词短语" },
      highlightTranslations: { "catch up": "追上" },
    });
    const { container } = render(
      <div>{renderEnglishWithHighlights(c, new Set(["apparently"]))}</div>
    );
    const all = container.querySelectorAll("[data-highlight=\"true\"]");
    expect(all.length).toBe(2);
    const dashed = container.querySelectorAll(".border-dashed");
    expect(dashed.length).toBe(1);
    expect(dashed[0].textContent).toBe("apparently");
  });

  it("longest phrase wins when shorter phrase is a prefix (longest-first sort)", () => {
    const c = cue({ text: "I catch up later" });
    const { container } = render(
      <div>{renderEnglishWithHighlights(c, new Set(["catch", "catch up"]))}</div>
    );
    const spans = container.querySelectorAll("[data-highlight=\"true\"]");
    expect(spans.length).toBe(1);
    expect(spans[0].textContent).toBe("catch up");
  });
});
