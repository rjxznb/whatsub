import { describe, expect, it, vi } from "vitest";
import type { ImportQueueItem } from "../lib/api/importQueue";
import type { ReplacementPayload } from "../lib/api/librarySync";
import {
  processClaimedItem,
  type QueueProcessorDependencies,
} from "./importQueue";

const replacement: ImportQueueItem = {
  id: "queue-1",
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  mode: "replace",
  targetLibraryEntryId: "library-entry-42",
  status: "processing",
  error: null,
  createdAt: 1,
  updatedAt: 2,
};
const replacementAttemptToken = "attempt-11111111-2222-3333-4444-555555555555";

function dependencies() {
  const freshPayload: ReplacementPayload = {
    youtubeId: "dQw4w9WgXcQ",
    sourceUrl: replacement.url,
    title: "Fresh title",
    durationSec: 42,
    thumbUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
    transcriptSrt: "1\n00:00:00,000 --> 00:00:01,000\nFresh transcript",
    analysisJson: { subtitles: [{ en: "Fresh transcript", zh: "鏂伴矞瀛楀箷" }] },
    videoKey: "whatsub/replacement-staging/owner/queue/video-generation.mp4",
  };
  const deps: QueueProcessorDependencies = {
    getWhisperModel: vi.fn(() => "base"),
    importVideo: vi.fn(async () => ({ videoId: "dQw4w9WgXcQ" })),
    analyze: vi.fn(async () => undefined),
    syncImport: vi.fn(async () => undefined),
    stageReplacement: vi.fn(async () => freshPayload),
    completeReplacement: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => undefined),
  };
  return { deps, freshPayload };
}

describe("processClaimedItem", () => {
  it("stages and atomically completes a replacement without ordinary sync", async () => {
    const { deps, freshPayload } = dependencies();

    await processClaimedItem(replacement, replacementAttemptToken, deps);

    expect(deps.stageReplacement).toHaveBeenCalledWith(
      replacement.id,
      replacement.targetLibraryEntryId,
      replacementAttemptToken,
      "dQw4w9WgXcQ",
    );
    expect(deps.syncImport).not.toHaveBeenCalled();
    expect(deps.completeReplacement).toHaveBeenCalledWith(
      replacement.id,
      replacement.targetLibraryEntryId,
      replacementAttemptToken,
      freshPayload,
    );
    expect(deps.setStatus).not.toHaveBeenCalledWith(replacement.id, "done");
  });

  it("keeps legacy queue rows on the ordinary sync path", async () => {
    const { deps } = dependencies();
    const ordinary: ImportQueueItem = {
      ...replacement,
      id: "queue-import",
      mode: undefined,
      targetLibraryEntryId: undefined,
    };

    await processClaimedItem(ordinary, null, deps);

    expect(deps.syncImport).toHaveBeenCalledWith("dQw4w9WgXcQ", ordinary.url);
    expect(deps.stageReplacement).not.toHaveBeenCalled();
    expect(deps.completeReplacement).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(ordinary.id, "done");
  });

  it("fails a replacement when the imported YouTube id differs from its target", async () => {
    const { deps } = dependencies();
    vi.mocked(deps.importVideo).mockResolvedValue({ videoId: "abcdefghijk" });

    await processClaimedItem(replacement, replacementAttemptToken, deps);

    expect(deps.stageReplacement).not.toHaveBeenCalled();
    expect(deps.syncImport).not.toHaveBeenCalled();
    expect(deps.completeReplacement).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(
      replacement.id,
      "failed",
      "replacement_youtube_mismatch",
      replacementAttemptToken,
    );
  });

  it("fails without finalizing when required video staging throws", async () => {
    const { deps } = dependencies();
    vi.mocked(deps.stageReplacement).mockRejectedValue(new Error("video_upload_failed"));

    await processClaimedItem(replacement, replacementAttemptToken, deps);

    expect(deps.syncImport).not.toHaveBeenCalled();
    expect(deps.completeReplacement).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(
      replacement.id,
      "failed",
      expect.stringContaining("video_upload_failed"),
      replacementAttemptToken,
    );
  });

  it("fails before analysis when importVideo rejects", async () => {
    const { deps } = dependencies();
    vi.mocked(deps.importVideo).mockRejectedValue(new Error("download_failed"));

    await processClaimedItem(replacement, replacementAttemptToken, deps);

    expect(deps.analyze).not.toHaveBeenCalled();
    expect(deps.syncImport).not.toHaveBeenCalled();
    expect(deps.stageReplacement).not.toHaveBeenCalled();
    expect(deps.completeReplacement).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(
      replacement.id,
      "failed",
      "download_failed",
      replacementAttemptToken,
    );
    expect(deps.setStatus).not.toHaveBeenCalledWith(replacement.id, "done");
  });

  it("fails before staging when analysis rejects", async () => {
    const { deps } = dependencies();
    vi.mocked(deps.analyze).mockRejectedValue(new Error("analysis_failed"));

    await processClaimedItem(replacement, replacementAttemptToken, deps);

    expect(deps.syncImport).not.toHaveBeenCalled();
    expect(deps.stageReplacement).not.toHaveBeenCalled();
    expect(deps.completeReplacement).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(
      replacement.id,
      "failed",
      "analysis_failed",
      replacementAttemptToken,
    );
    expect(deps.setStatus).not.toHaveBeenCalledWith(replacement.id, "done");
  });

  it("fails without a done transition when atomic replacement completion rejects", async () => {
    const { deps } = dependencies();
    vi.mocked(deps.completeReplacement).mockRejectedValue(new Error("completion_failed"));

    await processClaimedItem(replacement, replacementAttemptToken, deps);

    expect(deps.syncImport).not.toHaveBeenCalled();
    expect(deps.completeReplacement).toHaveBeenCalledTimes(1);
    expect(deps.setStatus).toHaveBeenCalledWith(
      replacement.id,
      "failed",
      "completion_failed",
      replacementAttemptToken,
    );
    expect(deps.setStatus).not.toHaveBeenCalledWith(replacement.id, "done");
  });
});
