import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { unsyncFromCloudTool } from "./unsync_from_cloud";

vi.mock("@tauri-apps/api/core");

const ctx = { signal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("unsync_from_cloud tool", () => {
  it("riskTier is HIGH", () => {
    expect(unsyncFromCloudTool.riskTier).toBe("HIGH");
  });

  it("availableOn returns true on any page", () => {
    expect(unsyncFromCloudTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(unsyncFromCloudTool.availableOn({ pathname: "/player/abc" })).toBe(true);
  });

  it("execute invokes library_unsync_from_cloud", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    const result = await unsyncFromCloudTool.execute(
      { videoId: "test-video-1" },
      ctx
    );

    expect(mockInvoke).toHaveBeenCalledWith("library_unsync_from_cloud", {
      id: "test-video-1",
    });
    expect(result.unsynced).toBe(true);
    expect(result.videoId).toBe("test-video-1");
  });

  it("returns unsynced:true and the videoId", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    const result = await unsyncFromCloudTool.execute(
      { videoId: "test-video-2" },
      ctx
    );

    expect(result).toEqual({ unsynced: true, videoId: "test-video-2" });
  });

  it("doneLabel returns appropriate message", () => {
    const label = unsyncFromCloudTool.doneLabel({ unsynced: true, videoId: "test" });
    expect(label).toBe("已从云端下架");
  });
});
