import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../types/settings";
import type { AgentEvent } from "../../agent/types";
import type { Message } from "../../types/agent";

// claude.ts imports fetch from @tauri-apps/plugin-http (Rust-side fetch to
// bypass CORS); mock it so the test can drive the SSE response without a
// Tauri runtime. vi.hoisted lets the mock fn survive vi.mock's top-of-file
// hoist.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mockFetch }));

import {
  createClaudeProvider,
  formatHistory,
  parseClaudeStream,
} from "./claude";
import { ProviderProtocolError } from "./errors";

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

  it("normalizes send, HTTP, missing-body, and read failures for analysis retry", async () => {
    const provider = createClaudeProvider({
      ...DEFAULT_SETTINGS,
      claude: { apiKey: "k", model: "m" },
    });
    const consume = async () => {
      for await (const _ of provider.stream({ systemPrompt: "s", userPrompt: "u" })) {
        // consume
      }
    };

    mockFetch.mockRejectedValueOnce(new Error("network down"));
    await expect(consume()).rejects.toMatchObject({
      name: "ProviderTransportError",
      stage: "send",
    });

    mockFetch.mockResolvedValueOnce(new Response("busy", {
      status: 503,
      headers: { "retry-after": "2" },
    }));
    await expect(consume()).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 503,
      body: "busy",
      retryAfterMs: 2_000,
    });

    mockFetch.mockResolvedValueOnce({ ok: true, body: null } as Response);
    await expect(consume()).rejects.toBeInstanceOf(ProviderProtocolError);

    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("socket closed")); },
    });
    mockFetch.mockResolvedValueOnce(new Response(failedBody, { status: 200 }));
    await expect(consume()).rejects.toMatchObject({
      name: "ProviderTransportError",
      stage: "read",
    });
  });
});

async function* streamFromFixture(fixturePath: string): AsyncGenerator<string> {
  const raw = fs.readFileSync(fixturePath, "utf8");
  for (const chunk of raw.split("\n\n")) {
    if (chunk.trim()) yield chunk + "\n\n";
  }
}

describe("Claude parseClaudeStream", () => {
  it("parses simple text fixture into text events + end_turn", async () => {
    const events: AgentEvent[] = [];
    const fixture = path.join(
      __dirname,
      "../../agent/__fixtures__/claude_simple_text.txt",
    );
    for await (const ev of parseClaudeStream(streamFromFixture(fixture))) {
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

  it("parses tool_use fixture into start/args/end + tool_use stop_reason", async () => {
    const events: AgentEvent[] = [];
    const fixture = path.join(
      __dirname,
      "../../agent/__fixtures__/claude_one_tool_use.txt",
    );
    for await (const ev of parseClaudeStream(streamFromFixture(fixture))) {
      events.push(ev);
    }
    // Preceding text block still emits text events.
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => (e as { type: "text"; delta: string }).delta)
        .join(""),
    ).toBe("Let me check.");
    // tool_call_start fires once at content_block_start with id+name atomic.
    expect(events.find((e) => e.type === "tool_call_start")).toMatchObject({
      callId: "toolu_abc",
      name: "list_library",
    });
    const startCount = events.filter((e) => e.type === "tool_call_start").length;
    expect(startCount).toBe(1);
    // tool_call_args accumulates input_json_delta partial_json.
    const argsCombined = events
      .filter((e) => e.type === "tool_call_args")
      .map((e) => (e as { type: "tool_call_args"; deltaJson: string }).deltaJson)
      .join("");
    expect(argsCombined).toBe(`{"filter":"medical"}`);
    expect(events.find((e) => e.type === "tool_call_end")).toMatchObject({
      callId: "toolu_abc",
    });
    expect(events.find((e) => e.type === "stop_reason")).toMatchObject({
      reason: "tool_use",
    });
  });

  it("handles chunk boundaries mid-line (buffer split)", async () => {
    const raw = fs.readFileSync(
      path.join(__dirname, "../../agent/__fixtures__/claude_simple_text.txt"),
      "utf8",
    );
    // Yield in awkward 7-byte slices to exercise the line buffer.
    async function* tinyChunks(): AsyncGenerator<string> {
      for (let i = 0; i < raw.length; i += 7) yield raw.slice(i, i + 7);
    }
    const events: AgentEvent[] = [];
    for await (const ev of parseClaudeStream(tinyChunks())) events.push(ev);
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

  it("maps max_tokens stop_reason", async () => {
    async function* src(): AsyncGenerator<string> {
      yield `data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n`;
    }
    const events: AgentEvent[] = [];
    for await (const ev of parseClaudeStream(src())) events.push(ev);
    expect(events).toEqual([{ type: "stop_reason", reason: "max_tokens" }]);
  });
});

describe("Claude formatHistory", () => {
  it("user → {role:user, content}", () => {
    const history: Message[] = [
      { role: "user", id: "u1", ts: 0, content: "hi" },
    ];
    expect(formatHistory(history)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("assistant with text + tool_call → content blocks (text + tool_use)", () => {
    const history: Message[] = [
      {
        role: "assistant",
        id: "a1",
        ts: 0,
        blocks: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_call",
            callId: "toolu_abc",
            name: "list_library",
            args: { filter: "medical" },
          },
        ],
        stopReason: "tool_use",
        vendor: "claude",
        model: "claude-sonnet-4-6",
      },
    ];
    expect(formatHistory(history)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_use",
            id: "toolu_abc",
            name: "list_library",
            input: { filter: "medical" },
          },
        ],
      },
    ]);
  });

  it("tool ok → user message with tool_result; JSON-stringified result", () => {
    const history: Message[] = [
      {
        role: "tool",
        id: "t1",
        ts: 0,
        callId: "toolu_abc",
        name: "list_library",
        status: "ok",
        result: { items: 3 },
        durationMs: 12,
      },
    ];
    expect(formatHistory(history)).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_abc",
            content: JSON.stringify({ items: 3 }),
          },
        ],
      },
    ]);
  });

  it("merges adjacent tool messages into a single user content array", () => {
    const history: Message[] = [
      {
        role: "tool",
        id: "t1",
        ts: 0,
        callId: "toolu_abc",
        name: "list_library",
        status: "ok",
        result: { a: 1 },
        durationMs: 1,
      },
      {
        role: "tool",
        id: "t2",
        ts: 0,
        callId: "toolu_def",
        name: "list_library",
        status: "error",
        errorMessage: "boom",
        durationMs: 0,
      },
    ];
    expect(formatHistory(history)).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_abc",
            content: JSON.stringify({ a: 1 }),
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_def",
            content: "boom",
          },
        ],
      },
    ]);
  });

  it("user message between tools breaks the merge", () => {
    const history: Message[] = [
      {
        role: "tool",
        id: "t1",
        ts: 0,
        callId: "toolu_abc",
        name: "list_library",
        status: "ok",
        result: null,
        durationMs: 1,
      },
      { role: "user", id: "u1", ts: 0, content: "next" },
      {
        role: "tool",
        id: "t2",
        ts: 0,
        callId: "toolu_def",
        name: "list_library",
        status: "ok",
        result: null,
        durationMs: 1,
      },
    ];
    const out = formatHistory(history) as Array<{ role: string; content: unknown }>;
    expect(out.length).toBe(3);
    expect(out[0].role).toBe("user");
    expect(Array.isArray(out[0].content)).toBe(true);
    expect(out[1]).toEqual({ role: "user", content: "next" });
    expect(out[2].role).toBe("user");
    expect(Array.isArray(out[2].content)).toBe(true);
  });
});
