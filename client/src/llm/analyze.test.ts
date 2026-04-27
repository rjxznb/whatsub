import { describe, it, expect } from "vitest";
import { runAnalysis } from "./analyze";
import type { Provider } from "./providers/types";

function fakeProvider(scriptedChunks: string[]): Provider {
  return {
    async *stream() {
      for (const c of scriptedChunks) yield c;
    },
  };
}

describe("runAnalysis", () => {
  it("emits parsed cue objects then summary", async () => {
    const provider = fakeProvider([
      `{"type":"cue","index":1,"time":0,"endTime":1,"text":"Hi","translation":"嗨","isKeyPoint":false,"highlightWords":[],"keyNotes":{},"highlightTranslations":{}}\n`,
      `{"type":"cue","index":2,"time":1,"endTime":2,"text":"Bye","translation":"再见","isKeyPoint":false,"highlightWords":[],"keyNotes":{},"highlightTranslations":{}}\n`,
      `{"type":"summary","keyPhrases":[]}\n`,
    ]);

    const cues = [
      { index: 1, time: 0, endTime: 1, text: "Hi" },
      { index: 2, time: 1, endTime: 2, text: "Bye" },
    ];

    const cueOut: number[] = [];
    let summary: unknown = null;
    await runAnalysis({
      provider,
      cues,
      onCue: (c) => cueOut.push(Math.round(c.time)),
      onSummary: (s) => {
        summary = s;
      },
      batchSize: 50,
    });

    expect(cueOut).toEqual([0, 1]);
    expect(summary).toBeTruthy();
  });
});
