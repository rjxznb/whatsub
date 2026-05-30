import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageList } from "./MessageList";
import { useAgent } from "../../store/agent";
import type {
  AssistantMessage,
  Conversation,
  ToolMessage,
  UserMessage,
} from "../../types/agent";

beforeEach(() => {
  useAgent.setState({
    history: { version: 1, activeConversationId: null, conversations: [] },
    hydrated: true,
  });
});

function seedConversation(messages: Conversation["messages"]): string {
  const conv: Conversation = {
    id: "c1",
    title: "Test convo",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    pageContextAtStart: { pathname: "/library" },
    summaryUpToMsgId: null,
    summary: null,
    messages,
  };
  useAgent.setState({
    history: {
      version: 1,
      activeConversationId: "c1",
      conversations: [conv],
    },
    hydrated: true,
  });
  return conv.id;
}

const userMsg: UserMessage = {
  role: "user",
  id: "u1",
  ts: 1700000000001,
  content: "Hello agent",
};

const assistantMsg: AssistantMessage = {
  role: "assistant",
  id: "a1",
  ts: 1700000000002,
  blocks: [{ type: "text", text: "Hello user" }],
  stopReason: "end_turn",
  vendor: "deepseek",
  model: "deepseek-chat",
};

const toolMsg: ToolMessage = {
  role: "tool",
  id: "t1",
  ts: 1700000000003,
  callId: "tc_1",
  name: "search_vocabulary",
  status: "ok",
  result: { items: [] },
  durationMs: 42,
};

describe("MessageList", () => {
  it("renders nothing when there is no active conversation", () => {
    const { container } = render(<MessageList />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the active conversation has 0 messages", () => {
    seedConversation([]);
    const { container } = render(<MessageList />);
    expect(container.firstChild).toBeNull();
  });

  it("renders user + assistant bubbles in order", () => {
    seedConversation([userMsg, assistantMsg]);
    const { container } = render(<MessageList />);
    expect(screen.getByText("Hello agent")).toBeTruthy();
    expect(screen.getByText("Hello user")).toBeTruthy();
    // Ordering: user bubble (justify-end) appears before assistant row in DOM.
    // The assistant row uses a Bot-avatar + flat-text layout (no
    // justify-start wrapper since the 2026-05-30 redesign).
    const scroller = container.firstElementChild as HTMLElement;
    const children = Array.from(scroller.children) as HTMLElement[];
    expect(children[0].className).toContain("justify-end");
    // Sanity-check the assistant row is left-aligned: no justify-end class.
    expect(children[1].className).not.toContain("justify-end");
  });

  it("skips tool messages (does NOT render them as standalone bubbles)", () => {
    seedConversation([userMsg, assistantMsg, toolMsg]);
    const { container } = render(<MessageList />);
    // Tool message name should NOT appear because tool messages are skipped.
    expect(screen.queryByText(/search_vocabulary/)).toBeNull();
    // Only 2 direct rendered children (user + assistant), tool slot is `null`.
    const scroller = container.firstElementChild as HTMLElement;
    // React fragments are not present; null returns produce no DOM nodes.
    expect(scroller.children.length).toBe(2);
  });

  it("passes streamingMsgId through to the matching assistant bubble", () => {
    seedConversation([userMsg, assistantMsg]);
    const { container } = render(<MessageList streamingMsgId="a1" />);
    // The streaming cursor should be present on the assistant bubble.
    const cursor = container.querySelector(".animate-pulse");
    expect(cursor).toBeTruthy();
  });

  it("does NOT show streaming cursor when streamingMsgId mismatches", () => {
    seedConversation([userMsg, assistantMsg]);
    const { container } = render(<MessageList streamingMsgId="some-other-id" />);
    const cursor = container.querySelector(".animate-pulse");
    expect(cursor).toBeNull();
  });
});
