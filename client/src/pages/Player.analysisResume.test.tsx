import { beforeEach, describe, expect, it } from "vitest";
import { useAnalysis } from "../store/analysis";
import type { CheckpointedAnalysis, Subtitle } from "../llm/types";

const subtitle = (index: number): Subtitle => ({
  time: index,
  endTime: index + 1,
  text: `Output ${index}`,
  translation: `译文 ${index}`,
  isKeyPoint: false,
  highlightWords: [],
  keyNotes: {},
  highlightTranslations: {},
});

describe("Player committed resume state", () => {
  beforeEach(() => {
    useAnalysis.getState().reset();
    useAnalysis.getState().startFor("video-1");
  });

  it("derives progress from the committed input offset, not output count", () => {
    const persisted: CheckpointedAnalysis = {
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

    useAnalysis.getState().setCommittedAnalysis(persisted, 100);

    expect(useAnalysis.getState().subtitles).toHaveLength(47);
    expect(useAnalysis.getState().checkpoint?.nextCueOffset).toBe(50);
    expect(useAnalysis.getState().progressPercent).toBe(50);
  });

  it("publishes the checkpoint and its visible analysis in one store update", () => {
    const persisted: CheckpointedAnalysis = {
      subtitles: [subtitle(1)],
      keyPhrases: [{ expression: "carry on", meaningZh: "继续", usage: "继续做某事" }],
      checkpoint: {
        version: 1,
        transcriptFingerprint: "sha256:fixture",
        nextCueOffset: 1,
        phase: "complete",
        revision: 2,
      },
    };

    useAnalysis.getState().setCommittedAnalysis(persisted, 1);
    const state = useAnalysis.getState();

    expect(state.checkpoint).toEqual(persisted.checkpoint);
    expect(state.subtitles).toEqual(persisted.subtitles);
    expect(state.summary?.keyPhrases).toEqual(persisted.keyPhrases);
    expect(state.retryMessage).toBeNull();
  });
});
