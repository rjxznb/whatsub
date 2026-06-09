import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  modelContextBudget,
  prepareWireHistory,
  TOOL_RESULT_TRIM_CHARS,
} from "./history";
import type { Message, ToolMessage, UserMessage, AssistantMessage } from "../types/agent";

const user = (content: string, id = "u"): UserMessage => ({
  role: "user",
  id,
  ts: 0,
  content,
});

const assistant = (text: string, id = "a"): AssistantMessage => ({
  role: "assistant",
  id,
  ts: 0,
  blocks: [{ type: "text", text }],
  stopReason: "end_turn",
  vendor: "deepseek",
  model: "deepseek-v4-flash",
});

const toolOk = (name: string, result: unknown, id = "t"): ToolMessage => ({
  role: "tool",
  id,
  ts: 0,
  callId: "c",
  name,
  status: "ok",
  result,
  durationMs: 1,
});

describe("estimateTokens", () => {
  it("counts CJK ~1/char and latin ~1/4 chars", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("modelContextBudget", () => {
  it("DeepSeek/Gemini get ~1M, Claude ~200k, unknown 128k — with headroom", () => {
    expect(modelContextBudget("deepseek-v4-flash")).toBe(Math.floor(1_000_000 * 0.85));
    expect(modelContextBudget("gemini-2.0-flash")).toBe(Math.floor(1_000_000 * 0.85));
    expect(modelContextBudget("claude-3-5-sonnet")).toBe(Math.floor(200_000 * 0.85));
    expect(modelContextBudget("some-unknown-model")).toBe(Math.floor(128_000 * 0.85));
  });
});

describe("prepareWireHistory — #3 trim past-turn tool results", () => {
  const big = { hits: Array.from({ length: 50 }, (_, i) => ({ i, blah: "x".repeat(40) })) };

  it("folds a large tool result from a PAST turn but keeps current-turn ones", () => {
    const msgs: Message[] = [
      user("找视频", "u1"),
      assistant("好的", "a1"),
      toolOk("youtube_search", big, "t1"), // past turn (before u2)
      user("再找一个", "u2"),
      assistant("好", "a2"),
      toolOk("youtube_search", big, "t2"), // current turn (after last user)
    ];
    const out = prepareWireHistory(msgs, 10_000_000);
    const past = out.find((m) => m.role === "tool" && (m as ToolMessage).id === "t1") as ToolMessage;
    const cur = out.find((m) => m.role === "tool" && (m as ToolMessage).id === "t2") as ToolMessage;
    expect(typeof past.result).toBe("string");
    expect(past.result as string).toContain("已折叠");
    expect(cur.result).toEqual(big); // untouched
  });

  it("does not mutate the input messages", () => {
    const msgs: Message[] = [user("x", "u1"), toolOk("t", big, "t1"), user("y", "u2")];
    const snapshot = JSON.stringify(msgs);
    prepareWireHistory(msgs, 10_000_000);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  it("leaves small tool results alone", () => {
    const small = { ok: true };
    expect(JSON.stringify(small).length).toBeLessThan(TOOL_RESULT_TRIM_CHARS);
    const msgs: Message[] = [user("x", "u1"), toolOk("t", small, "t1"), user("y", "u2")];
    const out = prepareWireHistory(msgs, 10_000_000);
    const t = out.find((m) => m.role === "tool") as ToolMessage;
    expect(t.result).toEqual(small);
  });
});

describe("prepareWireHistory — #2 answer dangling tool_calls", () => {
  const assistantCall = (
    callId: string,
    name: string,
    id = "a",
  ): AssistantMessage => ({
    role: "assistant",
    id,
    ts: 0,
    blocks: [{ type: "tool_call", callId, name, args: {} }],
    stopReason: "tool_use",
    vendor: "deepseek",
    model: "deepseek-v4-flash",
  });

  it("synthesizes an error tool result for a tool_call left unanswered (hung/aborted)", () => {
    const msgs: Message[] = [
      user("在 YouTube 上搜索 NBA", "u1"),
      assistantCall("call_1", "youtube_search", "a1"), // tool hung → no result
      user("你怎么了", "u2"),
    ];
    const out = prepareWireHistory(msgs, 10_000_000);
    // A tool message answering call_1 must exist, right after the assistant.
    const aIdx = out.findIndex((m) => m.id === "a1");
    const next = out[aIdx + 1] as ToolMessage;
    expect(next.role).toBe("tool");
    expect(next.callId).toBe("call_1");
    expect(next.status).toBe("error");
    // Original user follow-up is preserved and still last.
    expect(out[out.length - 1].id).toBe("u2");
  });

  it("does NOT add a synthetic result when the tool_call already has one", () => {
    const answered: ToolMessage = {
      role: "tool",
      id: "t1",
      ts: 0,
      callId: "call_1",
      name: "youtube_search",
      status: "ok",
      result: { hits: [] },
      durationMs: 1,
    };
    const msgs: Message[] = [
      user("搜一下", "u1"),
      assistantCall("call_1", "youtube_search", "a1"),
      answered,
    ];
    const out = prepareWireHistory(msgs, 10_000_000);
    const toolMsgs = out.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1); // no synthetic added
    expect((toolMsgs[0] as ToolMessage).id).toBe("t1");
  });
});

describe("prepareWireHistory — #1 token budget", () => {
  it("drops oldest messages when over budget, keeps the latest", () => {
    const msgs: Message[] = [
      user("一".repeat(100), "u1"),
      user("二".repeat(100), "u2"),
      user("三".repeat(100), "u3"),
    ];
    // budget only fits ~the last message (100 + overhead).
    const out = prepareWireHistory(msgs, 110);
    expect(out.length).toBeLessThan(3);
    expect(out[out.length - 1].id).toBe("u3");
  });

  it("strips a leading orphan tool message after truncation", () => {
    const msgs: Message[] = [
      user("旧".repeat(200), "u1"),
      assistant("旧回复".repeat(50), "a1"),
      toolOk("t", { x: "y".repeat(50) }, "t1"),
      user("新问题", "u2"),
    ];
    const out = prepareWireHistory(msgs, 40);
    expect(out[0].role).not.toBe("tool");
    expect(out[out.length - 1].id).toBe("u2");
  });

  it("returns everything when under budget", () => {
    const msgs: Message[] = [user("hi", "u1"), assistant("hello", "a1")];
    expect(prepareWireHistory(msgs, 1_000_000)).toHaveLength(2);
  });
});
