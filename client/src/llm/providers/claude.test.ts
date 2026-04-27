import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClaudeProvider } from "./claude";
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

describe("claude provider", () => {
  it("yields text deltas from event stream", async () => {
    const sse =
      `event: content_block_delta\n` +
      `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hel"}}\n\n` +
      `event: content_block_delta\n` +
      `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n` +
      `event: message_stop\n` +
      `data: {"type":"message_stop"}\n\n`;

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(makeStream([sse]), { status: 200 })
    );
    const p = createClaudeProvider({
      ...DEFAULT_SETTINGS,
      claude: { apiKey: "k", model: "m" },
    });
    let acc = "";
    for await (const c of p.stream({ systemPrompt: "s", userPrompt: "u" })) acc += c;
    expect(acc).toBe("hello");
  });
});
