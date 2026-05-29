import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { syncToCloudTool } from "./sync_to_cloud";

vi.mock("@tauri-apps/api/core");

const ctx = { signal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sync_to_cloud tool", () => {
  it("riskTier is MID", () => {
    expect(syncToCloudTool.riskTier).toBe("MID");
  });

  it("availableOn returns true on any page", () => {
    expect(syncToCloudTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(syncToCloudTool.availableOn({ pathname: "/player/abc" })).toBe(
      true
    );
  });

  it("execute invokes library_sync_to_cloud with correct id", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue({
      ok: true,
      syncedAt: 1234567890,
      videoUploaded: true,
    });

    const result = await syncToCloudTool.execute(
      { videoId: "video_123" },
      ctx
    );

    expect(mockInvoke).toHaveBeenCalledWith("library_sync_to_cloud", {
      id: "video_123",
    });
    expect(result.synced).toBe(true);
    expect(result.videoUploaded).toBe(true);
  });

  it("returns videoUploaded true when invoke returns true", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue({
      ok: true,
      syncedAt: 1234567890,
      videoUploaded: true,
    });

    const result = await syncToCloudTool.execute(
      { videoId: "vid_abc" },
      ctx
    );

    expect(result.videoUploaded).toBe(true);
    expect(result.videoUrl).toBe("vid_abc");
  });

  it("returns videoUploaded false when invoke returns false", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue({
      ok: true,
      syncedAt: 1234567890,
      videoUploaded: false,
    });

    const result = await syncToCloudTool.execute(
      { videoId: "vid_xyz" },
      ctx
    );

    expect(result.videoUploaded).toBe(false);
    expect(result.videoUrl).toBeUndefined();
  });

  it("doneLabel shows video uploaded message when videoUploaded is true", () => {
    const label = syncToCloudTool.doneLabel({
      synced: true,
      videoUploaded: true,
    });
    expect(label).toContain("已同步视频到云端");
  });

  it("doneLabel shows captions-only message when videoUploaded is false", () => {
    const label = syncToCloudTool.doneLabel({
      synced: true,
      videoUploaded: false,
    });
    expect(label).toContain("已同步字幕到云端");
  });
});
