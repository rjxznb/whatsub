import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  AnalysisSaveConflictError,
  deleteVideoAndInvalidateAnalysis,
  deleteAnalysisForReset,
  invalidateAnalysisPersistence,
  saveAnalysis,
} from "./analysisPersistence";

const mockInvoke = vi.mocked(invoke);

const applied = (generation: string) => ({
  applied: true,
  status: "applied" as const,
  generation,
  revision: null,
});

const alreadyCurrent = (generation: string) => ({
  applied: true,
  status: "alreadyCurrent" as const,
  generation,
  revision: null,
});

const rejected = (generation: string | null, revision: number | null = null) => ({
  applied: false,
  status: "rejected" as const,
  generation,
  revision,
});

describe("analysis persistence compatibility", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("serializes initial saves and reuses the generation returned by the first save", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_analysis_state") {
        return { analysis: null, generation: null };
      }
      return applied("generation-1");
    });

    const first = saveAnalysis("serial-video", { marker: 1 });
    const second = saveAnalysis("serial-video", { marker: 2 });
    await Promise.all([first, second]);

    expect(mockInvoke.mock.calls).toEqual([
      ["load_analysis_state", { videoId: "serial-video" }],
      ["save_analysis", { videoId: "serial-video", analysis: { marker: 1 } }],
      [
        "save_analysis",
        {
          videoId: "serial-video",
          analysis: { marker: 2 },
          generation: "generation-1",
        },
      ],
    ]);
  });

  it("throws when Rust rejects a save outcome", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_analysis_state") {
        return { analysis: { marker: "disk" }, generation: "generation-1" };
      }
      return {
        applied: false,
        status: "rejected",
        generation: "generation-2",
        revision: 7,
      };
    });

    await expect(saveAnalysis("rejected-video", { marker: "incoming" })).rejects.toBeInstanceOf(
      AnalysisSaveConflictError,
    );
  });

  it("uses the delete tombstone generation only for an explicit reset save", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "delete_analysis") return applied("generation-1");
      if (command === "save_analysis") return applied("generation-2");
      throw new Error(`unexpected command: ${command}`);
    });

    await deleteAnalysisForReset("reset-video");
    await saveAnalysis("reset-video", { marker: "fresh" });

    expect(mockInvoke.mock.calls).toEqual([
      ["delete_analysis", { videoId: "reset-video" }],
      [
        "save_analysis",
        {
          videoId: "reset-video",
          analysis: { marker: "fresh" },
          expectedGeneration: "generation-1",
        },
      ],
    ]);
  });

  it("does not turn a tombstone loaded after restart into reset authority", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_analysis_state") {
        return { analysis: null, generation: "generation-1" };
      }
      return {
        applied: false,
        status: "rejected",
        generation: "generation-1",
        revision: null,
      };
    });

    await expect(saveAnalysis("tombstoned-video", { marker: "late" })).rejects.toBeInstanceOf(
      AnalysisSaveConflictError,
    );
    expect(mockInvoke.mock.calls).toEqual([
      ["load_analysis_state", { videoId: "tombstoned-video" }],
      [
        "save_analysis",
        {
          videoId: "tombstoned-video",
          analysis: { marker: "late" },
          generation: "generation-1",
        },
      ],
      ["load_analysis_state", { videoId: "tombstoned-video" }],
    ]);
  });

  it("retries an interrupted active write with its normal generation", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_analysis_state") {
        return { analysis: null, generation: "generation-1" };
      }
      return applied("generation-1");
    });

    await saveAnalysis("interrupted-video", { marker: "transaction-target" });

    expect(mockInvoke.mock.calls).toEqual([
      ["load_analysis_state", { videoId: "interrupted-video" }],
      [
        "save_analysis",
        {
          videoId: "interrupted-video",
          analysis: { marker: "transaction-target" },
          generation: "generation-1",
        },
      ],
    ]);
  });

  it("invalidates a cached generation when a whole-video delete is reimported", async () => {
    const videoId = "whole-video-reimport";
    let backendGeneration: string | null = "generation-3";
    let backendAnalysis: unknown | null = { marker: "old-disk" };

    mockInvoke.mockImplementation(async (command, args) => {
      if (command === "load_analysis_state") {
        return { analysis: backendAnalysis, generation: backendGeneration };
      }
      if (command === "library_delete") {
        backendGeneration = null;
        backendAnalysis = null;
        return undefined;
      }
      if (command === "save_analysis") {
        const request = args as Record<string, unknown>;
        if (backendGeneration === null) {
          if (request.generation || request.expectedGeneration) return rejected(null);
          backendGeneration = "generation-1";
          backendAnalysis = request.analysis;
          return applied(backendGeneration);
        }
        if (request.generation !== backendGeneration) {
          return rejected(backendGeneration);
        }
        backendAnalysis = request.analysis;
        return applied(backendGeneration);
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await saveAnalysis(videoId, { marker: "old-update" });
    await deleteVideoAndInvalidateAnalysis(videoId);
    await saveAnalysis(videoId, { marker: "fresh-first" });
    await saveAnalysis(videoId, { marker: "fresh-second" });

    expect(mockInvoke.mock.calls).toEqual([
      ["load_analysis_state", { videoId }],
      [
        "save_analysis",
        { videoId, analysis: { marker: "old-update" }, generation: "generation-3" },
      ],
      ["library_delete", { id: videoId }],
      ["load_analysis_state", { videoId }],
      ["save_analysis", { videoId, analysis: { marker: "fresh-first" } }],
      [
        "save_analysis",
        { videoId, analysis: { marker: "fresh-second" }, generation: "generation-1" },
      ],
    ]);
  });

  it("reloads and retries once when fresh disk analysis proves an idempotent save", async () => {
    const videoId = "safe-generation-refresh";
    const incoming = {
      checkpoint: { revision: 4, transcriptFingerprint: "sha256:fresh" },
      marker: "fresh-current",
    };
    const loadedEquivalent = {
      marker: "fresh-current",
      checkpoint: { transcriptFingerprint: "sha256:fresh", revision: 4 },
    };
    mockInvoke
      .mockResolvedValueOnce({ analysis: { marker: "old" }, generation: "generation-2" })
      .mockResolvedValueOnce(applied("generation-2"))
      .mockResolvedValueOnce(rejected("generation-1", 4))
      .mockResolvedValueOnce({ analysis: loadedEquivalent, generation: "generation-1" })
      .mockResolvedValueOnce(alreadyCurrent("generation-1"))
      .mockResolvedValueOnce(applied("generation-1"));

    await saveAnalysis(videoId, { marker: "warm-cache" });
    const refreshed = await saveAnalysis(videoId, incoming);
    await saveAnalysis(videoId, { marker: "later-save" });

    expect(refreshed.status).toBe("alreadyCurrent");
    expect(mockInvoke.mock.calls).toEqual([
      ["load_analysis_state", { videoId }],
      [
        "save_analysis",
        { videoId, analysis: { marker: "warm-cache" }, generation: "generation-2" },
      ],
      ["save_analysis", { videoId, analysis: incoming, generation: "generation-2" }],
      ["load_analysis_state", { videoId }],
      ["save_analysis", { videoId, analysis: incoming, generation: "generation-1" }],
      [
        "save_analysis",
        { videoId, analysis: { marker: "later-save" }, generation: "generation-1" },
      ],
    ]);
  });

  it("reloads but does not retry a true stale save against different disk content", async () => {
    const videoId = "true-stale-generation";
    mockInvoke
      .mockResolvedValueOnce({ analysis: { marker: "old" }, generation: "generation-2" })
      .mockResolvedValueOnce(rejected("generation-3", 7))
      .mockResolvedValueOnce({ analysis: { marker: "newer-disk" }, generation: "generation-3" });

    await expect(saveAnalysis(videoId, { marker: "stale-work" })).rejects.toBeInstanceOf(
      AnalysisSaveConflictError,
    );

    expect(mockInvoke.mock.calls).toEqual([
      ["load_analysis_state", { videoId }],
      [
        "save_analysis",
        { videoId, analysis: { marker: "stale-work" }, generation: "generation-2" },
      ],
      ["load_analysis_state", { videoId }],
    ]);
  });

  it("does not let work queued during deletion initialize the fresh lifecycle", async () => {
    const videoId = "queued-across-whole-delete";
    mockInvoke
      .mockResolvedValueOnce({ analysis: { marker: "old" }, generation: "generation-2" })
      .mockResolvedValueOnce(applied("generation-2"));
    await saveAnalysis(videoId, { marker: "warm-cache" });

    let markDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });
    let releaseDelete!: () => void;
    const deleteBlocked = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deleting = invalidateAnalysisPersistence(videoId, async () => {
      markDeleteStarted();
      await deleteBlocked;
    });
    await deleteStarted;
    const staleSave = saveAnalysis(videoId, { marker: "queued-old-work" });
    releaseDelete();
    await deleting;

    await expect(staleSave).rejects.toBeInstanceOf(AnalysisSaveConflictError);
    expect(mockInvoke.mock.calls).toEqual([
      ["load_analysis_state", { videoId }],
      [
        "save_analysis",
        { videoId, analysis: { marker: "warm-cache" }, generation: "generation-2" },
      ],
    ]);
  });
});
