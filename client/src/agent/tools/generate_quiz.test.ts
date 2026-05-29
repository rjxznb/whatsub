import { describe, it, expect, vi, beforeEach } from "vitest";

const streamMock = vi.fn();
vi.mock("../../llm/providers", () => ({
  getProvider: () => ({ stream: (...a: unknown[]) => streamMock(...a) }),
}));

import { generateQuizTool } from "./generate_quiz";
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

describe("generate_quiz tool", () => {
  it("riskTier is LOW", () => {
    expect(generateQuizTool.riskTier).toBe("LOW");
  });

  it("availableOn is true on /player/* and false elsewhere", () => {
    expect(generateQuizTool.availableOn({ pathname: "/player/abc" })).toBe(true);
    expect(generateQuizTool.availableOn({ pathname: "/library" })).toBe(false);
  });

  it("happy path: returns quizJsonl with streamed lines", async () => {
    useAnalysis.setState({
      subtitles: [sub(0, "Hello."), sub(2, "How are you?")],
    });
    const line1 = '{"q":"Q1","type":"vocab","options":["a","b","c","d"],"answer":0,"explain":"x"}';
    const line2 = '{"q":"Q2","type":"grammar","options":["a","b","c","d"],"answer":1,"explain":"y"}';
    streamMock.mockReturnValueOnce(mkChunks([line1 + "\n", line2 + "\n"]));
    const r = await generateQuizTool.execute(
      { videoId: "v1", cueIdxStart: 0, cueIdxEnd: 1 },
      ctx,
    );
    expect(r.quizJsonl).toBe(line1 + "\n" + line2 + "\n");
  });

  it("throws when cue range is out of bounds", async () => {
    useAnalysis.setState({ subtitles: [sub(0)] });
    await expect(
      generateQuizTool.execute({ videoId: "v1", cueIdxStart: 0, cueIdxEnd: 5 }, ctx),
    ).rejects.toThrow("invalid");
  });

  it("doneLabel counts non-empty lines in jsonl", () => {
    const jsonl = "{\"a\":1}\n{\"a\":2}\n\n{\"a\":3}\n";
    expect(generateQuizTool.doneLabel({ quizJsonl: jsonl })).toContain("3 道题");
    expect(generateQuizTool.doneLabel({ quizJsonl: "" })).toContain("0 道题");
  });
});
