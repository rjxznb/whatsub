import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolCallCard } from "./ToolCallCard";
import { useAgent } from "../../store/agent";
import type {
  AssistantBlock,
  Conversation,
  ToolMessage,
} from "../../types/agent";

// Mock the tool registry so we don't depend on the concrete tool set.
vi.mock("../../agent/registry", () => ({
  getTool: vi.fn((id: string) => ({
    id,
    description: "",
    parameters: {} as never,
    riskTier: "LOW" as const,
    availableOn: () => true,
    runningLabel: `running ${id}`,
    doneLabel: (r: unknown) => `done ${id} (${JSON.stringify(r)})`,
    execute: async () => null,
  })),
}));

const callBlock: Extract<AssistantBlock, { type: "tool_call" }> = {
  type: "tool_call",
  callId: "tc_1",
  name: "list_library",
  args: { limit: 5 },
};

function seedConversation(messages: Conversation["messages"]) {
  const conv: Conversation = {
    id: "c1",
    title: "t",
    createdAt: 0,
    updatedAt: 0,
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
}

beforeEach(() => {
  useAgent.setState({
    history: { version: 1, activeConversationId: null, conversations: [] },
    hydrated: true,
  });
});

describe("ToolCallCard", () => {
  it("queued state (no ToolMessage, parentStreaming=false): shows 准备调用 + tool name", () => {
    seedConversation([]);
    render(<ToolCallCard callBlock={callBlock} parentStreaming={false} />);
    expect(screen.getByText(/准备调用/)).toBeTruthy();
    expect(screen.getByText(/list_library/)).toBeTruthy();
  });

  it("running state (no ToolMessage, parentStreaming=true): shows runningLabel with spinner", () => {
    seedConversation([]);
    const { container } = render(
      <ToolCallCard callBlock={callBlock} parentStreaming />,
    );
    expect(screen.getByText(/running list_library/)).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("done OK: shows doneLabel folded by default, click expands", () => {
    const okTool: ToolMessage = {
      role: "tool",
      id: "t1",
      ts: 0,
      callId: "tc_1",
      name: "list_library",
      status: "ok",
      result: { items: [{ id: "v1" }] },
      durationMs: 123,
    };
    seedConversation([okTool]);
    render(<ToolCallCard callBlock={callBlock} />);

    // Folded by default: doneLabel visible, no Args/Result yet.
    const trigger = screen.getByText(/done list_library/);
    expect(trigger).toBeTruthy();
    expect(screen.queryByText(/Args:/)).toBeNull();
    expect(screen.queryByText(/Result:/)).toBeNull();

    // Click the toggle button (the closest button parent of the trigger).
    const btn = trigger.closest("button")!;
    fireEvent.click(btn);

    // Expanded: Args + Result + duration row visible.
    expect(screen.getByText(/Args:/)).toBeTruthy();
    expect(screen.getByText(/Result:/)).toBeTruthy();
    expect(screen.getByText(/123ms/)).toBeTruthy();
  });

  it("error state: shows ✗ failed + errorMessage + details toggle", () => {
    const errTool: ToolMessage = {
      role: "tool",
      id: "t1",
      ts: 0,
      callId: "tc_1",
      name: "list_library",
      status: "error",
      errorMessage: "Disk full",
      durationMs: 5,
    };
    seedConversation([errTool]);
    render(<ToolCallCard callBlock={callBlock} />);

    expect(screen.getByText(/list_library 失败/)).toBeTruthy();
    expect(screen.getByText(/Disk full/)).toBeTruthy();
    // Error state is expanded by default (initiallyExpanded=true). The toggle
    // therefore reads "收起" rather than "详情".
    expect(screen.getByRole("button", { name: /收起/ })).toBeTruthy();
  });

  it("error state with no errorMessage falls back to (unknown error)", () => {
    const errTool: ToolMessage = {
      role: "tool",
      id: "t1",
      ts: 0,
      callId: "tc_1",
      name: "list_library",
      status: "error",
      durationMs: 5,
    };
    seedConversation([errTool]);
    render(<ToolCallCard callBlock={callBlock} />);
    expect(screen.getByText(/\(unknown error\)/)).toBeTruthy();
  });

  it("cancelled_by_user: shows ⊘ 已取消", () => {
    const cxlTool: ToolMessage = {
      role: "tool",
      id: "t1",
      ts: 0,
      callId: "tc_1",
      name: "list_library",
      status: "cancelled_by_user",
      durationMs: 0,
    };
    seedConversation([cxlTool]);
    render(<ToolCallCard callBlock={callBlock} />);
    expect(screen.getByText(/已取消/)).toBeTruthy();
  });

  it("matches by callId, not by name (unrelated ToolMessage with same name is ignored)", () => {
    const unrelated: ToolMessage = {
      role: "tool",
      id: "t1",
      ts: 0,
      callId: "tc_99",  // different callId
      name: "list_library",
      status: "ok",
      result: {},
      durationMs: 1,
    };
    seedConversation([unrelated]);
    render(<ToolCallCard callBlock={callBlock} parentStreaming={false} />);
    // Should render queued state, NOT done state.
    expect(screen.getByText(/准备调用/)).toBeTruthy();
    expect(screen.queryByText(/done list_library/)).toBeNull();
  });
});
