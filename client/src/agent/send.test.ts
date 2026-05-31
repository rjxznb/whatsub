// src/agent/send.test.ts
//
// Unit tests for the sendAgentMessage helper. runTurn is mocked so no real
// LLM calls are made. The stores/settings are seeded minimally.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendAgentMessage } from "./send";
import { useAgent } from "../store/agent";
import { useSettings } from "../store/settings";
import { DEFAULT_SETTINGS } from "../types/settings";
import type { Message } from "../types/agent";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("./runtime", () => ({
  runTurn: vi.fn(),
}));

vi.mock("../llm/providers", () => ({
  getProvider: vi.fn(() => ({
    streamWithTools: vi.fn(),
    stream: vi.fn(),
  })),
}));

// Tauri invoke used by useAgent._persistNow — no-op it.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

import { runTurn } from "./runtime";
const mockedRunTurn = runTurn as ReturnType<typeof vi.fn>;

/**
 * Sets up mockedRunTurn so that when it's called it fires `onMessage` with a
 * fake assistant message containing the given text, then resolves.
 */
function mockRunTurnWithReply(replyText: string) {
  mockedRunTurn.mockImplementation(
    async (opts: { onMessage: (m: Message) => void; userMessage: Message }) => {
      // Emit the user message first (matching real runTurn behaviour).
      opts.onMessage(opts.userMessage);
      // Emit a fake assistant reply.
      opts.onMessage({
        role: "assistant",
        id: "a_test_1",
        ts: Date.now(),
        blocks: [{ type: "text", text: replyText }],
        stopReason: "end_turn",
        vendor: "deepseek",
        model: "deepseek-chat",
      });
    },
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Reset agent store.
  useAgent.setState({
    history: { version: 1, activeConversationId: null, conversations: [] },
    hydrated: true,
  });
  // Provide a minimal settings so getModelName / getVendorKey don't throw.
  useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sendAgentMessage", () => {
  it("returns the assistant text reply from the last assistant message", async () => {
    mockRunTurnWithReply("你好，有什么需要帮助的吗？");
    const result = await sendAgentMessage("你好");
    expect(result).toBe("你好，有什么需要帮助的吗？");
  });

  it("lazy-creates a conversation when none is active", async () => {
    mockRunTurnWithReply("Hi there!");
    expect(useAgent.getState().history.activeConversationId).toBeNull();
    await sendAgentMessage("hi");
    const id = useAgent.getState().history.activeConversationId;
    expect(id).not.toBeNull();
    const conv = useAgent.getState().history.conversations.find((c) => c.id === id);
    expect(conv).toBeTruthy();
  });

  it("reuses an existing active conversation", async () => {
    // Pre-create a conversation.
    const existingId = useAgent.getState().createConversation({ pathname: "/" });
    mockRunTurnWithReply("Got it.");
    await sendAgentMessage("hello again");
    // Still the same conversation.
    expect(useAgent.getState().history.activeConversationId).toBe(existingId);
    const convs = useAgent.getState().history.conversations;
    expect(convs).toHaveLength(1);
  });

  it("fires onAssistantMessage callback for each message runTurn emits", async () => {
    mockRunTurnWithReply("Reply text");
    const received: Message[] = [];
    await sendAgentMessage("test", {
      onAssistantMessage: (m) => received.push(m),
    });
    // Should have received the user message + the assistant message.
    expect(received.length).toBeGreaterThanOrEqual(1);
    const assistantMsgs = received.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
  });

  it("uses provided confirm callback instead of default confirmViaUI", async () => {
    mockRunTurnWithReply("ok");
    const customConfirm = vi.fn().mockResolvedValue("yes");
    await sendAgentMessage("confirm test", { confirm: customConfirm });
    // runTurn receives the confirm option.
    const callOpts = mockedRunTurn.mock.calls[0][0] as { confirm: unknown };
    expect(callOpts.confirm).toBe(customConfirm);
  });

  it("returns empty string when runTurn adds no assistant message", async () => {
    // runTurn fires only the user message.
    mockedRunTurn.mockImplementation(
      async (opts: { onMessage: (m: Message) => void; userMessage: Message }) => {
        opts.onMessage(opts.userMessage);
        // No assistant message emitted.
      },
    );
    const result = await sendAgentMessage("ghost turn");
    expect(result).toBe("");
  });
});
