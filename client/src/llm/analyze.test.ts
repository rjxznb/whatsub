import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runAnalysis,
  type AnalysisCommit,
  type AnalysisPreview,
  type AnalysisRetryEvent,
} from "./analyze";
import {
  ProviderHttpError,
  ProviderProtocolError,
  ProviderTransportError,
} from "./providers/errors";
import type { Provider, ProviderRequest } from "./providers/types";
import type { AnalysisCheckpoint, SrtCue, Subtitle } from "./types";

interface StreamScript {
  chunks?: readonly string[];
  error?: unknown;
  onChunk?: (index: number) => void;
}

function scriptedProvider(
  scripts: readonly StreamScript[],
): Provider & { requests: ProviderRequest[] } {
  let call = 0;
  const requests: ProviderRequest[] = [];
  return {
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
    index,
    translation,
    isKeyPoint: false,
    highlights: [],
  })}\n`;

const subtitleFromCue = (cue: SrtCue, translation = `translation-${cue.index}`): Subtitle => ({
  time: cue.time,
  endTime: cue.endTime,
  text: cue.text,
  translation,
  isKeyPoint: false,
  highlightWords: [],
  keyNotes: {},
  highlightTranslations: {},
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

  it("previews valid cues and repairs only the unresolved index before one commit", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const provider = scriptedProvider([
      { chunks: [cueLine(0), '{"index":1,"translation":"broken\n', cueLine(2)] },
      { chunks: [cueLine(1)] },
    ]);
    const commits: AnalysisCommit[] = [];
    const previews: Array<AnalysisPreview | null> = [];

    await runWithTimers(runAnalysis({
      provider,
      cues: cues(3),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      batchSize: 3,
      signal: controller.signal,
      onPreview: (preview) => { previews.push(preview); },
      onCommit: async (commit) => {
        commits.push(commit);
        controller.abort();
      },
    }));

    expect(previews.filter(Boolean).map((preview) => preview!.subtitles.length))
      .toEqual([1, 2, 3]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].userPrompt).toContain("source-1");
    expect(provider.requests[1].userPrompt).not.toContain("source-0");
    expect(provider.requests[1].userPrompt).not.toContain("source-2");
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      kind: "cues",
      startCueOffset: 0,
      endCueOffset: 3,
      subtitles: [
        { text: "source-0" },
        { text: "source-1" },
        { text: "source-2" },
      ],
      checkpoint: { nextCueOffset: 3, phase: "summary" },
    });
  });

  it("repairs only damaged annotations without retranslating accepted cues", async () => {
    const batch: SrtCue[] = [
      {
        index: 0,
        time: 0,
        endTime: 1,
        text: "one two three four five six seven eight nine",
      },
      { index: 1, time: 1, endTime: 2, text: "keep short" },
    ];
    const provider = scriptedProvider([
      { chunks: [
        `${JSON.stringify({
          i: 0,
          zh: "这是一个完整长句",
          p: [[batch[0].text, "完整长句", "模型错误地选择了完整句子"]],
        })}\n`,
        `${JSON.stringify({
          i: 1,
          zh: "保持简短",
          p: [["keep short", "保持简短", "表示让内容保持精炼"]],
        })}\n`,
      ] },
      { chunks: [`${JSON.stringify({
        i: 0,
        p: [["one two", "完整长句", "修复后只保留值得学习的短表达"]],
      })}\n`] },
    ]);
    const controller = new AbortController();
    const commits: AnalysisCommit[] = [];

    await runAnalysis({
      provider,
      cues: batch,
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      batchSize: 2,
      signal: controller.signal,
      onCommit: async (commit) => { commits.push(commit); controller.abort(); },
    });

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].userPrompt).toContain(batch[0].text);
    expect(provider.requests[1].userPrompt).toContain("这是一个完整长句");
    expect(provider.requests[1].userPrompt).not.toContain("keep short");
    expect(provider.requests[1].userPrompt).toContain("Do not translate again");
    expect(commits[0]).toMatchObject({
      kind: "cues",
      subtitles: [
        { translation: "这是一个完整长句", highlightWords: ["one two"] },
        { translation: "保持简短", highlightWords: ["keep short"] },
      ],
    });
  });

  it("keeps a valid translation when targeted annotation repair stays malformed", async () => {
    const batch: SrtCue[] = [{
      index: 0,
      time: 0,
      endTime: 1,
      text: "one two three four five six seven eight nine",
    }];
    const provider = scriptedProvider([
      { chunks: [`${JSON.stringify({
        i: 0,
        zh: "已经翻译成功",
        p: [[batch[0].text, "翻译成功", "错误地选择了完整句子"]],
      })}\n`] },
      { chunks: ['{"i":0,"p":"still broken"}\n'] },
    ]);
    const controller = new AbortController();
    const commits: AnalysisCommit[] = [];

    await runAnalysis({
      provider,
      cues: batch,
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      signal: controller.signal,
      onCommit: async (commit) => { commits.push(commit); controller.abort(); },
    });

    expect(provider.requests).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      kind: "cues",
      subtitles: [{
        translation: "已经翻译成功",
        isKeyPoint: false,
        highlightWords: [],
      }],
    });
  });

  it("retries a transport failure during targeted annotation repair", async () => {
    vi.useFakeTimers();
    const batch: SrtCue[] = [{
      index: 0,
      time: 0,
      endTime: 1,
      text: "one two three four five six seven eight nine",
    }];
    const failure = new ProviderTransportError("repair socket closed", "read");
    const provider = scriptedProvider([
      { chunks: [`${JSON.stringify({
        i: 0,
        zh: "已经翻译成功",
        p: [[batch[0].text, "翻译成功", "错误地选择了完整句子"]],
      })}\n`] },
      { error: failure },
      { chunks: [`${JSON.stringify({ i: 0, p: [] })}\n`] },
    ]);
    const controller = new AbortController();
    const retries: AnalysisRetryEvent[] = [];

    await runWithTimers(runAnalysis({
      provider,
      cues: batch,
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      signal: controller.signal,
      onRetry: (event) => retries.push(event),
      onCommit: async () => controller.abort(),
    }));

    expect(provider.requests).toHaveLength(3);
    expect(retries).toContainEqual(expect.objectContaining({
      kind: "transport",
      unresolvedCueIndexes: [0],
    }));
  });

  it("repairs an incomplete 50-cue response for a provider without retry metadata", async () => {
    vi.useFakeTimers();
    const batch = cues(50, 51);
    const provider = scriptedProvider([
      { chunks: batch.slice(0, 40).map((cue) => cueLine(cue.index)) },
      { chunks: batch.slice(40).map((cue) => cueLine(cue.index)) },
    ]);
    const controller = new AbortController();
    const commits: AnalysisCommit[] = [];

    await runWithTimers(runAnalysis({
      provider,
      cues: batch,
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      batchSize: 50,
      signal: controller.signal,
      onCommit: async (commit) => {
        commits.push(commit);
        controller.abort();
      },
    }));

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].userPrompt).not.toContain("\n90\t");
    expect(provider.requests[1].userPrompt).toContain("\n91\t");
    expect(provider.requests[1].userPrompt).toContain("\n100\t");
    expect(commits[0]).toMatchObject({ kind: "cues" });
    expect(commits[0].kind === "cues" && commits[0].subtitles).toHaveLength(50);
  });

  it("awaits preview persistence before consuming the next provider chunk", async () => {
    const persisted = deferred<void>();
    const previewStarted = deferred<void>();
    const consumed: number[] = [];
    const calls: string[] = [];
    const controller = new AbortController();
    const provider = scriptedProvider([{
      chunks: [cueLine(0), cueLine(1)],
      onChunk: (index) => consumed.push(index),
    }]);

    const run = runAnalysis({
      provider,
      cues: cues(2),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      signal: controller.signal,
      onPreview: async (preview) => {
        if (!preview) return;
        calls.push(`save:${preview.entries.length}`);
        if (preview.entries.length === 1) {
          previewStarted.resolve();
          await persisted.promise;
        }
        calls.push(`visible:${preview.entries.length}`);
      },
      onCommit: async () => controller.abort(),
    });

    await previewStarted.promise;
    expect(consumed).toEqual([0]);
    expect(calls).toEqual(["save:1"]);

    persisted.resolve();
    await run;
    expect(consumed).toEqual([0, 1]);
    expect(calls).toEqual(["save:1", "visible:1", "save:2", "visible:2"]);
  });

  it("requests only missing offsets from a 23-entry resumed batch", async () => {
    const batch = cues(50, 1);
    const resumeEntries = batch.slice(0, 23).map((cue, cueOffset) => ({
      cueOffset,
      subtitle: subtitleFromCue(cue),
    }));
    const provider = scriptedProvider([{
      chunks: batch.slice(23).map((cue) => cueLine(cue.index)),
    }]);
    const controller = new AbortController();
    const commits: AnalysisCommit[] = [];

    await runAnalysis({
      provider,
      cues: batch,
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      batchSize: 50,
      resumePreview: {
        startCueOffset: 0,
        endCueOffset: 50,
        entries: resumeEntries,
        subtitles: resumeEntries.map((entry) => entry.subtitle),
      },
      signal: controller.signal,
      onPreview: async () => {},
      onCommit: async (commit) => {
        commits.push(commit);
        controller.abort();
      },
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].userPrompt).not.toContain("\n1\t");
    expect(provider.requests[0].userPrompt).not.toContain("\n23\t");
    expect(provider.requests[0].userPrompt).toContain("\n24\t");
    expect(commits[0]).toMatchObject({ kind: "cues" });
    expect(commits[0].kind === "cues" && commits[0].subtitles).toHaveLength(50);
  });

  it("rejects a resume preview for another batch before calling the provider", async () => {
    const provider = scriptedProvider([{ error: new Error("provider must not be called") }]);

    await expect(runAnalysis({
      provider,
      cues: cues(2),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      resumePreview: {
        startCueOffset: 1,
        endCueOffset: 2,
        entries: [{ cueOffset: 1, subtitle: subtitleFromCue(cues(2)[1]) }],
        subtitles: [subtitleFromCue(cues(2)[1])],
      },
      onCommit: async () => {},
    })).rejects.toThrow(/resume preview.*current batch/i);

    expect(provider.requests).toEqual([]);
  });

  it("waits for an already-started preview save before honoring abort", async () => {
    const persisted = deferred<void>();
    const previewStarted = deferred<void>();
    const controller = new AbortController();
    const consumed: number[] = [];
    const publishedLengths: number[] = [];
    const original = checkpoint();
    const provider = scriptedProvider([{
      chunks: [cueLine(0), cueLine(1)],
      onChunk: (index) => consumed.push(index),
    }]);

    const run = runAnalysis({
      provider,
      cues: cues(2),
      previouslyAnalyzed: [],
      checkpoint: original,
      signal: controller.signal,
      onPreview: async (preview) => {
        if (!preview) return;
        previewStarted.resolve();
        await persisted.promise;
        publishedLengths.push(preview.entries.length);
      },
      onCommit: async () => {},
    });

    await previewStarted.promise;
    controller.abort();
    await Promise.resolve();
    expect(consumed).toEqual([0]);
    expect(publishedLengths).toEqual([]);

    persisted.resolve();
    expect(await run).toBe(original);
    expect(consumed).toEqual([0]);
    expect(publishedLengths).toEqual([1]);
  });

  it("keeps validated output after a failed read and retries only unresolved cues", async () => {
    vi.useFakeTimers();
    const readFailure = new ProviderTransportError("socket closed", "read");
    const provider = scriptedProvider([
      { chunks: [cueLine(0, "kept")], error: readFailure },
      { chunks: [cueLine(1, "recovered")] },
    ]);
    const controller = new AbortController();
    const commits: AnalysisCommit[] = [];
    const retries: AnalysisRetryEvent[] = [];

    await runWithTimers(runAnalysis({
      provider,
      cues: cues(2),
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
      subtitles: [{ translation: "kept" }, { translation: "recovered" }],
      checkpoint: { nextCueOffset: 2, phase: "summary", revision: 8 },
    });
    expect(provider.requests[1].userPrompt).toContain("source-1");
    expect(provider.requests[1].userPrompt).not.toContain("source-0");
    expect(retries).toEqual([
      expect.objectContaining({
        kind: "transport",
        failedAttempt: 1,
        nextAttempt: 2,
        delayMs: 500,
        unresolvedCueIndexes: [1],
      }),
    ]);
  });

  it("repairs only a cue with an empty translation", async () => {
    vi.useFakeTimers();
    const provider = scriptedProvider([
      { chunks: [cueLine(0), cueLine(1, "  ")] },
      { chunks: [cueLine(1, "repaired")] },
    ]);
    const controller = new AbortController();
    const commits: AnalysisCommit[] = [];

    await runWithTimers(runAnalysis({
      provider,
      cues: cues(2),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      signal: controller.signal,
      onCommit: async (commit) => { commits.push(commit); controller.abort(); },
    }));

    expect(provider.requests[1].userPrompt).toContain("source-1");
    expect(provider.requests[1].userPrompt).not.toContain("source-0");
    expect(commits[0]).toMatchObject({
      kind: "cues",
      subtitles: [{ translation: "translation-0" }, { translation: "repaired" }],
    });
  });

  it("ignores duplicate and out-of-range indexes without replacing resolved cues", async () => {
    vi.useFakeTimers();
    const provider = scriptedProvider([
      { chunks: [cueLine(99, "foreign"), cueLine(0, "first"), cueLine(0, "duplicate")] },
      { chunks: [cueLine(1, "second")] },
    ]);
    const controller = new AbortController();
    const commits: AnalysisCommit[] = [];

    await runWithTimers(runAnalysis({
      provider,
      cues: cues(2),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      signal: controller.signal,
      onCommit: async (commit) => { commits.push(commit); controller.abort(); },
    }));

    expect(commits[0]).toMatchObject({
      kind: "cues",
      subtitles: [{ translation: "first" }, { translation: "second" }],
    });
  });

  it("assigns a unique request identity when the SRT repeats a cue index", async () => {
    vi.useFakeTimers();
    const duplicateIndexes: SrtCue[] = [
      { index: 7, time: 0, endTime: 1, text: "first source" },
      { index: 7, time: 1, endTime: 2, text: "second source" },
    ];
    const provider = scriptedProvider([
      { chunks: [cueLine(7, "first translation")] },
      { chunks: [cueLine(8, "second translation")] },
    ]);
    const controller = new AbortController();
    const commits: AnalysisCommit[] = [];
    const previews: AnalysisPreview[] = [];

    await runWithTimers(runAnalysis({
      provider,
      cues: duplicateIndexes,
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      onPreview: (preview) => { if (preview) previews.push(preview); },
      onCommit: async (commit) => { commits.push(commit); controller.abort(); },
      signal: controller.signal,
    }));

    expect(provider.requests[1].userPrompt).toContain("second source");
    expect(provider.requests[1].userPrompt).not.toContain("first source");
    expect(commits[0]).toMatchObject({
      kind: "cues",
      subtitles: [
        { text: "first source", translation: "first translation" },
        { text: "second source", translation: "second translation" },
      ],
      checkpoint: { nextCueOffset: 2 },
    });
    expect(previews[previews.length - 1]?.entries.map((entry) => entry.cueOffset))
      .toEqual([0, 1]);
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

  it("does not advance a checkpoint when all content-repair attempts stay empty", async () => {
    vi.useFakeTimers();
    const provider = scriptedProvider([{}, {}, {}, {}]);
    const commits: AnalysisCommit[] = [];
    const previews: Array<AnalysisPreview | null> = [];
    const original = checkpoint();

    await expect(runWithTimers(runAnalysis({
      provider,
      cues: cues(3),
      previouslyAnalyzed: [],
      checkpoint: original,
      onPreview: (preview) => { previews.push(preview); },
      onCommit: async (commit) => { commits.push(commit); },
    }))).rejects.toThrow(/3.*0.*1.*2/);

    expect(provider.requests).toHaveLength(4);
    expect(commits).toEqual([]);
    expect(previews[previews.length - 1]).toBeNull();
    expect(original.nextCueOffset).toBe(0);
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
    const previews: Array<AnalysisPreview | null> = [];

    const result = await runAnalysis({
      provider,
      cues: cues(2),
      previouslyAnalyzed: [],
      checkpoint: original,
      signal: controller.signal,
      onPreview: (preview) => { previews.push(preview); },
      onCommit: async (commit) => { commits.push(commit); },
    });

    expect(result).toBe(original);
    expect(commits).toEqual([]);
    expect(previews[previews.length - 1]).toBeNull();
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
      cues: cues(2),
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

  it.each([
    ["transport", new ProviderTransportError("offline", "send")],
    ["HTTP 429", new ProviderHttpError("rate limited", 429, "", 0)],
    ["HTTP 503", new ProviderHttpError("unavailable", 503, "", null)],
  ])("retries %s failures for every analysis provider", async (_name, failure) => {
    vi.useFakeTimers();
    const provider = scriptedProvider([{ error: failure }, { chunks: [cueLine(0)] }]);
    const controller = new AbortController();

    await runWithTimers(runAnalysis({
      provider,
      cues: cues(1),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      signal: controller.signal,
      onCommit: async () => controller.abort(),
    }));

    expect(provider.requests).toHaveLength(2);
  });

  it("retries malformed model content and reports unresolved indexes", async () => {
    vi.useFakeTimers();
    const provider = scriptedProvider(Array.from({ length: 4 }, () => ({
      chunks: ["not json\n"],
    })));
    const commits: AnalysisCommit[] = [];
    const retries: AnalysisRetryEvent[] = [];

    await expect(runWithTimers(runAnalysis({
      provider,
      cues: cues(1),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      onRetry: (event) => retries.push(event),
      onCommit: async (commit) => { commits.push(commit); },
    }))).rejects.toBeInstanceOf(ProviderProtocolError);

    expect(provider.requests).toHaveLength(4);
    expect(retries).toHaveLength(3);
    expect(retries[0]).toMatchObject({
      kind: "content-repair",
      unresolvedCueIndexes: [0],
    });
    expect(commits).toEqual([]);
  });

  it("redacts API-key-shaped content from malformed-line diagnostics", async () => {
    vi.useFakeTimers();
    const secret = "sk-super-secret-token-123456789";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = scriptedProvider(Array.from({ length: 4 }, () => ({
      chunks: [`{\"index\":0,\"translation\":\"${secret}\"\n`],
    })));

    await expect(runWithTimers(runAnalysis({
      provider,
      cues: cues(1),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      onCommit: async () => {},
    }))).rejects.toBeInstanceOf(ProviderProtocolError);

    const diagnostic = warn.mock.calls.flat().join(" ");
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).toContain("[REDACTED]");
    warn.mockRestore();
  });

  it.each([
    ["authentication", new ProviderHttpError("unauthorized", 401, "", null)],
    ["model not found", new ProviderHttpError("model not found", 404, "", null)],
  ])("does not retry deterministic %s failures", async (_name, failure) => {
    const provider = scriptedProvider([{ error: failure }]);

    await expect(runAnalysis({
      provider,
      cues: cues(1),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      onCommit: async () => {},
    })).rejects.toBe(failure);

    expect(provider.requests).toHaveLength(1);
  });

  it.each([
    ["an empty stream", []],
    ["valid JSON without a summary", [cueLine(0)]],
    ["a summary without keyPhrases", ['{"type":"summary"}\n']],
    [
      "a summary with malformed keyPhrases",
      ['{"type":"summary","keyPhrases":[{"expression":"hello"}]}\n'],
    ],
  ])("rejects %s without committing phase complete", async (_name, chunks) => {
    vi.useFakeTimers();
    const provider = scriptedProvider(Array.from({ length: 4 }, () => ({ chunks })));
    const commits: AnalysisCommit[] = [];

    await expect(runWithTimers(runAnalysis({
      provider,
      cues: cues(1),
      previouslyAnalyzed: [],
      checkpoint: checkpoint("summary", 1),
      onCommit: async (commit) => { commits.push(commit); },
    }))).rejects.toBeInstanceOf(ProviderProtocolError);

    expect(provider.requests).toHaveLength(4);
    expect(commits).toEqual([]);
  });

  it("retries malformed summary content without sending cue prompts again", async () => {
    vi.useFakeTimers();
    const provider = scriptedProvider([
      { chunks: ['{"type":"summary"}\n'] },
      { chunks: [summaryLine] },
    ]);
    const commits: AnalysisCommit[] = [];

    await runWithTimers(runAnalysis({
      provider,
      cues: cues(1),
      previouslyAnalyzed: [],
      checkpoint: checkpoint("summary", 1),
      onCommit: async (commit) => { commits.push(commit); },
    }));

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests.every((request) => request.userPrompt.includes("GLOBAL keyPhrases")))
      .toBe(true);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ kind: "summary", checkpoint: { phase: "complete" } });
  });

  it("preserves legacy cue callbacks when summary retries are exhausted", async () => {
    vi.useFakeTimers();
    const summaryFailure = new ProviderTransportError("summary unavailable", "read");
    const provider = scriptedProvider([
      { chunks: [cueLine(0)] },
      ...Array.from({ length: 4 }, () => ({ error: summaryFailure })),
    ]);
    const cueOutput: string[] = [];
    const summaries: unknown[] = [];

    await expect(runWithTimers(runAnalysis({
      provider,
      cues: cues(1),
      onCue: (cue) => { cueOutput.push(cue.text); },
      onSummary: (summary) => { summaries.push(summary); },
    }))).resolves.toBeUndefined();

    expect(cueOutput).toEqual(["source-0"]);
    expect(summaries).toEqual([]);
    expect(provider.requests).toHaveLength(5);
  });

  it("rejects a final legacy onCue failure distinctly without retry or summary masking", async () => {
    const provider = scriptedProvider([
      { chunks: [cueLine(0), cueLine(1), cueLine(2)] },
      { chunks: [summaryLine] },
    ]);
    const callbackFailure = new Error("consumer cue callback failed");
    const callbackIndexes: number[] = [];

    await expect(runAnalysis({
      provider,
      cues: cues(3),
      onCue: (cue) => {
        const index = Number(cue.text.slice("source-".length));
        callbackIndexes.push(index);
        if (index === 2) throw callbackFailure;
      },
      onSummary: () => {},
    })).rejects.toMatchObject({
      name: "LegacyCallbackError",
      callback: "onCue",
      cause: callbackFailure,
    });

    expect(callbackIndexes).toEqual([0, 1, 2]);
    expect(provider.requests).toHaveLength(1);
  });

  it("rejects a legacy onSummary failure distinctly", async () => {
    const provider = scriptedProvider([
      { chunks: [cueLine(0)] },
      { chunks: [summaryLine] },
    ]);
    const callbackFailure = new Error("consumer summary callback failed");
    const cueOutput: string[] = [];

    await expect(runAnalysis({
      provider,
      cues: cues(1),
      onCue: (cue) => { cueOutput.push(cue.text); },
      onSummary: () => { throw callbackFailure; },
    })).rejects.toMatchObject({
      name: "LegacyCallbackError",
      callback: "onSummary",
      cause: callbackFailure,
    });

    expect(cueOutput).toEqual(["source-0"]);
    expect(provider.requests).toHaveLength(2);
  });

  it("propagates an AbortError when the supplied signal was not aborted", async () => {
    const abortError = new DOMException("provider aborted independently", "AbortError");
    const provider = scriptedProvider([{ error: abortError }]);
    const controller = new AbortController();

    await expect(runAnalysis({
      provider,
      cues: cues(1),
      previouslyAnalyzed: [],
      checkpoint: checkpoint(),
      signal: controller.signal,
      onCommit: async () => {},
    })).rejects.toBe(abortError);

    expect(controller.signal.aborted).toBe(false);
  });

  it("propagates a legacy summary AbortError when the signal was not aborted", async () => {
    const abortError = new DOMException("summary aborted independently", "AbortError");
    const provider = scriptedProvider([
      { chunks: [cueLine(0)] },
      { error: abortError },
    ]);
    const controller = new AbortController();
    const cueOutput: string[] = [];

    await expect(runAnalysis({
      provider,
      cues: cues(1),
      signal: controller.signal,
      onCue: (cue) => { cueOutput.push(cue.text); },
      onSummary: () => {},
    })).rejects.toBe(abortError);

    expect(controller.signal.aborted).toBe(false);
    expect(cueOutput).toEqual(["source-0"]);
  });

  it("propagates a legacy callback AbortError when the signal was not aborted", async () => {
    const abortError = new DOMException("consumer aborted independently", "AbortError");
    const provider = scriptedProvider([{ chunks: [cueLine(0)] }]);
    const controller = new AbortController();

    await expect(runAnalysis({
      provider,
      cues: cues(1),
      signal: controller.signal,
      onCue: () => { throw abortError; },
      onSummary: () => {},
    })).rejects.toMatchObject({
      name: "LegacyCallbackError",
      callback: "onCue",
      cause: abortError,
    });

    expect(controller.signal.aborted).toBe(false);
  });

  it.each([0, -1, 1.5])(
    "rejects invalid batchSize %s before requesting the provider",
    async (batchSize) => {
      const providerCalled = new Error("provider must not be called");
      const provider = scriptedProvider([{ error: providerCalled }]);

      await expect(runAnalysis({
        provider,
        cues: cues(1),
        previouslyAnalyzed: [],
        checkpoint: checkpoint(),
        batchSize,
        onCommit: async () => {},
      })).rejects.toBeInstanceOf(RangeError);

      expect(provider.requests).toEqual([]);
    },
  );
});
