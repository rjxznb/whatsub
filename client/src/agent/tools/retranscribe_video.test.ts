import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../../store/settings";
import { retranscribeVideoTool } from "./retranscribe_video";

vi.mock("@tauri-apps/api/core");
vi.mock("../../store/settings");

const ctx = { signal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useSettings).getState.mockReturnValue({
    settings: { whisperModel: "small" },
  } as never);
});

describe("retranscribe_video tool", () => {
  it("riskTier is HIGH", () => {
    expect(retranscribeVideoTool.riskTier).toBe("HIGH");
  });

  it("availableOn returns true on any page", () => {
    expect(retranscribeVideoTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(retranscribeVideoTool.availableOn({ pathname: "/player/abc" })).toBe(true);
  });

  it("execute returns started:true immediately without awaiting", async () => {
    const mockInvoke = vi.mocked(invoke);
    // Don't resolve immediately — we want to verify that execute() doesn't wait
    const invokeDeferredPromise = new Promise<void>(() => {});
    mockInvoke.mockReturnValue(invokeDeferredPromise as never);

    const resultPromise = retranscribeVideoTool.execute(
      { videoId: "test-video-1" },
      ctx
    );

    // Execute should return immediately even though the invoke is unresolved
    const result = await Promise.race([
      resultPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 100)),
    ]);

    expect(result).toEqual({
      started: true,
      watchAt: "/library",
      videoId: "test-video-1",
    });
  });

  it("execute fires invoke with whisperModel from settings", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    vi.mocked(useSettings).getState.mockReturnValue({
      settings: { whisperModel: "base" },
    } as never);

    await retranscribeVideoTool.execute({ videoId: "test-video-2" }, ctx);

    expect(mockInvoke).toHaveBeenCalledWith("retranscribe_video", {
      videoId: "test-video-2",
      whisperModel: "base",
      background: true,
    });
  });

  it("returns correct result shape", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    const result = await retranscribeVideoTool.execute(
      { videoId: "test-video-3" },
      ctx
    );

    expect(result.started).toBe(true);
    expect(result.watchAt).toBe("/library");
    expect(result.videoId).toBe("test-video-3");
  });

  it("doneLabel returns fire-and-watch message", () => {
    const label = retranscribeVideoTool.doneLabel({
      started: true,
      watchAt: "/library",
      videoId: "test",
    });
    expect(label).toBe("已启动重新解析（进度看 Library）");
  });

  it("catches and logs invoke errors without blocking", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockRejectedValue(new Error("invoke failed"));
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await retranscribeVideoTool.execute(
      { videoId: "test-video-4" },
      ctx
    );

    // Execute should still return started:true even if the invoke fails
    expect(result.started).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(
      "[retranscribe_video] background invoke error:",
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });
});
