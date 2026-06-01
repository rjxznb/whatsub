import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  stripForSpeech,
  splitByLang,
  pickEdgeVoice,
  ttsSupported,
  isTtsEnabled,
  setTtsEnabled,
  ttsSpeak,
  ttsSetRate,
  ttsPause,
  ttsResume,
  getTtsRate,
  TTS_RATE_MAX,
  TTS_RATE_MIN,
} from "./tts";
import { EDGE_VOICE_ZH, EDGE_VOICE_EN } from "./edgeTts";

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

describe("pickEdgeVoice", () => {
  it("uses the Chinese voice for zh-dominant text", () => {
    expect(pickEdgeVoice("我们来学这个短语 I am here")).toBe(EDGE_VOICE_ZH);
  });

  it("uses the English voice for en-dominant text", () => {
    expect(pickEdgeVoice("I am here for the conference 好")).toBe(EDGE_VOICE_EN);
  });

  it("breaks ties toward Chinese", () => {
    // 2 CJK (你好) vs 2 Latin (ok) — an exact tie goes to Chinese.
    expect(pickEdgeVoice("你好 ok")).toBe(EDGE_VOICE_ZH);
  });
});

describe("stripForSpeech", () => {
  it("removes bold/italic/code markers but keeps the words", () => {
    expect(stripForSpeech("**studies**: 学业")).toBe("studies: 学业");
    expect(stripForSpeech("用 *really* 代替")).toBe("用 really 代替");
    expect(stripForSpeech("`code` here")).toBe("code here");
  });

  it("collapses spaces/tabs within a line and trims", () => {
    expect(stripForSpeech("a   b\tc")).toBe("a b c");
  });

  it("turns paragraph breaks into a spoken pause via punctuation", () => {
    // 'a' gains a full stop so the voice breathes; 'b' (last) stays bare.
    expect(stripForSpeech("  a\n\n  b  ")).toBe("a。 b");
  });

  it("doesn't double up punctuation when a line already ends with it", () => {
    expect(stripForSpeech("第一段。\n第二段")).toBe("第一段。 第二段");
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

describe("tts rate + pause controls", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("ttsSetRate persists a clamped rate", () => {
    ttsSetRate(99); // above max
    expect(getTtsRate()).toBe(TTS_RATE_MAX);
    ttsSetRate(0.1); // below min
    expect(getTtsRate()).toBe(TTS_RATE_MIN);
    ttsSetRate(1.2);
    expect(getTtsRate()).toBeCloseTo(1.2);
  });

  it("ttsPause / ttsResume are safe no-ops when nothing is playing", () => {
    expect(() => {
      ttsPause();
      ttsResume();
    }).not.toThrow();
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
