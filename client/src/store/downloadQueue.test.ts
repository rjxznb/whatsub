import { describe, it, expect, beforeEach } from "vitest";
import { useDownloadQueue, applyPipelineEvent } from "./downloadQueue";

describe("applyPipelineEvent — Uploading", () => {
  beforeEach(() => {
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
