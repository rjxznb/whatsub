import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import {
  cancelBackground,
  resumeBackgroundAnalysis,
  runInBackground,
  takeOverBackground,
  useBgAnalyses,
} from "./backgroundAnalyses";
import type { PersistedAnalysisSession } from "../llm/analysisSession";
import type { CheckpointedAnalysis, SrtCue, Subtitle } from "../llm/types";
import { ProviderTransportError } from "../llm/providers/errors";
import { StaleAnalysisSessionError } from "../llm/analysisSession";

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  reload: vi.fn(async () => undefined),
}));

vi.mock("../llm/providers", () => ({ getProvider: mocks.getProvider }));
vi.mock("./settings", () => ({
  useSettings: { getState: () => ({ settings: {} }) },
}));
vi.mock("./library", () => ({
  useLibrary: { getState: () => ({ reload: mocks.reload }) },
}));

const cues: SrtCue[] = Array.from({ length: 51 }, (_, index) => ({
  index: index + 1,
  time: index,
  endTime: index + 1,
  text: `Cue input ${index + 1}`,
}));

const subtitle = (index: number): Subtitle => ({
  time: index,
  endTime: index + 1,
  text: `Output ${index + 1}`,
  translation: `译文 ${index + 1}`,
  isKeyPoint: false,
  highlightWords: [],
  keyNotes: {},
  highlightTranslations: {},
});

function fakeSession(
  initial: CheckpointedAnalysis,
  saveHook?: (next: CheckpointedAnalysis) => void | Promise<void>,
) {
  let current = initial;
  const save = vi.fn(async (next: CheckpointedAnalysis) => {
    await saveHook?.(next);
    current = next;
    return next;
  });
  const close = vi.fn(async () => undefined);
  const session: PersistedAnalysisSession = {
    videoId: "video-1",
    lease: "one-lease",
    get analysis() {
      return current;
    },
    save,
    close,
  };
  return { session, save, close };
}

function initialAnalysis(
  phase: "cues" | "summary" = "cues",
  nextCueOffset = 50,
): CheckpointedAnalysis {
  return {
    subtitles: Array.from({ length: 47 }, (_, index) => subtitle(index)),
    keyPhrases: [],
    checkpoint: {
      version: 1,
      transcriptFingerprint: "sha256:fixture",
      nextCueOffset,
      phase,
      revision: 8,
    },
  };
}

describe("background analysis lease handoff", () => {
  beforeEach(async () => {
    await cancelBackground("video-1");
    useBgAnalyses.setState({ jobs: {} });
    mocks.getProvider.mockReset();
    mocks.reload.mockClear();
  });

  it("resumes offset 50 even when only 47 output subtitles exist", async () => {
    const prompts: string[] = [];
    mocks.getProvider.mockReturnValue({
      async *stream(request: { userPrompt: string }) {
        prompts.push(request.userPrompt);
        if (prompts.length === 1) {
          yield `${JSON.stringify({ type: "cue", index: 51, translation: "第五十一句" })}\n`;
        } else {
          yield `${JSON.stringify({ type: "summary", keyPhrases: [] })}\n`;
        }
      },
    });
    const { session } = fakeSession(initialAnalysis());

    runInBackground({
      videoId: "video-1",
      label: "Video",
      cues,
      session,
      style: "colloquial",
    });

    await waitFor(() => expect(useBgAnalyses.getState().jobs["video-1"]?.phase).toBe("done"));
    expect(prompts[0]).toContain("Cue input 51");
    expect(prompts[0]).not.toContain("Cue input 48");
    expect(useBgAnalyses.getState().jobs["video-1"]?.committedCueOffset).toBe(51);
  });

  it("publishes a new background snapshot only after save resolves", async () => {
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    mocks.getProvider.mockReturnValue({
      async *stream() {
        yield `${JSON.stringify({ type: "cue", index: 51, translation: "第五十一句" })}\n`;
      },
    });
    const { session, save } = fakeSession(initialAnalysis(), () => saveGate);

    runInBackground({
      videoId: "video-1",
      label: "Video",
      cues,
      session,
      style: "colloquial",
    });
    await waitFor(() => expect(save).toHaveBeenCalled());

    expect(useBgAnalyses.getState().jobs["video-1"]?.subtitleCount).toBe(47);
    expect(useBgAnalyses.getState().jobs["video-1"]?.committedCueOffset).toBe(50);

    releaseSave();
    await waitFor(() =>
      expect(useBgAnalyses.getState().jobs["video-1"]?.committedCueOffset).toBe(51),
    );
  });

  it("cancels an uncommitted batch without publishing or closing a handed-back lease", async () => {
    mocks.getProvider.mockReturnValue({
      async *stream(request: { signal?: AbortSignal }) {
        await new Promise<void>((_, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const { session, save, close } = fakeSession(initialAnalysis());
    runInBackground({
      videoId: "video-1",
      label: "Video",
      cues,
      session,
      style: "colloquial",
    });

    const takeover = await takeOverBackground("video-1");

    expect(takeover?.session).toBe(session);
    expect(takeover?.analysis.checkpoint.nextCueOffset).toBe(50);
    expect(save).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(useBgAnalyses.getState().jobs["video-1"]).toBeUndefined();
  });

  it("runs summary-only continuation without sending another cue batch", async () => {
    const prompts: string[] = [];
    mocks.getProvider.mockReturnValue({
      async *stream(request: { userPrompt: string }) {
        prompts.push(request.userPrompt);
        yield `${JSON.stringify({ type: "summary", keyPhrases: [] })}\n`;
      },
    });
    const { session } = fakeSession(initialAnalysis("summary", cues.length));

    runInBackground({
      videoId: "video-1",
      label: "Video",
      cues,
      session,
      style: "colloquial",
    });

    await waitFor(() => expect(useBgAnalyses.getState().jobs["video-1"]?.phase).toBe("done"));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("GLOBAL keyPhrases summary");
  });

  it("surfaces stale-lease rejection without reopening or replacing the session", async () => {
    mocks.getProvider.mockReturnValue({
      async *stream() {
        yield `${JSON.stringify({ type: "cue", index: 51, translation: "第五十一句" })}\n`;
      },
    });
    const { session, close } = fakeSession(initialAnalysis(), () => {
      throw new StaleAnalysisSessionError("video-1");
    });
    runInBackground({
      videoId: "video-1",
      label: "Video",
      cues,
      session,
      style: "colloquial",
    });
    await waitFor(() => expect(useBgAnalyses.getState().jobs["video-1"]?.phase).toBe("error"));

    expect(close).not.toHaveBeenCalled();
    resumeBackgroundAnalysis("video-1");
    await waitFor(() => expect(useBgAnalyses.getState().jobs["video-1"]?.phase).toBe("error"));
    expect(close).not.toHaveBeenCalled();
  });

  it("shows transient retry copy while the provider retry is pending", async () => {
    let attempt = 0;
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    mocks.getProvider.mockReturnValue({
      retryProfile: "deepseek-analysis",
      async *stream() {
        attempt += 1;
        if (attempt === 1) {
          throw new ProviderTransportError("temporary network failure", "send");
        }
        await retryGate;
        yield `${JSON.stringify({ type: "cue", index: 51, translation: "第五十一句" })}\n`;
      },
    });
    const { session } = fakeSession(initialAnalysis());
    runInBackground({
      videoId: "video-1",
      label: "Video",
      cues,
      session,
      style: "colloquial",
    });

    await waitFor(
      () => expect(useBgAnalyses.getState().jobs["video-1"]?.retryMessage).toMatch(/第 2\/4 次/),
      { timeout: 1500 },
    );
    releaseRetry();
  });
});
