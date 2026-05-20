import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  DEFAULT_CAPTION_STYLE,
  captionStyleFromSettings,
  type Settings,
} from "./settings";

describe("caption style defaults", () => {
  it("DEFAULT_SETTINGS carries all 6 caption style defaults", () => {
    expect(DEFAULT_SETTINGS.captionFontColor).toBe("#FFFFFF");
    expect(DEFAULT_SETTINGS.captionFontScale).toBe(1);
    expect(DEFAULT_SETTINGS.captionFontOpacity).toBe(1);
    expect(DEFAULT_SETTINGS.captionBackgroundColor).toBe("#000000");
    expect(DEFAULT_SETTINGS.captionBackgroundOpacity).toBe(0.7);
    expect(DEFAULT_SETTINGS.captionHighlightsEnabled).toBe(true);
  });

  it("DEFAULT_CAPTION_STYLE matches DEFAULT_SETTINGS", () => {
    expect(DEFAULT_CAPTION_STYLE).toEqual({
      fontColor: "#FFFFFF",
      fontScale: 1,
      fontOpacity: 1,
      bgColor: "#000000",
      bgOpacity: 0.7,
      highlightsEnabled: true,
    });
  });
});

describe("captionStyleFromSettings", () => {
  it("returns defaults when fields are absent (legacy settings.json)", () => {
    const legacy: Settings = { ...DEFAULT_SETTINGS };
    delete legacy.captionFontColor;
    delete legacy.captionFontScale;
    delete legacy.captionFontOpacity;
    delete legacy.captionBackgroundColor;
    delete legacy.captionBackgroundOpacity;
    delete legacy.captionHighlightsEnabled;

    expect(captionStyleFromSettings(legacy)).toEqual(DEFAULT_CAPTION_STYLE);
  });

  it("projects user values when present", () => {
    const s: Settings = {
      ...DEFAULT_SETTINGS,
      captionFontColor: "#FFEB3B",
      captionFontScale: 1.5,
      captionFontOpacity: 0.8,
      captionBackgroundColor: "#2196F3",
      captionBackgroundOpacity: 0.5,
      captionHighlightsEnabled: false,
    };
    expect(captionStyleFromSettings(s)).toEqual({
      fontColor: "#FFEB3B",
      fontScale: 1.5,
      fontOpacity: 0.8,
      bgColor: "#2196F3",
      bgOpacity: 0.5,
      highlightsEnabled: false,
    });
  });
});
