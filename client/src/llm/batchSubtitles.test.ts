import { describe, it, expect } from "vitest";
import { batchSubtitles } from "./batchSubtitles";
import type { SrtCue } from "./types";

function makeCues(n: number): SrtCue[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    time: i * 2,
    endTime: i * 2 + 1.8,
    text: `Cue ${i + 1}`,
  }));
}

describe("batchSubtitles", () => {
  it("returns single batch when under limit", () => {
    const batches = batchSubtitles(makeCues(30), 50);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(30);
  });

  it("splits into multiple batches at boundary", () => {
    const batches = batchSubtitles(makeCues(120), 50);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(50);
    expect(batches[1]).toHaveLength(50);
    expect(batches[2]).toHaveLength(20);
  });

  it("handles empty input", () => {
    expect(batchSubtitles([], 50)).toEqual([]);
  });
});
