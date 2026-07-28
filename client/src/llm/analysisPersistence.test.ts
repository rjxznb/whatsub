import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  AnalysisSaveConflictError,
  deleteAnalysisForReset,
  saveAnalysis,
} from "./analysisPersistence";

const mockInvoke = vi.mocked(invoke);

const applied = (generation: string) => ({
  applied: true,
  status: "applied" as const,
  generation,
  revision: null,
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
});
