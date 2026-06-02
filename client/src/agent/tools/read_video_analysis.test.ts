import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { useLibrary } from "../../store/library";
import { readVideoAnalysisTool } from "./read_video_analysis";

const ctx = { signal: new AbortController().signal };

beforeEach(() => {
  invokeMock.mockReset();
  useLibrary.setState({
    library: { videos: [{ id: "v1", title: "NHS GP basics", durationSec: 543 }], folders: [], topLevelOrder: [] },
  } as never);
});

describe("read_video_analysis tool", () => {
  it("id + LOW risk", () => {
    expect(readVideoAnalysisTool.id).toBe("read_video_analysis");
    expect(readVideoAnalysisTool.riskTier).toBe("LOW");
  });

  it("returns transcript excerpt + key phrases + title", async () => {
    invokeMock.mockResolvedValue({
      subtitles: [
        { text: "Hello, I have an appointment.", time: 0, endTime: 2 },
        { text: "Sure, what's your name?", time: 2, endTime: 4 },
      ],
      keyPhrases: [{ expression: "have an appointment", meaningZh: "有预约", usage: "..." }],
    });
    const r = await readVideoAnalysisTool.execute({ videoId: "v1" }, ctx);
    expect(r.found).toBe(true);
    expect(r.title).toBe("NHS GP basics");
    expect(r.cueCount).toBe(2);
    expect(r.fullTextExcerpt).toContain("appointment");
    expect(r.keyPhrases?.[0]).toEqual({ expression: "have an appointment", meaningZh: "有预约" });
  });

  it("found:false when no analysis on disk", async () => {
    invokeMock.mockResolvedValue(null);
    const r = await readVideoAnalysisTool.execute({ videoId: "v1" }, ctx);
    expect(r.found).toBe(false);
    expect(r.title).toBe("NHS GP basics");
  });
});
