import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CaptionOverlay } from "./CaptionOverlay";
import { DEFAULT_CAPTION_STYLE, type CaptionStyle } from "../types/settings";
import type { Subtitle } from "../llm/types";

const cue = (overrides: Partial<Subtitle> = {}): Subtitle => ({
  time: 0,
  endTime: 1,
  text: "I need to catch up on emails",
  translation: "我需要追上邮件",
  isKeyPoint: false,
  highlightWords: ["catch up"],
  keyNotes: { "catch up": "动词短语" },
  highlightTranslations: { "catch up": "追上" },
  ...overrides,
});

const styleWith = (patch: Partial<CaptionStyle> = {}): CaptionStyle => ({
  ...DEFAULT_CAPTION_STYLE,
  ...patch,
});

describe("CaptionOverlay", () => {
  it("renders nothing when subtitle is null", () => {
    const { container } = render(
      <CaptionOverlay subtitle={null} style={styleWith()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("applies bg color + opacity as rgba()", () => {
    const { container } = render(
      <CaptionOverlay
        subtitle={cue()}
        style={styleWith({ bgColor: "#000000", bgOpacity: 0.7 })}
      />
    );
    const box = container.querySelector("[data-caption-box]") as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.style.backgroundColor).toMatch(/rgba\(0,\s*0,\s*0,\s*0\.7/);
  });

  it("applies font color + opacity to English line via inline style", () => {
    const { container } = render(
      <CaptionOverlay
        subtitle={cue()}
        style={styleWith({ fontColor: "#FFEB3B", fontOpacity: 0.8 })}
      />
    );
    const en = container.querySelector("[data-caption-en]") as HTMLElement;
    expect(en.style.color.toLowerCase()).toBe("#ffeb3b");
    expect(en.style.opacity).toBe("0.8");
  });

  it("scales font size by captionFontScale", () => {
    const { container } = render(
      <CaptionOverlay subtitle={cue()} style={styleWith({ fontScale: 1.5 })} />
    );
    const en = container.querySelector("[data-caption-en]") as HTMLElement;
    const zh = container.querySelector("[data-caption-zh]") as HTMLElement;
    expect(en.style.fontSize).toBe("1.875rem");
    expect(zh.style.fontSize).toBe("1.5rem");
  });

  it("renders highlight spans when enabled", () => {
    const { container } = render(
      <CaptionOverlay
        subtitle={cue()}
        style={styleWith({ highlightsEnabled: true })}
      />
    );
    const highlights = container.querySelectorAll(".bg-amber-300");
    expect(highlights.length).toBeGreaterThan(0);
  });

  it("strips highlight spans when disabled", () => {
    const { container } = render(
      <CaptionOverlay
        subtitle={cue()}
        style={styleWith({ highlightsEnabled: false })}
      />
    );
    expect(container.querySelectorAll(".bg-amber-300").length).toBe(0);
    expect(container.textContent).toContain("catch up");
    expect(container.textContent).toContain("追上");
  });
});
