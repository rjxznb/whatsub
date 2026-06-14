// src/agent/runtime.test.ts
//
// Tests for the AgentRuntime ReAct loop (T12).
//
// All tests stub the LLM provider via `mockProvider(events)` so we drive the
// state machine deterministically. The registry is mutated in beforeEach so
// the runtime's `getTool()` / `listTools()` find synthetic test tools without
// pulling in any real T14-T19 tool implementations.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { runTurn } from "./runtime";
import type { AgentEvent, ToolDef } from "./types";
import type { Message, AssistantMessage, ToolMessage, UserMessage } from "../types/agent";
import { TOOLS } from "./registry";

// — Context module is loaded by runTurn to build the dynamic block; stub its
//   stores so it doesn't try to peek at window.location / zustand state.
vi.mock("../store/playerState", () => ({
  usePlayerState: { getState: () => ({ videoId: null, currentIdx: null, currentTime: null, videoTitle: null }) },
}));
vi.mock("../store/library", () => ({
  useLibrary: { getState: () => ({ library: { videos: [] } }) },
}));
vi.mock("../store/vocab", () => ({
  useVocabulary: { getState: () => ({ entries: [] }) },
}));
vi.mock("../store/settings", () => ({
  useSettings: { getState: () => ({ settings: { llmProvider: "openai-compatible", openaiCompatible: { model: "test", baseUrl: "", apiKey: "" } } }) },
}));
vi.mock("../llm/llmIdentity", () => ({
  getVendorKey: () => "test",
  getModelName: () => "test-model",
}));

function mockProvider(eventBatches: AgentEvent[][]) {
  // Each call to streamWithTools consumes the next event batch.
  let idx = 0;
  return {
    streamWithTools: vi.fn(async function* () {
      const batch = eventBatches[idx++] ?? [];
      for (const ev of batch) yield ev;
    }),
  };
}

/** Build a NOOP tool that succeeds with a given result. */
function noopTool(id: string, opts?: Partial<ToolDef>): ToolDef {
  return {
    id,
    description: "no-op",
    parameters: { type: "object", properties: {}, additionalProperties: false } as never,
    riskTier: "LOW",
    availableOn: () => true,
    runningLabel: "运行",
    doneLabel: () => "完成",
    execute: async () => ({ ok: true }),
    ...opts,
  };
}

function userMsg(content: string): UserMessage {
  return { role: "user", id: "u1", ts: 1, content };
}

function makeOpts(provider: ReturnType<typeof mockProvider>, overrides: {
  events?: AgentEvent[][];
  signal?: AbortSignal;
  confirm?: Mock;
  onMessage?: Mock;
  onAssistantTextDelta?: Mock;
} = {}) {
  const ctrl = new AbortController();
  const onMessage = overrides.onMessage ?? vi.fn();
  const onAssistantTextDelta = overrides.onAssistantTextDelta ?? vi.fn();
  const confirm = overrides.confirm ?? vi.fn(async () => "yes");
  return {
    history: [] as Message[],
    userMessage: userMsg("hi"),
    provider,
    vendor: "test",
    model: "test-model",
    page: { pathname: "/" },
    signal: overrides.signal ?? ctrl.signal,
    confirm: confirm as never,
    onMessage,
    onAssistantTextDelta,
    _ctrl: ctrl,
    _spies: { onMessage, onAssistantTextDelta, confirm },
  };
}

beforeEach(() => {
  TOOLS.length = 0;
});

afterEach(() => {
  TOOLS.length = 0;
});

describe("runTurn ReAct loop", () => {
  it("pure text turn: provider emits text + end_turn → assistant message + end_turn", async () => {
    const provider = mockProvider([
      [
        { type: "text", delta: "你好" },
        { type: "text", delta: "，世界" },
        { type: "stop_reason", reason: "end_turn" },
      ],
    ]);
    const opts = makeOpts(provider);
    await runTurn(opts);

    const calls = opts._spies.onMessage.mock.calls.map((c) => c[0] as Message);
    expect(calls).toHaveLength(2);
    expect(calls[0].role).toBe("user");
    expect(calls[1].role).toBe("assistant");
    const asm = calls[1] as AssistantMessage;
    expect(asm.stopReason).toBe("end_turn");
    expect(asm.blocks).toEqual([{ type: "text", text: "你好，世界" }]);
    expect(opts._spies.onAssistantTextDelta).toHaveBeenCalledTimes(2);
    expect(provider.streamWithTools).toHaveBeenCalledTimes(1);
  });

  it("single-tool turn: tool_use → execute → next iteration ends turn", async () => {
    TOOLS.push(noopTool("greet", { execute: async () => ({ message: "hello" }) }));
    const provider = mockProvider([
      [
        { type: "text", delta: "调用工具" },
        { type: "tool_call_start", callId: "c1", name: "greet" },
        { type: "tool_call_args", callId: "c1", deltaJson: "{}" },
        { type: "tool_call_end", callId: "c1" },
        { type: "stop_reason", reason: "tool_use" },
      ],
      [
        { type: "text", delta: "完成" },
        { type: "stop_reason", reason: "end_turn" },
      ],
    ]);
    const opts = makeOpts(provider);
    await runTurn(opts);

    const calls = opts._spies.onMessage.mock.calls.map((c) => c[0] as Message);
    // user, assistant#1 (tool_use), tool, assistant#2 (end_turn)
    expect(calls.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    const tool = calls[2] as ToolMessage;
    expect(tool.status).toBe("ok");
    expect(tool.name).toBe("greet");
    expect(tool.callId).toBe("c1");
    expect(tool.result).toEqual({ message: "hello" });
    expect(tool.confirmDecision).toBe("auto");
    expect((calls[3] as AssistantMessage).stopReason).toBe("end_turn");
    expect(provider.streamWithTools).toHaveBeenCalledTimes(2);
  });

  it("tool_calls execute even when provider returns end_turn (DeepSeek/relay quirk)", async () => {
    // Some OpenAI-compatible providers/relays return finish_reason "stop"
    // (→ end_turn) even when the turn emitted tool_calls. The runtime must
    // still execute them (gating on stopReason left the agent stuck at
    // "准备调用 <tool>" with no loading and no error).
    TOOLS.push(noopTool("greet", { execute: async () => ({ message: "hello" }) }));
    const provider = mockProvider([
      [
        { type: "text", delta: "调用工具" },
        { type: "tool_call_start", callId: "c1", name: "greet" },
        { type: "tool_call_args", callId: "c1", deltaJson: "{}" },
        { type: "tool_call_end", callId: "c1" },
        { type: "stop_reason", reason: "end_turn" }, // NOT tool_use
      ],
      [
        { type: "text", delta: "完成" },
        { type: "stop_reason", reason: "end_turn" },
      ],
    ]);
    const opts = makeOpts(provider);
    await runTurn(opts);

    const calls = opts._spies.onMessage.mock.calls.map((c) => c[0] as Message);
    // The tool still runs: user, assistant#1, tool, assistant#2.
    expect(calls.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    const tool = calls[2] as ToolMessage;
    expect(tool.status).toBe("ok");
    expect(tool.name).toBe("greet");
    expect(provider.streamWithTools).toHaveBeenCalledTimes(2);
  });

  it("5-tool cap: 6th tool call rejected with cap error, turn ends", async () => {
    // Register one tool used in every iteration
    TOOLS.push(noopTool("ping"));
    // Each iteration: 1 tool_call → tool_use. After 5 successful executes,
    // the 6th call hits the cap.
    const toolUseBatch = (callId: string): AgentEvent[] => [
      { type: "tool_call_start", callId, name: "ping" },
      { type: "tool_call_args", callId, deltaJson: "{}" },
      { type: "tool_call_end", callId },
      { type: "stop_reason", reason: "tool_use" },
    ];
    const provider = mockProvider([
      toolUseBatch("c1"),
      toolUseBatch("c2"),
      toolUseBatch("c3"),
      toolUseBatch("c4"),
      toolUseBatch("c5"),
      toolUseBatch("c6"), // this 6th one will hit the cap
    ]);
    const opts = makeOpts(provider);
    await runTurn(opts);

    const calls = opts._spies.onMessage.mock.calls.map((c) => c[0] as Message);
    const toolMsgs = calls.filter((m) => m.role === "tool") as ToolMessage[];
    // 5 successful executes + 1 cap-error tool message
    expect(toolMsgs.filter((t) => t.status === "ok")).toHaveLength(5);
    const capMsgs = toolMsgs.filter((t) => t.status === "error");
    expect(capMsgs).toHaveLength(1);
    expect(capMsgs[0].errorMessage).toContain("已达本轮工具调用上限");
    expect(capMsgs[0].callId).toBe("c6");
  });

  it("after the cap, runs a final NO-tools turn so the model summarizes", async () => {
    TOOLS.push(noopTool("ping"));
    const toolUseBatch = (callId: string): AgentEvent[] => [
      { type: "tool_call_start", callId, name: "ping" },
      { type: "tool_call_args", callId, deltaJson: "{}" },
      { type: "tool_call_end", callId },
      { type: "stop_reason", reason: "tool_use" },
    ];
    const provider = mockProvider([
      toolUseBatch("c1"),
      toolUseBatch("c2"),
      toolUseBatch("c3"),
      toolUseBatch("c4"),
      toolUseBatch("c5"),
      toolUseBatch("c6"), // hits cap → break to a final no-tools iteration
      [
        { type: "text", delta: "这是给你的总结" },
        { type: "stop_reason", reason: "end_turn" },
      ],
    ]);
    const opts = makeOpts(provider);
    await runTurn(opts);

    // The final provider call must offer NO tools.
    const provCalls = provider.streamWithTools.mock.calls as unknown as Array<
      [{ tools: unknown[] }]
    >;
    const lastArgs = provCalls[provCalls.length - 1][0];
    expect(lastArgs.tools).toEqual([]);
    // And the model produced a closing text summary.
    const msgs = opts._spies.onMessage.mock.calls.map((c) => c[0] as Message);
    const assts = msgs.filter((m) => m.role === "assistant") as AssistantMessage[];
    const lastAsst = assts[assts.length - 1];
    expect(
      lastAsst.blocks.some((b) => b.type === "text" && b.text.includes("总结")),
    ).toBe(true);
  });

  it("unknown tool name → ToolMessage(error) with 'Unknown tool'", async () => {
    // Don't register anything.
    const provider = mockProvider([
      [
        { type: "tool_call_start", callId: "c1", name: "nope" },
        { type: "tool_call_args", callId: "c1", deltaJson: "{}" },
        { type: "tool_call_end", callId: "c1" },
        { type: "stop_reason", reason: "tool_use" },
      ],
      [
        { type: "text", delta: "sorry" },
        { type: "stop_reason", reason: "end_turn" },
      ],
    ]);
    const opts = makeOpts(provider);
    await runTurn(opts);

    const calls = opts._spies.onMessage.mock.calls.map((c) => c[0] as Message);
    const tool = calls.find((m) => m.role === "tool") as ToolMessage;
    expect(tool.status).toBe("error");
    expect(tool.errorMessage).toContain("Unknown tool: nope");
  });

  it("schema validation fail → ToolMessage(error) with 'Invalid args for'", async () => {
    TOOLS.push(
      noopTool("strict", {
        parameters: {
          type: "object",
          properties: { foo: { type: "string" } },
          required: ["foo"],
          additionalProperties: false,
        } as never,
      }),
    );
    const provider = mockProvider([
      [
        { type: "tool_call_start", callId: "c1", name: "strict" },
        { type: "tool_call_args", callId: "c1", deltaJson: "{}" }, // missing required 'foo'
        { type: "tool_call_end", callId: "c1" },
        { type: "stop_reason", reason: "tool_use" },
      ],
      [
        { type: "text", delta: "fix" },
        { type: "stop_reason", reason: "end_turn" },
      ],
    ]);
    const opts = makeOpts(provider);
    await runTurn(opts);

    const calls = opts._spies.onMessage.mock.calls.map((c) => c[0] as Message);
    const tool = calls.find((m) => m.role === "tool") as ToolMessage;
    expect(tool.status).toBe("error");
    expect(tool.errorMessage).toMatch(/^Invalid args for strict/);
  });

  it("mid-stream abort → assistant stopReason='cancelled'", async () => {
    const ctrl = new AbortController();
    // Provider yields one text chunk, then we abort, then it tries to yield
    // another (which the loop should bail on).
    const provider = {
      streamWithTools: vi.fn(async function* (): AsyncGenerator<AgentEvent> {
        yield { type: "text", delta: "first" };
        ctrl.abort();
        yield { type: "text", delta: "second" };
        yield { type: "stop_reason", reason: "end_turn" };
      }),
    };
    const opts = makeOpts(provider, { signal: ctrl.signal });
    await runTurn(opts);

    const calls = opts._spies.onMessage.mock.calls.map((c) => c[0] as Message);
    // user + assistant(cancelled)
    expect(calls).toHaveLength(2);
    const asm = calls[1] as AssistantMessage;
    expect(asm.stopReason).toBe("cancelled");
    // The first text chunk was already accumulated before abort.
    expect(asm.blocks).toEqual([{ type: "text", text: "first" }]);
  });

  it("MID confirm = no_user_clicked → cancelled tool msg, continues to next call", async () => {
    TOOLS.push(noopTool("midtool", { riskTier: "MID" }));
    TOOLS.push(noopTool("nexttool", { riskTier: "LOW" }));
    const provider = mockProvider([
      [
        { type: "tool_call_start", callId: "c1", name: "midtool" },
        { type: "tool_call_args", callId: "c1", deltaJson: "{}" },
        { type: "tool_call_end", callId: "c1" },
        { type: "tool_call_start", callId: "c2", name: "nexttool" },
        { type: "tool_call_args", callId: "c2", deltaJson: "{}" },
        { type: "tool_call_end", callId: "c2" },
        { type: "stop_reason", reason: "tool_use" },
      ],
      [
        { type: "text", delta: "ok" },
        { type: "stop_reason", reason: "end_turn" },
      ],
    ]);
    const confirm = vi.fn(async () => "no_user_clicked");
    const opts = makeOpts(provider, { confirm });
    await runTurn(opts);

    const calls = opts._spies.onMessage.mock.calls.map((c) => c[0] as Message);
    const toolMsgs = calls.filter((m) => m.role === "tool") as ToolMessage[];
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0].status).toBe("cancelled_by_user");
    expect(toolMsgs[0].confirmDecision).toBe("inline_no");
    expect(toolMsgs[0].callId).toBe("c1");
    expect(toolMsgs[1].status).toBe("ok");
    expect(toolMsgs[1].callId).toBe("c2");
    // Second provider iteration runs after cancel + success
    expect(provider.streamWithTools).toHaveBeenCalledTimes(2);
  });

  it("MID confirm = no_panel_closed → cancelled tool msg, WHOLE turn ends", async () => {
    TOOLS.push(noopTool("midtool", { riskTier: "MID" }));
    TOOLS.push(noopTool("nexttool", { riskTier: "LOW" }));
    const provider = mockProvider([
      [
        { type: "tool_call_start", callId: "c1", name: "midtool" },
        { type: "tool_call_args", callId: "c1", deltaJson: "{}" },
        { type: "tool_call_end", callId: "c1" },
        { type: "tool_call_start", callId: "c2", name: "nexttool" },
        { type: "tool_call_args", callId: "c2", deltaJson: "{}" },
        { type: "tool_call_end", callId: "c2" },
        { type: "stop_reason", reason: "tool_use" },
      ],
      // If the runtime keeps going, this batch would be consumed. We assert it isn't.
      [{ type: "text", delta: "should-not-emit" }, { type: "stop_reason", reason: "end_turn" }],
    ]);
    const confirm = vi.fn(async () => "no_panel_closed");
    const opts = makeOpts(provider, { confirm });
    await runTurn(opts);

    const calls = opts._spies.onMessage.mock.calls.map((c) => c[0] as Message);
    const toolMsgs = calls.filter((m) => m.role === "tool") as ToolMessage[];
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].status).toBe("cancelled_by_user");
    expect(toolMsgs[0].confirmDecision).toBe("panel_closed");
    expect(toolMsgs[0].callId).toBe("c1");
    // Provider was NOT re-invoked for the second iteration.
    expect(provider.streamWithTools).toHaveBeenCalledTimes(1);
    // The second tool_call (c2) was NEVER processed.
    expect(toolMsgs.find((t) => t.callId === "c2")).toBeUndefined();
  });
});
