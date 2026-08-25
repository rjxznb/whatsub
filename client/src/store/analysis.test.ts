import { beforeEach, describe, expect, it } from "vitest";
import type { AnalysisPreview } from "../llm/analyze";
import type { CheckpointedAnalysis, SrtCue, Subtitle } from "../llm/types";
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

  it("keeps every English cue visible as translations arrive", () => {
    const cues: SrtCue[] = Array.from({ length: 3 }, (_, index) => ({
      index,
      time: index,
      endTime: index + 1,
      text: `English ${index}`,
    }));
    const committed: CheckpointedAnalysis = {
      subtitles: [{ ...subtitle(0), text: "English 0" }],
      keyPhrases: [],
      checkpoint: {
        version: 1,
        transcriptFingerprint: "sha256:fixture",
        nextCueOffset: 1,
        phase: "cues",
        revision: 2,
      },
    };

    useAnalysis.getState().setCommittedAnalysis(committed, cues.length, cues);

    const previewSubtitle = { ...subtitle(1), text: "English 1" };
    useAnalysis.getState().setAnalysisPreview(committed, {
      startCueOffset: 1,
      endCueOffset: 3,
      entries: [{ cueOffset: 1, subtitle: previewSubtitle }],
      subtitles: [previewSubtitle],
    }, cues.length, cues);

    expect(useAnalysis.getState().subtitles.map((cue) => ({
      text: cue.text,
      translation: cue.translation,
    }))).toEqual([
      { text: "English 0", translation: "Translation 0" },
      { text: "English 1", translation: "Translation 1" },
      { text: "English 2", translation: "" },
    ]);
  });

  it("clears a stale failure when analysis starts again", () => {
    useAnalysis.getState().setError(
      "error sending request for url (https://private.example/results)",
    );

    useAnalysis.getState().setPhase("analyzing");

    const state = useAnalysis.getState();
    expect(state.phase).toBe("analyzing");
    expect(state.errorMessage).toBeNull();
    expect(state.errorStage).toBeNull();
    expect(state.errorUpsell).toBe(false);
    expect(state.quotaError).toBeNull();
  });
});
