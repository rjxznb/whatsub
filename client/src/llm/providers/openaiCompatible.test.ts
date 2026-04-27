import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpenAICompatibleProvider } from "./openaiCompatible";
import { DEFAULT_SETTINGS } from "../../types/settings";

beforeEach(() => {
  vi.restoreAllMocks();
});

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

describe("openaiCompatible provider", () => {
  it("yields delta content from SSE stream", async () => {
    const sseLines =
      `data: {"choices":[{"delta":{"content":"hel"}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n` +
      `data: [DONE]\n\n`;

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(makeStream([sseLines]), { status: 200 })
    );

    const provider = createOpenAICompatibleProvider({
      ...DEFAULT_SETTINGS,
      openaiCompatible: { baseUrl: "https://x", apiKey: "k", model: "m" },
    });

    const chunks: string[] = [];
    for await (const c of provider.stream({ systemPrompt: "s", userPrompt: "u" })) {
      chunks.push(c);
    }
    expect(chunks.join("")).toBe("hello");
  });

  it("throws on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 401 }));
    const provider = createOpenAICompatibleProvider({
      ...DEFAULT_SETTINGS,
      openaiCompatible: { baseUrl: "https://x", apiKey: "k", model: "m" },
    });
    await expect(async () => {
      for await (const _ of provider.stream({ systemPrompt: "s", userPrompt: "u" })) {
        // consume
      }
    }).rejects.toThrow();
  });
});
