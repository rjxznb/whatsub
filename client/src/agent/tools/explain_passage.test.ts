import { describe, it, expect, vi, beforeEach } from "vitest";

const streamMock = vi.fn();
vi.mock("../../llm/providers", () => ({
  getProvider: () => ({ stream: (...a: unknown[]) => streamMock(...a) }),
}));

import { explainPassageTool } from "./explain_passage";
import { useAnalysis } from "../../store/analysis";
import { useSettings } from "../../store/settings";
import type { Subtitle } from "../../llm/types";
import { DEFAULT_SETTINGS } from "../../types/settings";

const ctx = { signal: new AbortController().signal };

function sub(time: number, text = "x"): Subtitle {
  return {
    time,
    endTime: time + 2,
    text,
    translation: "",
    isKeyPoint: false,
    highlightWords: [],
    keyNotes: {},
    highlightTranslations: {},
  };
}

async function* mkChunks(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

beforeEach(() => {
  streamMock.mockReset();
  useAnalysis.setState({ subtitles: [] });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
});

describe("explain_passage tool", () => {
  it("riskTier is LOW", () => {
    expect(explainPassageTool.riskTier).toBe("LOW");
  });

  it("availableOn is true on /player/* and false elsewhere", () => {
    expect(explainPassageTool.availableOn({ pathname: "/player/abc" })).toBe(true);
    expect(explainPassageTool.availableOn({ pathname: "/library" })).toBe(false);
    expect(explainPassageTool.availableOn({ pathname: "/corpus" })).toBe(false);
  });

  it("happy path: streams provider chunks and concatenates explanation", async () => {
    useAnalysis.setState({
      subtitles: [sub(0, "Hello."), sub(2, "How are you?"), sub(4, "Fine, thanks.")],
    });
    streamMock.mockReturnValueOnce(mkChunks(["解释：", "这段对话是问候。"]));
    const r = await explainPassageTool.execute(
      { videoId: "v1", cueIdxStart: 0, cueIdxEnd: 1 },
      ctx,
    );
    expect(r.explanation).toBe("解释：这段对话是问候。");
    // The prompt should have been built from the slice (Hello + How are you?)
    const call = streamMock.mock.calls[0][0];
    expect(call.userPrompt).toContain("Hello.");
    expect(call.userPrompt).toContain("How are you?");
    expect(call.userPrompt).not.toContain("Fine, thanks.");
  });

  it("throws when cue range is out of bounds", async () => {
    useAnalysis.setState({ subtitles: [sub(0), sub(2)] });
    await expect(
      explainPassageTool.execute({ videoId: "v1", cueIdxStart: 0, cueIdxEnd: 5 }, ctx),
    ).rejects.toThrow("invalid");
    await expect(
      explainPassageTool.execute({ videoId: "v1", cueIdxStart: -1, cueIdxEnd: 0 }, ctx),
    ).rejects.toThrow("invalid");
    await expect(
      explainPassageTool.execute({ videoId: "v1", cueIdxStart: 1, cueIdxEnd: 0 }, ctx),
    ).rejects.toThrow("invalid");
  });

  it("doneLabel reflects the length of the explanation", () => {
    expect(explainPassageTool.doneLabel({ explanation: "abcde" })).toContain("(5 字)");
  });
});
