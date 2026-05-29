import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { deleteVideoTool } from "./delete_video";

vi.mock("@tauri-apps/api/core");

const ctx = { signal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("delete_video tool", () => {
  it("riskTier is HIGH", () => {
    expect(deleteVideoTool.riskTier).toBe("HIGH");
  });

  it("availableOn returns true on any page", () => {
    expect(deleteVideoTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(deleteVideoTool.availableOn({ pathname: "/player/abc" })).toBe(true);
  });

  it("execute deletes local video only when alsoCloud is false", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    const result = await deleteVideoTool.execute(
      { videoId: "test-video-1", alsoCloud: false },
      ctx
    );

    expect(mockInvoke).toHaveBeenCalledWith("library_delete", { id: "test-video-1" });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "library_unsync_from_cloud",
      expect.anything()
    );
    expect(result.deletedLocal).toBe(true);
    expect(result.deletedCloud).toBe(false);
  });

  it("execute deletes both local and cloud when alsoCloud is true", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    const result = await deleteVideoTool.execute(
      { videoId: "test-video-2", alsoCloud: true },
      ctx
    );

    expect(mockInvoke).toHaveBeenCalledWith("library_unsync_from_cloud", {
      id: "test-video-2",
    });
    expect(mockInvoke).toHaveBeenCalledWith("library_delete", { id: "test-video-2" });
    expect(result.deletedLocal).toBe(true);
    expect(result.deletedCloud).toBe(true);
  });

  it("execute deletes local video even if cloud unsync fails", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockRejectedValueOnce(new Error("cloud error"));
    mockInvoke.mockResolvedValueOnce(undefined); // library_delete succeeds

    const result = await deleteVideoTool.execute(
      { videoId: "test-video-3", alsoCloud: true },
      ctx
    );

    expect(mockInvoke).toHaveBeenCalledWith("library_unsync_from_cloud", {
      id: "test-video-3",
    });
    expect(mockInvoke).toHaveBeenCalledWith("library_delete", { id: "test-video-3" });
    expect(result.deletedLocal).toBe(true);
    expect(result.deletedCloud).toBe(true);
  });

  it("execute defaults alsoCloud to false when omitted", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    const result = await deleteVideoTool.execute(
      { videoId: "test-video-4" },
      ctx
    );

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "library_unsync_from_cloud",
      expect.anything()
    );
    expect(mockInvoke).toHaveBeenCalledWith("library_delete", { id: "test-video-4" });
    expect(result.deletedLocal).toBe(true);
    expect(result.deletedCloud).toBe(false);
  });

  it("doneLabel reflects both deletions when deletedCloud is true", () => {
    const label = deleteVideoTool.doneLabel({ deletedLocal: true, deletedCloud: true });
    expect(label).toBe("已删除本地与云端视频");
  });

  it("doneLabel reflects local-only deletion when deletedCloud is false", () => {
    const label = deleteVideoTool.doneLabel({ deletedLocal: true, deletedCloud: false });
    expect(label).toBe("已删除本地视频");
  });
});
