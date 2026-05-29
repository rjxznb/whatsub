import { describe, it, expect, vi, beforeEach } from "vitest";

const streamMock = vi.fn();
vi.mock("../../llm/providers", () => ({
  getProvider: () => ({ stream: (...a: unknown[]) => streamMock(...a) }),
}));

import { translatePhraseTool } from "./translate_phrase";
import { useSettings } from "../../store/settings";
import { DEFAULT_SETTINGS } from "../../types/settings";

const ctx = { signal: new AbortController().signal };

async function* mkChunks(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

beforeEach(() => {
  streamMock.mockReset();
  useSettings.setState({ settings: DEFAULT_SETTINGS });
});

describe("translate_phrase tool", () => {
  it("riskTier is LOW", () => {
    expect(translatePhraseTool.riskTier).toBe("LOW");
  });

  it("availableOn returns true on every page", () => {
    expect(translatePhraseTool.availableOn({ pathname: "/player/abc" })).toBe(true);
    expect(translatePhraseTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(translatePhraseTool.availableOn({ pathname: "/corpus" })).toBe(true);
    expect(translatePhraseTool.availableOn({ pathname: "/settings" })).toBe(true);
  });

  it("happy path: default targetLang 'zh' uses English → Chinese prompt", async () => {
    streamMock.mockReturnValueOnce(mkChunks(["你好", "，世界"]));
    const r = await translatePhraseTool.execute({ text: "Hello, world" }, ctx);
    expect(r.translation).toBe("你好，世界");
    const call = streamMock.mock.calls[0][0];
    expect(call.userPrompt).toContain("English to Chinese");
    expect(call.userPrompt).toContain("Hello, world");
  });

  it("targetLang 'en' uses Chinese → English prompt", async () => {
    streamMock.mockReturnValueOnce(mkChunks(["Hello, world"]));
    const r = await translatePhraseTool.execute(
      { text: "你好，世界", targetLang: "en" },
      ctx,
    );
    expect(r.translation).toBe("Hello, world");
    const call = streamMock.mock.calls[0][0];
    expect(call.userPrompt).toContain("Chinese to English");
  });

  it("trims surrounding whitespace from the translation", async () => {
    streamMock.mockReturnValueOnce(mkChunks(["  hi there  \n"]));
    const r = await translatePhraseTool.execute({ text: "你好" }, ctx);
    expect(r.translation).toBe("hi there");
  });

  it("doneLabel reflects the trimmed translation length", () => {
    expect(translatePhraseTool.doneLabel({ translation: "你好世界" })).toContain("(4 字)");
  });
});
