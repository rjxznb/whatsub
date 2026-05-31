import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  stripForSpeech,
  splitByLang,
  ttsSupported,
  isTtsEnabled,
  setTtsEnabled,
  ttsSpeak,
} from "./tts";

describe("splitByLang", () => {
  it("keeps pure Chinese as one zh run", () => {
    expect(splitByLang("这是一句中文")).toEqual([
      { text: "这是一句中文", lang: "zh" },
    ]);
  });

  it("keeps pure English as one en run", () => {
    expect(splitByLang("hello world")).toEqual([
      { text: "hello world", lang: "en" },
    ]);
  });

  it("splits mixed text into zh/en runs by language", () => {
    const segs = splitByLang("这是 I'm here for X 的用法");
    expect(segs.map((s) => s.lang)).toEqual(["zh", "en", "zh"]);
    // the apostrophe in I'm stays inside the English run
    expect(segs[1].text).toContain("I'm here for X");
    expect(segs[0].text).toContain("这是");
    expect(segs[2].text).toContain("的用法");
  });

  it("attaches digits/punctuation to the surrounding run (no tiny fragments)", () => {
    const segs = splitByLang("第 3 个");
    expect(segs).toHaveLength(1);
    expect(segs[0].lang).toBe("zh");
  });
});

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
