import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../types/settings";
import { runAnalysis, type AnalysisCommit } from "./analyze";
import { createClaudeProvider } from "./providers/claude";
import { createGeminiProvider } from "./providers/gemini";
import type { Provider } from "./providers/types";
import type { AnalysisCheckpoint, SrtCue } from "./types";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mockFetch }));

const cue: SrtCue = {
  index: 51,
  time: 0,
  endTime: 1,
  text: "source-51",
};

const checkpoint: AnalysisCheckpoint = {
  version: 1,
  transcriptFingerprint: "sha256:provider-retry",
  nextCueOffset: 0,
  phase: "cues",
  revision: 0,
};

const cueJsonLine = `${JSON.stringify({
  i: 51,
  zh: "translation-51",
  p: [],
})}\n`;

function claudeBody(text: string): string {
  return `data: ${JSON.stringify({
    type: "content_block_delta",
    delta: { type: "text_delta", text },
  })}\n\ndata: {"type":"message_stop"}\n\n`;
}

function geminiBody(text: string): string {
  return `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
  })}\n\n`;
}

async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
  await vi.runAllTimersAsync();
  const outcome = await settled;
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}

describe("analysis provider retry integration", () => {
  afterEach(() => {
    mockFetch.mockReset();
    vi.useRealTimers();
  });

  it.each([
    [
      "Claude",
      () => createClaudeProvider({
        ...DEFAULT_SETTINGS,
        claude: { apiKey: "k", model: "m" },
      }),
      claudeBody,
    ],
    [
      "Gemini",
      () => createGeminiProvider({
        ...DEFAULT_SETTINGS,
        gemini: { apiKey: "k", model: "gemini-2.5-pro" },
      }),
      geminiBody,
    ],
  ] satisfies Array<[string, () => Provider, (text: string) => string]>)(
    "retries a transient %s HTTP failure inside subtitle analysis",
    async (_name, createProvider, responseBody) => {
      vi.useFakeTimers();
      mockFetch
        .mockResolvedValueOnce(new Response("busy", { status: 503 }))
        .mockResolvedValueOnce(new Response(responseBody(cueJsonLine), { status: 200 }));
      const controller = new AbortController();
      const commits: AnalysisCommit[] = [];

      await runWithTimers(runAnalysis({
        provider: createProvider(),
        cues: [cue],
        previouslyAnalyzed: [],
        checkpoint,
        signal: controller.signal,
        onCommit: async (commit) => {
          commits.push(commit);
          controller.abort();
        },
      }));

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatchObject({
        kind: "cues",
        subtitles: [{ text: "source-51", translation: "translation-51" }],
      });
    },
  );
});
