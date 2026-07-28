import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runAnalysis,
  type AnalysisCommit,
  type AnalysisRetryEvent,
} from "./analyze";
import { ProviderProtocolError, ProviderTransportError } from "./providers/errors";
import type { Provider, ProviderRequest } from "./providers/types";
import type { AnalysisCheckpoint, SrtCue } from "./types";

interface StreamScript {
  chunks?: readonly string[];
  error?: unknown;
  onChunk?: (index: number) => void;
}

function scriptedProvider(
  scripts: readonly StreamScript[],
  retryProfile: Provider["retryProfile"] | null = "deepseek-analysis",
): Provider & { requests: ProviderRequest[] } {
  let call = 0;
  const requests: ProviderRequest[] = [];
  return {
    ...(retryProfile === null ? {} : { retryProfile }),
    requests,
    async *stream(request) {
      requests.push(request);
      const script = scripts[call++] ?? {};
      for (let i = 0; i < (script.chunks?.length ?? 0); i++) {
        await Promise.resolve();
        script.onChunk?.(i);
        yield script.chunks![i];
      }
      if (script.error) throw script.error;
    },
  };
}

const cues = (count: number, startIndex = 0): SrtCue[] =>
  Array.from({ length: count }, (_, offset) => ({
    index: startIndex + offset,
    time: offset,
    endTime: offset + 1,
    text: `source-${startIndex + offset}`,
  }));

const cueLine = (index: number, translation = `translation-${index}`) =>
  `${JSON.stringify({
    type: "cue",
    index,
    translation,
    isKeyPoint: false,
    highlightWords: [],
    keyNotes: {},
    highlightTranslations: {},
  })}\n`;

const summaryLine = `${JSON.stringify({
  type: "summary",
  keyPhrases: [{ expression: "hello", meaningZh: "你好", usage: "greeting" }],
})}\n`;

const checkpoint = (
  phase: AnalysisCheckpoint["phase"] = "cues",
  nextCueOffset = 0,
  revision = 7,
): AnalysisCheckpoint => ({
  version: 1,
  transcriptFingerprint: "sha256:test",
  nextCueOffset,
  phase,
  revision,
});

async function runWithTimers<T>(operation: Promise<T>): Promise<T> {
  const settled = operation.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
  await vi.runAllTimersAsync();
  const outcome = await settled;
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}

describe("runAnalysis", () => {
  afterEach(() => vi.useRealTimers());

  it("commits a completed input range and advances by consumed cues, not model output count", async () => {
    const controller = new AbortController();
    const provider = scriptedProvider([{ chunks: [cueLine(0)] }]);
    const commits: AnalysisCommit[] = [];

    await runAnalysis({
      provider,
      cues: cues(51),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      batchSize: 50,
      signal: controller.signal,
      onCommit: async (commit) => {
        commits.push(commit);
        controller.abort();
      },
    });

    expect(commits).toEqual([
      expect.objectContaining({
        kind: "cues",
        startCueOffset: 0,
        endCueOffset: 50,
        subtitles: [expect.objectContaining({ text: "source-0" })],
        checkpoint: expect.objectContaining({ nextCueOffset: 50, phase: "cues" }),
      }),
    ]);
  });

  it("discards parsed output from a failed read and commits the successful retry once", async () => {
    vi.useFakeTimers();
    const readFailure = new ProviderTransportError("socket closed", "read");
    const provider = scriptedProvider([
      { chunks: [cueLine(0, "discarded")], error: readFailure },
      { chunks: [cueLine(0, "committed")] },
    ]);
    const controller = new AbortController();
    const commits: AnalysisCommit[] = [];
    const retries: AnalysisRetryEvent[] = [];

    await runWithTimers(runAnalysis({
      provider,
      cues: cues(1),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      signal: controller.signal,
      onRetry: (event) => retries.push(event),
      onCommit: async (commit) => {
        commits.push(commit);
        controller.abort();
      },
    }));

    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      kind: "cues",
      subtitles: [{ translation: "committed" }],
      checkpoint: { nextCueOffset: 1, phase: "summary", revision: 8 },
    });
    expect(retries).toEqual([
      expect.objectContaining({ failedAttempt: 1, nextAttempt: 2, delayMs: 500 }),
    ]);
  });

  it("publishes no commit and does not mutate the original checkpoint after four failures", async () => {
    vi.useFakeTimers();
    const failure = new ProviderTransportError("offline", "send");
    const provider = scriptedProvider(Array.from({ length: 4 }, () => ({ error: failure })));
    const original = checkpoint();
    const originalSnapshot = structuredClone(original);
    const commits: AnalysisCommit[] = [];

    await expect(runWithTimers(runAnalysis({
      provider,
      cues: cues(2),
      previouslyAnalyzed: [],
      checkpoint: original,
      onCommit: async (commit) => { commits.push(commit); },
    }))).rejects.toBe(failure);

    expect(provider.requests).toHaveLength(4);
    expect(commits).toEqual([]);
    expect(original).toEqual(originalSnapshot);
  });

  it("treats a clean empty batch as committed input progress", async () => {
    const controller = new AbortController();
    const provider = scriptedProvider([{}]);
    const commits: AnalysisCommit[] = [];

    const result = await runAnalysis({
      provider,
      cues: cues(3),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      signal: controller.signal,
      onCommit: async (commit) => {
        commits.push(commit);
        controller.abort();
      },
    });

    expect(commits).toEqual([
      expect.objectContaining({
        kind: "cues",
        startCueOffset: 0,
        endCueOffset: 3,
        subtitles: [],
        checkpoint: expect.objectContaining({ nextCueOffset: 3, phase: "summary" }),
      }),
    ]);
    expect(result).toEqual(commits[0].checkpoint);
  });

  it("resumes the summary phase without sending cue requests", async () => {
    const provider = scriptedProvider([{ chunks: [summaryLine] }]);
    const commits: AnalysisCommit[] = [];

    const result = await runAnalysis({
      provider,
      cues: cues(2),
      previouslyAnalyzed: [],
      checkpoint: checkpoint("summary", 2),
      onCommit: async (commit) => { commits.push(commit); },
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].userPrompt).not.toContain("Subtitle cues (JSON)");
    expect(commits).toEqual([
      expect.objectContaining({
        kind: "summary",
        keyPhrases: [expect.objectContaining({ expression: "hello" })],
        checkpoint: expect.objectContaining({
          nextCueOffset: 2,
          phase: "complete",
          revision: 8,
        }),
      }),
    ]);
    expect(result).toEqual(commits[0].checkpoint);
  });

  it("returns an already complete checkpoint without making a request", async () => {
    const provider = scriptedProvider([]);
    const original = checkpoint("complete", 2);
    const commits: AnalysisCommit[] = [];

    const result = await runAnalysis({
      provider,
      cues: cues(2),
      previouslyAnalyzed: [],
      checkpoint: original,
      onCommit: async (commit) => { commits.push(commit); },
    });

    expect(result).toBe(original);
    expect(provider.requests).toEqual([]);
    expect(commits).toEqual([]);
  });

  it("keeps the committed cue checkpoint at summary when summary retries are exhausted", async () => {
    vi.useFakeTimers();
    const failure = new ProviderTransportError("summary read failed", "read");
    const provider = scriptedProvider([
      { chunks: [cueLine(0)] },
      ...Array.from({ length: 4 }, () => ({ error: failure })),
    ]);
    const commits: AnalysisCommit[] = [];

    await expect(runWithTimers(runAnalysis({
      provider,
      cues: cues(1),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      onCommit: async (commit) => { commits.push(commit); },
    }))).rejects.toBe(failure);

    expect(commits).toEqual([
      expect.objectContaining({
        kind: "cues",
        checkpoint: expect.objectContaining({
          nextCueOffset: 1,
          phase: "summary",
          revision: 8,
        }),
      }),
    ]);
  });

  it("publishes nothing when cancelled during a stream", async () => {
    const controller = new AbortController();
    const provider = scriptedProvider([{
      chunks: [cueLine(0), cueLine(1)],
      onChunk: (index) => {
        if (index === 1) controller.abort();
      },
    }]);
    const original = checkpoint();
    const commits: AnalysisCommit[] = [];

    const result = await runAnalysis({
      provider,
      cues: cues(2),
      previouslyAnalyzed: [],
      checkpoint: original,
      signal: controller.signal,
      onCommit: async (commit) => { commits.push(commit); },
    });

    expect(result).toBe(original);
    expect(commits).toEqual([]);
  });

  it("publishes nothing when cancelled at the start of retry backoff", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const failure = new ProviderTransportError("offline", "read");
    const provider = scriptedProvider([{ chunks: [cueLine(0)], error: failure }]);
    const original = checkpoint();
    const commits: AnalysisCommit[] = [];
    const retries: AnalysisRetryEvent[] = [];

    const result = await runWithTimers(runAnalysis({
      provider,
      cues: cues(1),
      previouslyAnalyzed: [],
      checkpoint: original,
      signal: controller.signal,
      onRetry: (event) => {
        retries.push(event);
        controller.abort();
      },
      onCommit: async (commit) => { commits.push(commit); },
    }));

    expect(result).toBe(original);
    expect(provider.requests).toHaveLength(1);
    expect(retries).toHaveLength(1);
    expect(commits).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry providers without the DeepSeek analysis profile", async () => {
    const failure = new ProviderTransportError("offline", "send");
    const provider = scriptedProvider([{ error: failure }], null);

    await expect(runAnalysis({
      provider,
      cues: cues(1),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      onCommit: async () => {},
    })).rejects.toBe(failure);

    expect(provider.requests).toHaveLength(1);
  });

  it("rejects malformed non-empty output as a non-retryable protocol failure", async () => {
    const provider = scriptedProvider([{ chunks: ["not json\n"] }]);
    const commits: AnalysisCommit[] = [];

    await expect(runAnalysis({
      provider,
      cues: cues(1),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      onCommit: async (commit) => { commits.push(commit); },
    })).rejects.toBeInstanceOf(ProviderProtocolError);

    expect(provider.requests).toHaveLength(1);
    expect(commits).toEqual([]);
  });
});
