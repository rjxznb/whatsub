import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  stripForSpeech,
  ttsSupported,
  isTtsEnabled,
  setTtsEnabled,
  ttsSpeak,
} from "./tts";

describe("stripForSpeech", () => {
  it("removes bold/italic/code markers but keeps the words", () => {
    expect(stripForSpeech("**studies**: 学业")).toBe("studies: 学业");
    expect(stripForSpeech("用 *really* 代替")).toBe("用 really 代替");
    expect(stripForSpeech("`code` here")).toBe("code here");
  });

  it("collapses whitespace and trims", () => {
    expect(stripForSpeech("  a\n\n  b  ")).toBe("a b");
  });

  it("strips code fences entirely", () => {
    expect(stripForSpeech("before ```js\nx\n``` after")).toBe("before after");
  });
});

describe("tts mute preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to enabled", () => {
    expect(isTtsEnabled()).toBe(true);
  });

  it("persists disabled state", () => {
    setTtsEnabled(false);
    expect(isTtsEnabled()).toBe(false);
    setTtsEnabled(true);
    expect(isTtsEnabled()).toBe(true);
  });
});

describe("ttsSpeak graceful degradation", () => {
  it("fires onEnd even when speechSynthesis is unavailable", async () => {
    // jsdom has no speechSynthesis → ttsSupported() is false.
    expect(ttsSupported()).toBe(false);
    const onEnd = vi.fn();
    await ttsSpeak("hello", { onEnd });
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("fires onEnd on empty text without throwing", async () => {
    const onEnd = vi.fn();
    await ttsSpeak("   ", { onEnd });
    expect(onEnd).toHaveBeenCalledOnce();
  });
});
