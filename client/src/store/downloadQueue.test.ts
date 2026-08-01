import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useDownloadQueue, applyPipelineEvent } from "./downloadQueue";

const mockInvoke = vi.mocked(invoke);

describe("applyPipelineEvent — Uploading", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useDownloadQueue.setState({ entries: {} });
  });

  it("ignores Uploading for an unknown video (no stray row)", () => {
    applyPipelineEvent({ stage: "Uploading", video_id: "vidX", percent: 42 });
    expect(useDownloadQueue.getState().entries["vidX"]).toBeUndefined();
  });

  it("updates an existing entry's percent", () => {
    useDownloadQueue.getState().upsert("vid1", {
      videoId: "vid1", sourceKind: "url", sourceValue: "u", label: "L",
      phase: "uploading", percent: 10, startedAt: 1,
    });
    applyPipelineEvent({ stage: "Uploading", video_id: "vid1", percent: 90 });
    expect(useDownloadQueue.getState().entries["vid1"].percent).toBe(90);
  });
});

describe("applyPipelineEvent — Waiting", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useDownloadQueue.setState({ entries: {} });
  });

  it("tracks both scheduler waits and lets running stages replace them", () => {
    applyPipelineEvent({
      stage: "Started",
      video_id: "v1",
      source_kind: "url",
      source_value: "https://youtube.com/watch?v=x",
      background: true,
    });

    applyPipelineEvent({ stage: "Waiting", video_id: "v1", resource: "download" });
    expect(useDownloadQueue.getState().entries.v1.phase).toBe("waiting_download");

    applyPipelineEvent({ stage: "Waiting", video_id: "v1", resource: "compute" });
    expect(useDownloadQueue.getState().entries.v1.phase).toBe("waiting_compute");

    applyPipelineEvent({ stage: "Transcribing", video_id: "v1", percent: 4 });
    expect(useDownloadQueue.getState().entries.v1.phase).toBe("transcribing");
  });
});

describe("download queue cancellation persistence", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useDownloadQueue.setState({ entries: {} });
  });

  it("keeps the row until backend cancellation and cleanup are confirmed", async () => {
    let finishCancel!: () => void;
    mockInvoke.mockImplementation(
      () => new Promise<void>((resolve) => {
        finishCancel = resolve;
      }),
    );
    useDownloadQueue.getState().upsert("v1", {
      videoId: "v1",
      sourceKind: "url",
      sourceValue: "https://youtube.com/watch?v=x",
      label: "Video",
      phase: "downloading",
      percent: 20,
      startedAt: 1,
    });

    const cancelling = useDownloadQueue.getState().cancel("v1");
    expect(useDownloadQueue.getState().entries.v1).toBeDefined();
    finishCancel();
    await cancelling;

    expect(mockInvoke).toHaveBeenCalledWith("cancel_import", { videoId: "v1" });
    expect(useDownloadQueue.getState().entries.v1).toBeUndefined();
  });

  it("keeps a failed cancellation visible instead of pretending it stopped", async () => {
    mockInvoke.mockRejectedValue(new Error("cleanup timeout"));
    useDownloadQueue.getState().upsert("v1", {
      videoId: "v1",
      sourceKind: "url",
      sourceValue: "u",
      label: "Video",
      phase: "downloading",
      percent: 20,
      startedAt: 1,
    });

    await useDownloadQueue.getState().cancel("v1");

    expect(useDownloadQueue.getState().entries.v1.phase).toBe("error");
    expect(useDownloadQueue.getState().entries.v1.error).toContain("cleanup timeout");
  });
});
