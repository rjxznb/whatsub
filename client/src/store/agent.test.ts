import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAgent } from "./agent";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  useAgent.setState({
    history: { version: 1, activeConversationId: null, conversations: [] },
    hydrated: true, // bypass hydration in tests
  });
});

describe("useAgent CRUD", () => {
  it("createConversation makes + activates it", () => {
    const id = useAgent.getState().createConversation({ pathname: "/library" });
    expect(useAgent.getState().history.activeConversationId).toBe(id);
    expect(useAgent.getState().history.conversations).toHaveLength(1);
  });

  it("addUserMessage appends + bumps updatedAt", () => {
    const id = useAgent.getState().createConversation({ pathname: "/library" });
    useAgent.getState().addMessage(id, {
      role: "user",
      id: "m1",
      ts: 100,
      content: "hi",
    });
    const conv = useAgent.getState().history.conversations.find((c) => c.id === id)!;
    expect(conv.messages).toHaveLength(1);
    expect(conv.updatedAt).toBeGreaterThanOrEqual(100);
  });

  it("first user message becomes the conversation title (30 char cap)", () => {
    const id = useAgent.getState().createConversation({ pathname: "/library" });
    useAgent.getState().addMessage(id, {
      role: "user",
      id: "m1",
      ts: 100,
      content: "this is a fairly long user prompt that should be truncated",
    });
    const conv = useAgent.getState().history.conversations.find((c) => c.id === id)!;
    expect(conv.title.length).toBeLessThanOrEqual(30);
    expect(conv.title).not.toBe("新对话");
  });

  it("switchActive flips activeConversationId", () => {
    const a = useAgent.getState().createConversation({ pathname: "/library" });
    const b = useAgent.getState().createConversation({ pathname: "/library" });
    useAgent.getState().switchActive(a);
    expect(useAgent.getState().history.activeConversationId).toBe(a);
    useAgent.getState().switchActive(b);
    expect(useAgent.getState().history.activeConversationId).toBe(b);
  });

  it("deleteConversation removes + handles active resync", () => {
    const a = useAgent.getState().createConversation({ pathname: "/library" });
    const b = useAgent.getState().createConversation({ pathname: "/library" });
    useAgent.getState().switchActive(a);
    useAgent.getState().deleteConversation(a);
    expect(useAgent.getState().history.conversations).toHaveLength(1);
    expect(useAgent.getState().history.activeConversationId).toBe(b); // fallback to remaining
  });

  it("clearAll wipes everything + nulls active", () => {
    useAgent.getState().createConversation({ pathname: "/library" });
    useAgent.getState().createConversation({ pathname: "/library" });
    useAgent.getState().clearAll();
    expect(useAgent.getState().history.conversations).toHaveLength(0);
    expect(useAgent.getState().history.activeConversationId).toBeNull();
  });

  it("empty conversation auto-deletes via pruneEmptyConversations", () => {
    const id = useAgent.getState().createConversation({ pathname: "/library" });
    useAgent.getState().pruneEmptyConversations();
    expect(
      useAgent.getState().history.conversations.find((c) => c.id === id),
    ).toBeUndefined();
  });
});
