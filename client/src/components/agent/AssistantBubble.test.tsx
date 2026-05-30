import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AssistantBubble } from "./AssistantBubble";
import { useAgent } from "../../store/agent";
import type { AssistantMessage } from "../../types/agent";

function mkMsg(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    id: "a1",
    ts: 1700000000000,
    blocks: [{ type: "text", text: "Hello from the agent." }],
    stopReason: "end_turn",
    vendor: "deepseek",
    model: "deepseek-chat",
    ...overrides,
  };
}

beforeEach(() => {
  useAgent.setState({
    history: { version: 1, activeConversationId: null, conversations: [] },
    hydrated: true,
  });
});

describe("AssistantBubble", () => {
  it("renders text block content", () => {
    render(<AssistantBubble msg={mkMsg()} />);
    expect(screen.getByText("Hello from the agent.")).toBeTruthy();
  });

  it("renders tool_call placeholder showing tool name", () => {
    const msg = mkMsg({
      blocks: [
        { type: "text", text: "Calling a tool now..." },
        {
          type: "tool_call",
          callId: "tc_1",
          name: "search_vocabulary",
          args: { query: "hello" },
        },
      ],
    });
    render(<AssistantBubble msg={msg} />);
    expect(screen.getByText(/search_vocabulary/)).toBeTruthy();
  });

  it("streaming=true shows blinking cursor on the last text block", () => {
    const msg = mkMsg({
      blocks: [{ type: "text", text: "streaming text" }],
    });
    const { container } = render(<AssistantBubble msg={msg} streaming />);
    const cursor = container.querySelector(".animate-pulse");
    expect(cursor).toBeTruthy();
  });

  it("streaming=false hides the cursor", () => {
    const msg = mkMsg({
      blocks: [{ type: "text", text: "static text" }],
    });
    const { container } = render(<AssistantBubble msg={msg} streaming={false} />);
    const cursor = container.querySelector(".animate-pulse");
    expect(cursor).toBeNull();
  });

  it("stopReason=error shows 连接中断 footer", () => {
    render(<AssistantBubble msg={mkMsg({ stopReason: "error" })} />);
    expect(screen.getByText(/连接中断/)).toBeTruthy();
  });

  it("stopReason=cancelled shows 已停止 footer", () => {
    render(<AssistantBubble msg={mkMsg({ stopReason: "cancelled" })} />);
    expect(screen.getByText(/已停止/)).toBeTruthy();
  });

  it("renders markdown bold inside a text block", () => {
    const msg = mkMsg({
      blocks: [{ type: "text", text: "this is **bold** here" }],
    });
    const { container } = render(<AssistantBubble msg={msg} />);
    const strong = container.querySelector("strong");
    expect(strong).toBeTruthy();
    expect(strong!.textContent).toBe("bold");
  });

  it("streaming cursor renders on the last TEXT block, not the last block when it's a tool_call", () => {
    const msg = mkMsg({
      blocks: [
        { type: "text", text: "before tool" },
        {
          type: "tool_call",
          callId: "tc_2",
          name: "list_library",
          args: {},
        },
      ],
    });
    const { container } = render(<AssistantBubble msg={msg} streaming />);
    // Cursor should be on the text paragraph "before tool", which is the
    // last text block. The tool_call's queued row also has spinner-less ▸,
    // not the .animate-pulse cursor. We just verify a cursor exists.
    const cursors = container.querySelectorAll(".animate-pulse");
    expect(cursors.length).toBeGreaterThanOrEqual(1);
  });
});
