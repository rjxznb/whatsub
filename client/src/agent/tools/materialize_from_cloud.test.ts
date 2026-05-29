import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { materializeFromCloudTool } from "./materialize_from_cloud";

vi.mock("@tauri-apps/api/core");

const ctx = { signal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("materialize_from_cloud tool", () => {
  it("riskTier is MID", () => {
    expect(materializeFromCloudTool.riskTier).toBe("MID");
  });

  it("availableOn returns true on any page", () => {
    expect(materializeFromCloudTool.availableOn({ pathname: "/library" })).toBe(
      true
    );
    expect(materializeFromCloudTool.availableOn({ pathname: "/player/abc" })).toBe(
      true
    );
  });

  it("execute invokes library_materialize_from_cloud with correct id", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    const result = await materializeFromCloudTool.execute(
      { videoId: "video_123" },
      ctx
    );

    expect(mockInvoke).toHaveBeenCalledWith(
      "library_materialize_from_cloud",
      {
        id: "video_123",
      }
    );
    expect(result.materialized).toBe(true);
    expect(result.videoId).toBe("video_123");
  });

  it("returns materialized true and correct videoId", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    const result = await materializeFromCloudTool.execute(
      { videoId: "vid_xyz" },
      ctx
    );

    expect(result.materialized).toBe(true);
    expect(result.videoId).toBe("vid_xyz");
  });

  it("doneLabel returns correct message", () => {
    const label = materializeFromCloudTool.doneLabel({
      materialized: true,
      videoId: "vid_abc",
    });
    expect(label).toBe("已下载到本地");
  });
});
