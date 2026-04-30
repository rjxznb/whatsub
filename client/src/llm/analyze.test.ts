import { describe, it, expect } from "vitest";
import { runAnalysis } from "./analyze";
import type { Provider, ProviderRequest } from "./providers/types";

/**
 * Multi-call fake provider. Each entry of `callScripts` is the array of
 * chunks yielded for one stream() invocation. Subsequent calls beyond the
 * scripted count yield nothing (mimics an empty stream).
 */
function fakeProvider(callScripts: string[][]): Provider {
  let i = 0;
  return {
    async *stream() {
      const script = callScripts[i] ?? [];
      i++;
      for (const c of script) yield c;
    },
  };
}

/** Yields chunks one-per-microtask so an outside abort can interleave between them. */
function pacedProvider(scriptedChunks: string[], onYield?: (i: number) => void): Provider {
  return {
    async *stream(_req: ProviderRequest) {
      for (let i = 0; i < scriptedChunks.length; i++) {
        await Promise.resolve();
        onYield?.(i);
        yield scriptedChunks[i];
      }
    },
  };
}

const cueLine = (i: number) =>
  `{"type":"cue","index":${i},"time":${i},"endTime":${i + 1},"text":"L${i}","translation":"译${i}","isKeyPoint":false,"highlightWords":[],"keyNotes":{},"highlightTranslations":{}}\n`;

const summaryLine = `{"type":"summary","keyPhrases":[{"expression":"hello","meaningZh":"你好","usage":"打招呼用语"}]}\n`;

describe("runAnalysis", () => {
  it("emits cues from phase 1, then summary from phase 2 (separate provider calls)", async () => {
    // Two separate streams: phase 1 returns cues only, phase 2 returns summary.
    const provider = fakeProvider([
      [cueLine(1), cueLine(2)],
      [summaryLine],
    ]);

    const cues = [
      { index: 1, time: 0, endTime: 1, text: "Hi" },
      { index: 2, time: 1, endTime: 2, text: "Bye" },
    ];

    const cueOut: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let summary: any = null;
    await runAnalysis({
      provider,
      cues,
      onCue: (c) => cueOut.push(Math.round(c.time)),
      onSummary: (s) => {
        summary = s;
      },
      batchSize: 50,
    });

    expect(cueOut).toEqual([1, 2]);
    expect(summary?.keyPhrases?.[0]?.expression).toBe("hello");
  });

  it("includes previouslyAnalyzed cues in the summary phase context", async () => {
    // Phase 1 emits 1 new cue; previouslyAnalyzed seeds 2 prior cues.
    // The summary phase should still produce a summary (we can't easily
    // inspect what the LLM saw, but we verify the run completes & summary
    // arrives — the prompt-construction is unit-tested via prompts.ts).
    const provider = fakeProvider([
      [cueLine(3)],
      [summaryLine],
    ]);
    const cues = [{ index: 3, time: 2, endTime: 3, text: "C" }];
    const previouslyAnalyzed = [
      {
        time: 0, endTime: 1, text: "A", translation: "甲",
        isKeyPoint: false, highlightWords: [], keyNotes: {}, highlightTranslations: {},
      },
      {
        time: 1, endTime: 2, text: "B", translation: "乙",
        isKeyPoint: false, highlightWords: [], keyNotes: {}, highlightTranslations: {},
      },
    ];
    let summary: unknown = null;
    await runAnalysis({
      provider,
      cues,
      previouslyAnalyzed,
      onCue: () => {},
      onSummary: (s) => { summary = s; },
    });
    expect(summary).toBeTruthy();
  });

  it("summary phase failure does NOT throw — cue results stay intact", async () => {
    // Phase 2's stream throws (simulates network/auth failure on the summary call).
    const failingProvider: Provider = {
      async *stream(req) {
        if (req.userPrompt.startsWith("Subtitle cues")) {
          // phase 1: succeed
          yield cueLine(1);
          return;
        }
        // phase 2: throw
        throw new Error("summary call boom");
      },
    };

    const cueOut: number[] = [];
    let summary: unknown = null;
    await expect(
      runAnalysis({
        provider: failingProvider,
        cues: [{ index: 1, time: 0, endTime: 1, text: "Hi" }],
        onCue: (c) => cueOut.push(Math.round(c.time)),
        onSummary: (s) => { summary = s; },
      })
    ).resolves.toBeUndefined();

    // Cue went through; summary stays null because phase 2 failed silently.
    expect(cueOut).toEqual([1]);
    expect(summary).toBeNull();
  });

  it("stops emitting cues after signal is aborted mid-stream", async () => {
    const controller = new AbortController();
    // Abort after the first chunk has been yielded.
    const provider = pacedProvider(
      [cueLine(1), cueLine(2), cueLine(3)],
      (i) => {
        if (i === 1) controller.abort();
      }
    );
    const cues = [
      { index: 1, time: 0, endTime: 1, text: "A" },
      { index: 2, time: 1, endTime: 2, text: "B" },
      { index: 3, time: 2, endTime: 3, text: "C" },
    ];
    const cueOut: number[] = [];
    let summary: unknown = null;

    await runAnalysis({
      provider,
      cues,
      signal: controller.signal,
      onCue: (c) => cueOut.push(Math.round(c.time)),
      onSummary: (s) => { summary = s; },
    });

    // First cue made it through; subsequent cues skipped because signal aborted.
    // Phase 2 also skipped because signal was already aborted.
    expect(cueOut).toEqual([1]);
    expect(summary).toBeNull();
  });
});
