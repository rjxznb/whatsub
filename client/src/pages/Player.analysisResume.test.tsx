import { beforeEach, describe, expect, it } from "vitest";
import { useAnalysis } from "../store/analysis";
import type { PersistedAnalysisSession } from "../llm/analysisSession";
import type { CheckpointedAnalysis, Subtitle } from "../llm/types";
import type { AnalysisPreview } from "../llm/analyze";
import {
  canEditSubtitles,
  ownsForegroundAnalysis,
  ownsForegroundOperation,
  rollbackForegroundPreview,
} from "./Player";

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

  it("shows preview cues without advancing the committed checkpoint", () => {
    const committed: CheckpointedAnalysis = {
      subtitles: [subtitle(1)],
      keyPhrases: [],
      checkpoint: {
        version: 1,
        transcriptFingerprint: "sha256:fixture",
        nextCueOffset: 50,
        phase: "cues",
        revision: 7,
      },
    };
    const preview: AnalysisPreview = {
      startCueOffset: 50,
      endCueOffset: 100,
      entries: [{ cueOffset: 50, subtitle: subtitle(51) }],
      subtitles: [subtitle(51)],
    };

    useAnalysis.getState().setAnalysisPreview(committed, preview, 100);
    const state = useAnalysis.getState();

    expect(state.subtitles).toEqual([subtitle(1), subtitle(51)]);
    expect(state.checkpoint?.nextCueOffset).toBe(50);
    expect(state.progressPercent).toBe(50);
  });

  it("rolls preview back to the durable snapshot", () => {
    const committed: CheckpointedAnalysis = {
      subtitles: [subtitle(1)],
      keyPhrases: [],
      checkpoint: {
        version: 1,
        transcriptFingerprint: "sha256:fixture",
        nextCueOffset: 50,
        phase: "cues",
        revision: 7,
      },
    };
    const preview: AnalysisPreview = {
      startCueOffset: 50,
      endCueOffset: 100,
      entries: [{ cueOffset: 50, subtitle: subtitle(51) }],
      subtitles: [subtitle(51)],
    };

    useAnalysis.getState().setAnalysisPreview(committed, preview, 100);
    useAnalysis.getState().setAnalysisPreview(committed, null, 100);

    expect(useAnalysis.getState().subtitles).toEqual(committed.subtitles);
    expect(useAnalysis.getState().checkpoint).toEqual(committed.checkpoint);
  });

  it("rolls an uncommitted preview back when the owning Player tears down", () => {
    const committed: CheckpointedAnalysis = {
      subtitles: [subtitle(1)],
      keyPhrases: [],
      checkpoint: {
        version: 1,
        transcriptFingerprint: "sha256:fixture",
        nextCueOffset: 50,
        phase: "cues",
        revision: 7,
      },
    };

    useAnalysis.getState().setAnalysisPreview(committed, {
      startCueOffset: 50,
      endCueOffset: 100,
      entries: [{ cueOffset: 50, subtitle: subtitle(51) }],
      subtitles: [subtitle(51)],
    }, 100);
    rollbackForegroundPreview("video-1", committed, 100);

    expect(useAnalysis.getState().subtitles).toEqual(committed.subtitles);
    expect(useAnalysis.getState().checkpoint).toEqual(committed.checkpoint);
  });

  it("rejects stale foreground continuations after session or video ownership changes", () => {
    const expected = {} as PersistedAnalysisSession;
    const replacement = {} as PersistedAnalysisSession;

    expect(ownsForegroundAnalysis("video-1", expected, expected)).toBe(true);
    expect(ownsForegroundAnalysis("video-1", expected, null)).toBe(false);
    expect(ownsForegroundAnalysis("video-1", expected, replacement)).toBe(false);

    useAnalysis.getState().startFor("video-2");
    expect(ownsForegroundAnalysis("video-1", expected, expected)).toBe(false);
  });

  it("rejects a retranscription result after its operation epoch is invalidated", () => {
    expect(ownsForegroundOperation("video-1", 4, 4)).toBe(true);
    expect(ownsForegroundOperation("video-1", 4, 5)).toBe(false);

    useAnalysis.getState().startFor("video-2");
    expect(ownsForegroundOperation("video-1", 4, 4)).toBe(false);
  });

  it("locks manual subtitle edits while the analysis producer is saving", () => {
    expect(canEditSubtitles("analyzing")).toBe(false);
    expect(canEditSubtitles("paused")).toBe(true);
    expect(canEditSubtitles("complete")).toBe(true);
  });

  it("keeps the durable checkpoint when managed quota is exhausted", () => {
    const committed: CheckpointedAnalysis = {
      subtitles: [subtitle(1)],
      keyPhrases: [],
      checkpoint: {
        version: 1,
        transcriptFingerprint: "sha256:fixture",
        nextCueOffset: 50,
        phase: "cues",
        revision: 7,
      },
    };
    const quotaError = {
      used: 5_000_000,
      limit: 5_000_000,
      periodResetAt: Date.UTC(2026, 7, 1),
      committedCueOffset: 50,
      totalCues: 100,
    };

    useAnalysis.getState().setCommittedAnalysis(committed, 100);
    useAnalysis.getState().setError(
      "quota exceeded",
      true,
      "analysis",
      quotaError,
    );

    const state = useAnalysis.getState();
    expect(state.checkpoint?.nextCueOffset).toBe(50);
    expect(state.quotaError).toEqual(quotaError);
  });

  it("clears stale quota recovery metadata on later errors and reset", () => {
    useAnalysis.getState().setError("quota exceeded", true, "analysis", {
      used: 5_000_000,
      limit: 5_000_000,
      periodResetAt: Date.UTC(2026, 7, 1),
      committedCueOffset: 50,
      totalCues: 100,
    });

    useAnalysis.getState().setError("network failed", false, "analysis");
    expect(useAnalysis.getState().quotaError).toBeNull();

    useAnalysis.getState().reset();
    expect(useAnalysis.getState().quotaError).toBeNull();
  });
});
