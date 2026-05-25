import { describe, it, expect, beforeEach } from "vitest";
import { useDownloadQueue, applyPipelineEvent } from "./downloadQueue";

describe("applyPipelineEvent — Uploading", () => {
  beforeEach(() => {
    useDownloadQueue.setState({ entries: {} });
  });

  it("upserts an uploading entry with transcode percent", () => {
    applyPipelineEvent({ stage: "Uploading", video_id: "vid1", percent: 42 });
    const e = useDownloadQueue.getState().entries["vid1"];
    expect(e).toBeTruthy();
    expect(e.phase).toBe("uploading");
    expect(e.percent).toBe(42);
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
