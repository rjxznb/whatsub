import { describe, it, expect, vi, beforeEach } from "vitest";

const streamMock = vi.fn();
vi.mock("../../llm/providers", () => ({
  getProvider: () => ({ stream: (...a: unknown[]) => streamMock(...a) }),
}));

import { markLiaisonsTool } from "./mark_liaisons";
import { useAnalysis } from "../../store/analysis";
import { useSettings } from "../../store/settings";
import type { Subtitle } from "../../llm/types";
import { DEFAULT_SETTINGS } from "../../types/settings";

const ctx = { signal: new AbortController().signal };

function sub(time: number, text = "What are you doing?"): Subtitle {
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

describe("mark_liaisons tool", () => {
  it("riskTier is LOW", () => {
    expect(markLiaisonsTool.riskTier).toBe("LOW");
  });

  it("availableOn is true on /player/* and false elsewhere", () => {
    expect(markLiaisonsTool.availableOn({ pathname: "/player/abc" })).toBe(true);
    expect(markLiaisonsTool.availableOn({ pathname: "/library" })).toBe(false);
  });

  it("happy path: parses valid JSON-array response into typed liaisons", async () => {
    useAnalysis.setState({ subtitles: [sub(0, "What are you doing?")] });
    const arr = JSON.stringify([
      {
        cueIdx: 0,
        wordStart: "What",
        wordEnd: "are",
        pronunciation: "/wʌɾər/",
        why: "/t/ 弱化为 flap",
      },
    ]);
    streamMock.mockReturnValueOnce(mkChunks([arr]));
    const r = await markLiaisonsTool.execute({ videoId: "v1", cueIdx: 0 }, ctx);
    expect(r.liaisons).toHaveLength(1);
    expect(r.liaisons[0].wordStart).toBe("What");
    expect(r.liaisons[0].cueIdx).toBe(0);
  });

  it("malformed JSON in stream returns empty array (graceful)", async () => {
    useAnalysis.setState({ subtitles: [sub(0)] });
    streamMock.mockReturnValueOnce(mkChunks(["this is not json"]));
    const r = await markLiaisonsTool.execute({ videoId: "v1", cueIdx: 0 }, ctx);
    expect(r.liaisons).toEqual([]);
  });

  it("non-array JSON (object) returns empty array", async () => {
    useAnalysis.setState({ subtitles: [sub(0)] });
    streamMock.mockReturnValueOnce(mkChunks(['{"oops":1}']));
    const r = await markLiaisonsTool.execute({ videoId: "v1", cueIdx: 0 }, ctx);
    expect(r.liaisons).toEqual([]);
  });

  it("filters out malformed entries while keeping good ones", async () => {
    useAnalysis.setState({ subtitles: [sub(0)] });
    const arr = JSON.stringify([
      { cueIdx: 0, wordStart: "a", wordEnd: "b", pronunciation: "/ab/", why: "ok" },
      { cueIdx: "wrong", wordStart: "x" }, // malformed
      "totally wrong",
    ]);
    streamMock.mockReturnValueOnce(mkChunks([arr]));
    const r = await markLiaisonsTool.execute({ videoId: "v1", cueIdx: 0 }, ctx);
    expect(r.liaisons).toHaveLength(1);
    expect(r.liaisons[0].wordStart).toBe("a");
  });

  it("throws for out-of-range cueIdx", async () => {
    useAnalysis.setState({ subtitles: [sub(0)] });
    await expect(
      markLiaisonsTool.execute({ videoId: "v1", cueIdx: 5 }, ctx),
    ).rejects.toThrow("out of range");
  });
});
