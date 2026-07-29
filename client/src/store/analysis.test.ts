import { beforeEach, describe, expect, it } from "vitest";
import type { AnalysisPreview } from "../llm/analyze";
import type { CheckpointedAnalysis, Subtitle } from "../llm/types";
import { useAnalysis } from "./analysis";

const subtitle = (index: number): Subtitle => ({
  time: index,
  endTime: index + 1,
  text: `Output ${index}`,
  translation: `Translation ${index}`,
  isKeyPoint: false,
  highlightWords: [],
  keyNotes: {},
  highlightTranslations: {},
});

describe("durable analysis progress", () => {
  beforeEach(() => {
    useAnalysis.getState().reset();
  });

  it("counts durable inflight cue entries after the canonical checkpoint", () => {
    const committed: CheckpointedAnalysis = {
      subtitles: Array.from({ length: 47 }, (_, index) => subtitle(index)),
      keyPhrases: [],
      checkpoint: {
        version: 1,
        transcriptFingerprint: "sha256:fixture",
        nextCueOffset: 50,
        phase: "cues",
        revision: 7,
      },
    };
    const entries = Array.from({ length: 23 }, (_, index) => ({
      cueOffset: 50 + index,
      subtitle: subtitle(50 + index),
    }));
    const preview: AnalysisPreview = {
      startCueOffset: 50,
      endCueOffset: 100,
      entries,
      subtitles: entries.map((entry) => entry.subtitle),
    };

    useAnalysis.getState().setCommittedAnalysis(committed, 100);
    useAnalysis.getState().setAnalysisPreview(committed, preview, 100);

    const state = useAnalysis.getState();
    expect(state.committedCueOffset).toBe(50);
    expect(state.inflightCueCount).toBe(23);
    expect(state.inflightBatchSize).toBe(50);
    expect(state.progressPercent).toBe(73);
  });
});
