import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
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
import { RelayError } from "../llm/providers/relayErrors";

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  reload: vi.fn(async () => undefined),
  openStoredAnalysisSession: vi.fn(),
}));

vi.mock("../llm/providers", () => ({ getProvider: mocks.getProvider }));
vi.mock("../llm/analysisSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/analysisSession")>();
  return { ...actual, openStoredAnalysisSession: mocks.openStoredAnalysisSession };
});
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
    mocks.openStoredAnalysisSession.mockReset();
    vi.mocked(invoke).mockReset();
  });

  it("resumes offset 50 even when only 47 output subtitles exist", async () => {
    const prompts: string[] = [];
    mocks.getProvider.mockReturnValue({
      async *stream(request: { userPrompt: string }) {
        prompts.push(request.userPrompt);
        if (prompts.length === 1) {
          yield `${JSON.stringify({ index: 51, translation: "第五十一句", highlights: [] })}\n`;
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

  it("publishes cue previews before save while keeping the checkpoint committed", async () => {
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    mocks.getProvider.mockReturnValue({
      async *stream() {
        yield `${JSON.stringify({ index: 51, translation: "第五十一句", highlights: [] })}\n`;
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

    expect(useBgAnalyses.getState().jobs["video-1"]?.subtitleCount).toBe(48);
    expect(useBgAnalyses.getState().jobs["video-1"]?.committedCueOffset).toBe(50);

    releaseSave();
    await waitFor(() =>
      expect(useBgAnalyses.getState().jobs["video-1"]?.committedCueOffset).toBe(51),
    );
  });

  it("takes over with durable analysis and discards an uncommitted preview", async () => {
    mocks.getProvider.mockReturnValue({
      async *stream(request: { signal?: AbortSignal }) {
        yield `${JSON.stringify({ index: 51, translation: "第五十一句", highlights: [] })}\n`;
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

    await waitFor(() =>
      expect(useBgAnalyses.getState().jobs["video-1"]?.subtitleCount).toBe(48),
    );

    const takeover = await takeOverBackground("video-1");

    expect(takeover?.session).toBe(session);
    expect(takeover?.analysis.subtitles).toHaveLength(47);
    expect(takeover?.analysis.checkpoint.nextCueOffset).toBe(50);
    expect(save).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(useBgAnalyses.getState().jobs["video-1"]).toBeUndefined();
  });

  it("rolls back visible previews when unresolved cues exhaust repair attempts", async () => {
    const extendedCues: SrtCue[] = [
      ...cues,
      { index: 52, time: 51, endTime: 52, text: "Cue input 52" },
    ];
    let attempt = 0;
    mocks.getProvider.mockReturnValue({
      retryProfile: "deepseek-analysis",
      async *stream() {
        attempt += 1;
        if (attempt === 1) {
          yield `${JSON.stringify({ index: 51, translation: "第五十一句", highlights: [] })}\n`;
        }
        yield "{malformed json}\n";
      },
    });
    const { session, save } = fakeSession(initialAnalysis());

    runInBackground({
      videoId: "video-1",
      label: "Video",
      cues: extendedCues,
      session,
      style: "colloquial",
    });

    await waitFor(() =>
      expect(useBgAnalyses.getState().jobs["video-1"]?.subtitleCount).toBe(48),
    );
    await waitFor(() =>
      expect(useBgAnalyses.getState().jobs["video-1"]?.retryMessage).toContain(
        "正在补齐 1 条字幕",
      ),
    );
    await waitFor(() =>
      expect(useBgAnalyses.getState().jobs["video-1"]?.phase).toBe("error"),
      { timeout: 10_000 },
    );

    const failed = useBgAnalyses.getState().jobs["video-1"];
    expect(failed?.subtitleCount).toBe(47);
    expect(failed?.committedCueOffset).toBe(50);
    expect(failed?.errorMessage).toContain("52");
    expect(save).not.toHaveBeenCalled();
  }, 15_000);

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

  it("preserves structured quota recovery details in a failed background job and takeover", async () => {
    mocks.getProvider.mockReturnValue({
      async *stream() {
        throw new RelayError({
          code: "quota_exceeded",
          message: "本月额度已用完",
          upsell: true,
          used: 5_000_100,
          limit: 5_000_000,
          periodResetAt: Date.UTC(2026, 7, 1),
        }, 429);
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

    await waitFor(() =>
      expect(useBgAnalyses.getState().jobs["video-1"]?.phase).toBe("error"),
    );
    expect(useBgAnalyses.getState().jobs["video-1"]?.quotaError).toEqual({
      used: 5_000_100,
      limit: 5_000_000,
      periodResetAt: Date.UTC(2026, 7, 1),
      committedCueOffset: 50,
      totalCues: 51,
    });

    const takeover = await takeOverBackground("video-1");
    expect(takeover?.quotaError?.committedCueOffset).toBe(50);
  });

  it("reopens from the persisted transcript after a stale lease", async () => {
    mocks.getProvider.mockReturnValue({
      async *stream(request: { userPrompt: string }) {
        if (request.userPrompt.includes("GLOBAL keyPhrases summary")) {
          yield `${JSON.stringify({ type: "summary", keyPhrases: [] })}\n`;
        } else {
          yield `${JSON.stringify({ index: 51, translation: "第五十一句", highlights: [] })}\n`;
        }
      },
    });
    const { session, close } = fakeSession(initialAnalysis(), () => {
      throw new StaleAnalysisSessionError("video-1");
    });
    const recovered = fakeSession(initialAnalysis("summary", 1));
    const recoveredCues = [{ index: 1, time: 0, endTime: 1, text: "Recovered cue" }];
    mocks.openStoredAnalysisSession.mockResolvedValue({
      cues: recoveredCues,
      session: recovered.session,
    });
    runInBackground({
      videoId: "video-1",
      label: "Video",
      cues,
      session,
      style: "colloquial",
    });
    await waitFor(() => expect(useBgAnalyses.getState().jobs["video-1"]?.phase).toBe("error"));

    resumeBackgroundAnalysis("video-1");
    await waitFor(() => expect(useBgAnalyses.getState().jobs["video-1"]?.phase).toBe("done"));
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.openStoredAnalysisSession).toHaveBeenCalledWith("video-1");
  });

  it("retries a failed stale-session reopen without ever retranscribing", async () => {
    mocks.getProvider.mockReturnValue({
      async *stream(request: { userPrompt: string }) {
        if (request.userPrompt.includes("GLOBAL keyPhrases summary")) {
          yield `${JSON.stringify({ type: "summary", keyPhrases: [] })}\n`;
        } else {
          yield `${JSON.stringify({ index: 51, translation: "第五十一句", highlights: [] })}\n`;
        }
      },
    });
    const stale = fakeSession(initialAnalysis(), () => {
      throw new StaleAnalysisSessionError("video-1");
    });
    const recovered = fakeSession(initialAnalysis("summary", 1));
    const recoveredCues = [{ index: 1, time: 0, endTime: 1, text: "Recovered cue" }];
    mocks.openStoredAnalysisSession
      .mockRejectedValueOnce(new Error("temporary reopen failure"))
      .mockResolvedValueOnce({ cues: recoveredCues, session: recovered.session });

    runInBackground({
      videoId: "video-1",
      label: "Video",
      cues,
      session: stale.session,
      style: "colloquial",
    });
    await waitFor(() => expect(useBgAnalyses.getState().jobs["video-1"]?.phase).toBe("error"));

    resumeBackgroundAnalysis("video-1");
    await waitFor(() =>
      expect(useBgAnalyses.getState().jobs["video-1"]?.errorMessage).toContain(
        "temporary reopen failure",
      ),
    );
    resumeBackgroundAnalysis("video-1");
    await waitFor(() => expect(useBgAnalyses.getState().jobs["video-1"]?.phase).toBe("done"));

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      "retranscribe_video",
      expect.anything(),
    );
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
        yield `${JSON.stringify({ index: 51, translation: "第五十一句", highlights: [] })}\n`;
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
