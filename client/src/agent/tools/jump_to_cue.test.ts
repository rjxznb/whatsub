import { describe, it, expect, vi, beforeEach } from "vitest";
import { jumpToCueTool } from "./jump_to_cue";
import { usePlayerState } from "../../store/playerState";
import { useAnalysis } from "../../store/analysis";
import type { Subtitle } from "../../llm/types";

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

beforeEach(() => {
  usePlayerState.getState().clear();
  useAnalysis.setState({ subtitles: [] });
});

describe("jump_to_cue tool", () => {
  it("riskTier is LOW", () => {
    expect(jumpToCueTool.riskTier).toBe("LOW");
  });

  it("availableOn is true on /player/* and false elsewhere", () => {
    expect(jumpToCueTool.availableOn({ pathname: "/player/abc" })).toBe(true);
    expect(jumpToCueTool.availableOn({ pathname: "/library" })).toBe(false);
  });

  it("happy path: looks up cue time and calls seekHandler", async () => {
    const handler = vi.fn();
    usePlayerState.getState().setSeekHandler(handler);
    useAnalysis.setState({ subtitles: [sub(0), sub(5.5), sub(10)] });
    const r = await jumpToCueTool.execute({ cueIdx: 1 }, ctx);
    expect(handler).toHaveBeenCalledWith(5.5);
    expect(r).toEqual({ ok: true, cueIdx: 1, sec: 5.5 });
  });

  it("throws 'not on player page' when seekHandler is null", async () => {
    useAnalysis.setState({ subtitles: [sub(0)] });
    await expect(jumpToCueTool.execute({ cueIdx: 0 }, ctx)).rejects.toThrow(
      "not on player page",
    );
  });

  it("throws out-of-range for cueIdx beyond subtitles length", async () => {
    usePlayerState.getState().setSeekHandler(vi.fn());
    useAnalysis.setState({ subtitles: [sub(0), sub(5)] });
    await expect(jumpToCueTool.execute({ cueIdx: 5 }, ctx)).rejects.toThrow(
      "out of range",
    );
    await expect(jumpToCueTool.execute({ cueIdx: -1 }, ctx)).rejects.toThrow(
      "out of range",
    );
  });
});
