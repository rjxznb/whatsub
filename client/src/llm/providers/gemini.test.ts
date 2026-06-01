import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// gemini.ts fetches via @tauri-apps/plugin-http (Rust-side, to bypass the
// WebView CSP/CORS); mock it. vi.hoisted survives vi.mock's top-of-file hoist.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mockFetch }));

import {
  createGeminiProvider,
  formatHistory,
  parseGeminiStream,
} from "./gemini";
import { DEFAULT_SETTINGS } from "../../types/settings";
import type { AgentEvent } from "../../agent/types";
import type { Message } from "../../types/agent";

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

describe("gemini provider", () => {
  it("yields text from streamGenerateContent SSE", async () => {
    const body =
      `data: {"candidates":[{"content":{"parts":[{"text":"hel"}]}}]}\n\n` +
      `data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n`;
    mockFetch.mockResolvedValue(
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

async function* streamFromFixture(fixturePath: string): AsyncGenerator<string> {
  const raw = fs.readFileSync(fixturePath, "utf8");
  for (const chunk of raw.split("\n\n")) {
    if (chunk.trim()) yield chunk + "\n\n";
  }
}

describe("Gemini parseGeminiStream", () => {
  it("parses simple text fixture into text events + end_turn", async () => {
    const events: AgentEvent[] = [];
    const fixture = path.join(
      __dirname,
      "../../agent/__fixtures__/gemini_simple_text.txt",
    );
    for await (const ev of parseGeminiStream(streamFromFixture(fixture))) {
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

  it("parses functionCall fixture into start/args/end + tool_use stop_reason", async () => {
    const events: AgentEvent[] = [];
    const fixture = path.join(
      __dirname,
      "../../agent/__fixtures__/gemini_function_call.txt",
    );
    for await (const ev of parseGeminiStream(streamFromFixture(fixture))) {
      events.push(ev);
    }
    // Preceding text part still emits text events.
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => (e as { type: "text"; delta: string }).delta)
        .join(""),
    ).toBe("Let me check.");
    const start = events.find((e) => e.type === "tool_call_start") as
      | { type: "tool_call_start"; callId: string; name: string }
      | undefined;
    expect(start).toBeDefined();
    expect(start!.name).toBe("list_library");
    // Synthetic callId follows `<name>_<counter>` shape.
    expect(start!.callId.startsWith("list_library_")).toBe(true);
    const startCount = events.filter((e) => e.type === "tool_call_start").length;
    expect(startCount).toBe(1);
    // args arrive atomically — exactly one tool_call_args with the
    // stringified object.
    const argsEvents = events.filter((e) => e.type === "tool_call_args") as Array<{
      type: "tool_call_args";
      callId: string;
      deltaJson: string;
    }>;
    expect(argsEvents.length).toBe(1);
    expect(argsEvents[0].callId).toBe(start!.callId);
    expect(JSON.parse(argsEvents[0].deltaJson)).toEqual({ filter: "medical" });
    expect(events.find((e) => e.type === "tool_call_end")).toMatchObject({
      callId: start!.callId,
    });
    // STOP + sawFunctionCall → tool_use (the contextual discriminator).
    expect(events.find((e) => e.type === "stop_reason")).toMatchObject({
      reason: "tool_use",
    });
  });

  it("maps MAX_TOKENS finishReason directly", async () => {
    async function* src(): AsyncGenerator<string> {
      yield (
        `data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"MAX_TOKENS"}]}\n\n`
      );
    }
    const events: AgentEvent[] = [];
    for await (const ev of parseGeminiStream(src())) events.push(ev);
    expect(events.find((e) => e.type === "stop_reason")).toMatchObject({
      reason: "max_tokens",
    });
  });

  it("handles chunk boundaries mid-line (buffer split)", async () => {
    const raw = fs.readFileSync(
      path.join(__dirname, "../../agent/__fixtures__/gemini_simple_text.txt"),
      "utf8",
    );
    async function* tinyChunks(): AsyncGenerator<string> {
      for (let i = 0; i < raw.length; i += 7) yield raw.slice(i, i + 7);
    }
    const events: AgentEvent[] = [];
    for await (const ev of parseGeminiStream(tinyChunks())) events.push(ev);
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
});

describe("Gemini formatHistory", () => {
  it("user → {role:user, parts:[{text}]}", () => {
    const history: Message[] = [
      { role: "user", id: "u1", ts: 0, content: "hi" },
    ];
    expect(formatHistory(history)).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
    ]);
  });

  it("assistant with text + tool_call → role:model + text + functionCall parts", () => {
    const history: Message[] = [
      {
        role: "assistant",
        id: "a1",
        ts: 0,
        blocks: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_call",
            callId: "list_library_1",
            name: "list_library",
            args: { filter: "medical" },
          },
        ],
        stopReason: "tool_use",
        vendor: "gemini",
        model: "gemini-2.5-pro",
      },
    ];
    expect(formatHistory(history)).toEqual([
      {
        role: "model",
        parts: [
          { text: "Let me check." },
          {
            functionCall: {
              name: "list_library",
              args: { filter: "medical" },
            },
          },
        ],
      },
    ]);
  });

  it("tool ok → user message with functionResponse + {result}", () => {
    const history: Message[] = [
      {
        role: "tool",
        id: "t1",
        ts: 0,
        callId: "list_library_1",
        name: "list_library",
        status: "ok",
        result: { items: 3 },
        durationMs: 12,
      },
    ];
    expect(formatHistory(history)).toEqual([
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "list_library",
              response: { result: { items: 3 } },
            },
          },
        ],
      },
    ]);
  });

  it("tool error → functionResponse with {error}", () => {
    const history: Message[] = [
      {
        role: "tool",
        id: "t1",
        ts: 0,
        callId: "list_library_1",
        name: "list_library",
        status: "error",
        errorMessage: "boom",
        durationMs: 0,
      },
    ];
    expect(formatHistory(history)).toEqual([
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "list_library",
              response: { error: "boom" },
            },
          },
        ],
      },
    ]);
  });

  it("merges adjacent tool messages into a single user/parts batch", () => {
    const history: Message[] = [
      {
        role: "tool",
        id: "t1",
        ts: 0,
        callId: "a_1",
        name: "list_library",
        status: "ok",
        result: { a: 1 },
        durationMs: 1,
      },
      {
        role: "tool",
        id: "t2",
        ts: 0,
        callId: "b_1",
        name: "list_library",
        status: "error",
        errorMessage: "boom",
        durationMs: 0,
      },
    ];
    expect(formatHistory(history)).toEqual([
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "list_library",
              response: { result: { a: 1 } },
            },
          },
          {
            functionResponse: {
              name: "list_library",
              response: { error: "boom" },
            },
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
        callId: "a_1",
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
        callId: "b_1",
        name: "list_library",
        status: "ok",
        result: null,
        durationMs: 1,
      },
    ];
    const out = formatHistory(history) as Array<{ role: string; parts: unknown[] }>;
    expect(out.length).toBe(3);
    expect(out[0].role).toBe("user");
    expect(Array.isArray(out[0].parts)).toBe(true);
    expect(out[1]).toEqual({ role: "user", parts: [{ text: "next" }] });
    expect(out[2].role).toBe("user");
    expect(Array.isArray(out[2].parts)).toBe(true);
  });
});
