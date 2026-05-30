import { describe, it, expect, vi } from "vitest";
import { youtubeSearchTool } from "./youtube_search";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([
    { id: "a", title: "T1", channel: "C1", durationSec: 600, url: "https://www.youtube.com/watch?v=a" },
    { id: "b", title: "T2", channel: "C2", durationSec: 1200, url: "https://www.youtube.com/watch?v=b" },
    { id: "c", title: "T3", channel: "C3", durationSec: 60, url: "https://www.youtube.com/watch?v=c" },
  ]),
}));

const ctx = { signal: new AbortController().signal };

describe("youtube_search tool", () => {
  it("returns all hits when no duration filter", async () => {
    const r = await youtubeSearchTool.execute({ query: "medical" }, ctx);
    expect(r.hits).toHaveLength(3);
    expect(r.query).toBe("medical");
  });

  it("filters by minDurationSec", async () => {
    const r = await youtubeSearchTool.execute({ query: "x", minDurationSec: 300 }, ctx);
    expect(r.hits.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("filters by maxDurationSec", async () => {
    const r = await youtubeSearchTool.execute({ query: "x", maxDurationSec: 700 }, ctx);
    expect(r.hits.map((h) => h.id)).toEqual(["a", "c"]);
  });

  it("riskTier is LOW", () => {
    expect(youtubeSearchTool.riskTier).toBe("LOW");
  });

  it("availableOn returns true everywhere", () => {
    expect(youtubeSearchTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(youtubeSearchTool.availableOn({ pathname: "/player/x" })).toBe(true);
  });
});
