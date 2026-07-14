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
  getTtsVoiceZh,
  getTtsVoiceEn,
  setTtsVoiceZh,
  setTtsVoiceEn,
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

// The voice must never VERBALIZE a symbol that only exists for the eye. Neural
// TTS reads "/" as "slash", "*" as "asterisk", "→" as "right arrow" — which is
// exactly what the tutor's markdown-flavoured LLM output is full of.
describe("stripForSpeech — symbols the voice would otherwise read aloud", () => {
  it("never leaves a slash for the voice to read as 'slash'", () => {
    expect(stripForSpeech("动词/名词")).toBe("动词 名词");
    expect(stripForSpeech("and/or")).toBe("and or");
  });

  it("drops phonetic transcriptions (unpronounceable glyph soup)", () => {
    expect(stripForSpeech("pronounce /prəˈnaʊns/ 这样读")).toBe("pronounce 这样读");
    expect(stripForSpeech("word [ˈwɜːd] 重音在前")).toBe("word 重音在前");
  });

  it("turns arrows into a pause instead of 'right arrow'", () => {
    expect(stripForSpeech("buy → bought")).toBe("buy, bought");
  });

  it("keeps link text but never speaks the URL", () => {
    expect(stripForSpeech("见 [官网](https://a.com/x) 说明")).toBe("见 官网 说明");
    expect(stripForSpeech("打开 https://youtu.be/abc 看")).toBe("打开 看");
  });

  it("drops emoji (some voices read the emoji name)", () => {
    expect(stripForSpeech("答对了 🎉 继续")).toBe("答对了 继续");
  });

  it("drops list bullets and stray markdown symbols", () => {
    expect(stripForSpeech("- 第一点\n- 第二点")).toBe("第一点。 第二点");
    expect(stripForSpeech("大约 ~ 5 分钟 * 注意 _ 这里")).toBe("大约 5 分钟 注意 这里");
  });

  it("keeps prosody punctuation (that's how the voice breathes)", () => {
    expect(stripForSpeech("你好，世界。真的吗？")).toBe("你好，世界。真的吗？");
  });

  it("leaves no space stranded before punctuation after a strip", () => {
    expect(stripForSpeech("好的 */ 。")).toBe("好的。");
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

  it("voice combo defaults to 晓晓 + Aria and persists valid catalog ids", () => {
    expect(getTtsVoiceZh()).toBe(EDGE_VOICE_ZH);
    expect(getTtsVoiceEn()).toBe(EDGE_VOICE_EN);
    setTtsVoiceZh("zh-CN-YunxiNeural");
    setTtsVoiceEn("en-GB-SoniaNeural");
    expect(getTtsVoiceZh()).toBe("zh-CN-YunxiNeural");
    expect(getTtsVoiceEn()).toBe("en-GB-SoniaNeural");
  });

  it("rejects a wrong-language or unknown voice id (falls back to default)", () => {
    setTtsVoiceZh("en-GB-SoniaNeural"); // English id in the Chinese slot
    expect(getTtsVoiceZh()).toBe(EDGE_VOICE_ZH);
    setTtsVoiceEn("not-a-real-voice");
    expect(getTtsVoiceEn()).toBe(EDGE_VOICE_EN);
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
