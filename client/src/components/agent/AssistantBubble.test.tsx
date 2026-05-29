import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AssistantBubble } from "./AssistantBubble";
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
});
