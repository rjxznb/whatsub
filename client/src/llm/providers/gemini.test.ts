import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGeminiProvider } from "./gemini";
import { DEFAULT_SETTINGS } from "../../types/settings";

beforeEach(() => vi.restoreAllMocks());

function makeStream(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(encoder.encode(ch));
      c.close();
    },
  });
}

describe("gemini provider", () => {
  it("yields text from streamGenerateContent SSE", async () => {
    const body =
      `data: {"candidates":[{"content":{"parts":[{"text":"hel"}]}}]}\n\n` +
      `data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(makeStream([body]), { status: 200 })
    );
    const p = createGeminiProvider({
      ...DEFAULT_SETTINGS,
      gemini: { apiKey: "k", model: "gemini-2.5-pro" },
    });
    let acc = "";
    for await (const c of p.stream({ systemPrompt: "s", userPrompt: "u" })) acc += c;
    expect(acc).toBe("hello");
  });
});
