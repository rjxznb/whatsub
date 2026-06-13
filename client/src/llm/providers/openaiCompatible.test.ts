import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// openaiCompatible.ts fetches via @tauri-apps/plugin-http (Rust-side, to bypass
// the WebView CSP/CORS); mock it. vi.hoisted survives vi.mock's top-of-file hoist.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mockFetch }));

import {
  createOpenAICompatibleProvider,
  formatHistory,
  parseOpenAIStream,
} from "./openaiCompatible";
import { DEFAULT_SETTINGS } from "../../types/settings";
import type { AgentEvent } from "../../agent/types";
import type { Message } from "../../types/agent";

beforeEach(() => {
  mockFetch.mockReset();
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

    mockFetch.mockResolvedValue(
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
    mockFetch.mockResolvedValue(new Response("bad", { status: 401 }));
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

async function* streamFromFixture(fixturePath: string): AsyncGenerator<string> {
  const raw = fs.readFileSync(fixturePath, "utf8");
  for (const chunk of raw.split("\n\n")) {
    if (chunk.trim()) yield chunk + "\n\n";
  }
}

describe("OpenAICompatible parseOpenAIStream", () => {
  it("parses simple text fixture into text events + end_turn", async () => {
    const events: AgentEvent[] = [];
    const fixture = path.join(
      __dirname,
      "../../agent/__fixtures__/openai_simple_text.txt",
    );
    for await (const ev of parseOpenAIStream(streamFromFixture(fixture))) {
      events.push(ev);
    }
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => (e as { type: "text"; delta: string }).delta)
        .join(""),
    ).toBe("Hello there.");
    expect(events.find((e) => e.type === "stop_reason")).toMatchObject({
      reason: "end_turn",
    });
  });

  it("parses tool_call fixture into start/args/end + tool_use stop_reason", async () => {
    const events: AgentEvent[] = [];
    const fixture = path.join(
      __dirname,
      "../../agent/__fixtures__/openai_one_tool_call.txt",
    );
    for await (const ev of parseOpenAIStream(streamFromFixture(fixture))) {
      events.push(ev);
    }
    expect(events.find((e) => e.type === "tool_call_start")).toMatchObject({
      callId: "call_abc",
      name: "list_library",
    });
    // tool_call_args must accumulate the arguments JSON fragment(s).
    const argsCombined = events
      .filter((e) => e.type === "tool_call_args")
      .map((e) => (e as { type: "tool_call_args"; deltaJson: string }).deltaJson)
      .join("");
    expect(argsCombined).toBe(`{"filter":"medical"}`);
    expect(events.find((e) => e.type === "tool_call_end")).toMatchObject({
      callId: "call_abc",
    });
    expect(events.find((e) => e.type === "stop_reason")).toMatchObject({
      reason: "tool_use",
    });
    // tool_call_start fires exactly once even though id/name are mentioned
    // across multiple deltas.
    const startCount = events.filter((e) => e.type === "tool_call_start").length;
    expect(startCount).toBe(1);
  });

  it("upgrades finish_reason 'stop' WITH tool_calls to tool_use (DeepSeek/relay)", async () => {
    // Some OpenAI-compatible providers (DeepSeek, the whatSub managed relay
    // proxying it) return finish_reason "stop" even when the turn emitted
    // tool_calls. The runtime only executes tools on a tool_use stop_reason, so
    // the adapter must upgrade "stop"→"tool_use" when a tool_call was seen —
    // otherwise the agent gets stuck at "准备调用 <tool>" and never runs it.
    async function* inline(): AsyncGenerator<string> {
      yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"youtube_search","arguments":"{\\"query\\":\\"hi\\"}"}}]}}]}\n\n';
      yield 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
      yield "data: [DONE]\n\n";
    }
    const events: AgentEvent[] = [];
    for await (const ev of parseOpenAIStream(inline())) events.push(ev);
    expect(events.find((e) => e.type === "tool_call_start")).toMatchObject({
      callId: "call_x",
      name: "youtube_search",
    });
    expect(events.find((e) => e.type === "stop_reason")).toMatchObject({
      reason: "tool_use",
    });
  });

  it("keeps finish_reason 'stop' WITHOUT tool_calls as end_turn", async () => {
    async function* inline(): AsyncGenerator<string> {
      yield 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
      yield 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
      yield "data: [DONE]\n\n";
    }
    const events: AgentEvent[] = [];
    for await (const ev of parseOpenAIStream(inline())) events.push(ev);
    expect(events.find((e) => e.type === "stop_reason")).toMatchObject({
      reason: "end_turn",
    });
  });

  it("handles chunk boundaries mid-line (buffer split)", async () => {
    const raw = fs.readFileSync(
      path.join(__dirname, "../../agent/__fixtures__/openai_simple_text.txt"),
      "utf8",
    );
    // Yield in awkward 7-byte slices to exercise the line buffer.
    async function* tinyChunks(): AsyncGenerator<string> {
      for (let i = 0; i < raw.length; i += 7) yield raw.slice(i, i + 7);
    }
    const events: AgentEvent[] = [];
    for await (const ev of parseOpenAIStream(tinyChunks())) events.push(ev);
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => (e as { type: "text"; delta: string }).delta)
        .join(""),
    ).toBe("Hello there.");
  });
});

describe("formatHistory", () => {
  it("user → {role:user, content}", () => {
    const history: Message[] = [
      { role: "user", id: "u1", ts: 0, content: "hi" },
    ];
    expect(formatHistory(history)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("assistant with tool_call → tool_calls array + JSON.stringified arguments", () => {
    const history: Message[] = [
      {
        role: "assistant",
        id: "a1",
        ts: 0,
        blocks: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_call",
            callId: "call_abc",
            name: "list_library",
            args: { filter: "medical" },
          },
        ],
        stopReason: "tool_use",
        vendor: "deepseek",
        model: "deepseek-chat",
      },
    ];
    expect(formatHistory(history)).toEqual([
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: {
              name: "list_library",
              arguments: JSON.stringify({ filter: "medical" }),
            },
          },
        ],
      },
    ]);
  });

  it("tool ok → tool_call_id + JSON result; tool error → errorMessage", () => {
    const history: Message[] = [
      {
        role: "tool",
        id: "t1",
        ts: 0,
        callId: "call_abc",
        name: "list_library",
        status: "ok",
        result: { items: 3 },
        durationMs: 12,
      },
      {
        role: "tool",
        id: "t2",
        ts: 0,
        callId: "call_def",
        name: "list_library",
        status: "error",
        errorMessage: "boom",
        durationMs: 0,
      },
    ];
    expect(formatHistory(history)).toEqual([
      { role: "tool", tool_call_id: "call_abc", content: JSON.stringify({ items: 3 }) },
      { role: "tool", tool_call_id: "call_def", content: "boom" },
    ]);
  });
});
