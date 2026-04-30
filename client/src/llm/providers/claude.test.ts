import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SETTINGS } from "../../types/settings";

// claude.ts imports fetch from @tauri-apps/plugin-http (Rust-side fetch to
// bypass CORS); mock it so the test can drive the SSE response without a
// Tauri runtime. vi.hoisted lets the mock fn survive vi.mock's top-of-file
// hoist.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mockFetch }));

import { createClaudeProvider } from "./claude";

beforeEach(() => mockFetch.mockReset());

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

    mockFetch.mockResolvedValue(
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
