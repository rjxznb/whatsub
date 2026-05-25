import { describe, it, expect, beforeEach } from "vitest";
import { useDownloadQueue } from "./downloadQueue";
import { applyUploadResult } from "./importQueue";

describe("applyUploadResult", () => {
  beforeEach(() => useDownloadQueue.setState({ entries: {} }));

  it("removes the row when videoUploaded is true", () => {
    useDownloadQueue.getState().upsert("v1", {
      videoId: "v1", sourceKind: "url", sourceValue: "u", label: "L",
      phase: "uploading", percent: 100, startedAt: 1,
    });
    applyUploadResult("v1", true);
    expect(useDownloadQueue.getState().entries["v1"]).toBeUndefined();
  });

  it("marks upload_failed when videoUploaded is false", () => {
    useDownloadQueue.getState().upsert("v1", {
      videoId: "v1", sourceKind: "url", sourceValue: "u", label: "L",
      phase: "uploading", percent: 100, startedAt: 1,
    });
    applyUploadResult("v1", false);
    expect(useDownloadQueue.getState().entries["v1"].phase).toBe("upload_failed");
  });
});
