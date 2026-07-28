import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { saveAnalysis } from "../llm/analysisPersistence";
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

describe("download queue cancellation persistence", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useDownloadQueue.setState({ entries: {} });
  });

  it("invalidates cached analysis identity when cancel removes the whole import", async () => {
    const videoId = "cancelled-whole-import";
    let backendGeneration: string | null = "generation-2";
    let backendAnalysis: unknown | null = { marker: "old" };
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === "load_analysis_state") {
        return { analysis: backendAnalysis, generation: backendGeneration };
      }
      if (command === "cancel_import") {
        backendGeneration = null;
        backendAnalysis = null;
        return undefined;
      }
      if (command === "save_analysis") {
        const request = args as Record<string, unknown>;
        if (backendGeneration === null) {
          if (request.generation) {
            return {
              applied: false,
              status: "rejected",
              generation: null,
              revision: null,
            };
          }
          backendGeneration = "generation-1";
        } else if (request.generation !== backendGeneration) {
          return {
            applied: false,
            status: "rejected",
            generation: backendGeneration,
            revision: null,
          };
        }
        backendAnalysis = request.analysis;
        return {
          applied: true,
          status: "applied",
          generation: backendGeneration,
          revision: null,
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await saveAnalysis(videoId, { marker: "warm-cache" });
    await useDownloadQueue.getState().cancel(videoId);
    await saveAnalysis(videoId, { marker: "fresh-reimport" });

    expect(mockInvoke.mock.calls).toEqual([
      ["load_analysis_state", { videoId }],
      [
        "save_analysis",
        { videoId, analysis: { marker: "warm-cache" }, generation: "generation-2" },
      ],
      ["cancel_import", { videoId }],
      ["load_analysis_state", { videoId }],
      ["save_analysis", { videoId, analysis: { marker: "fresh-reimport" } }],
    ]);
  });
});
