import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentHistory,
  Conversation,
  Message,
  PageSnapshot,
  UserMessage,
} from "../types/agent";

function genId(): string {
  // No UUID crate dep — mirrors core/ids.rs philosophy (sha-like trivial id).
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

interface AgentStore {
  history: AgentHistory;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  createConversation: (pageContext: PageSnapshot) => string;
  switchActive: (conversationId: string) => void;
  addMessage: (conversationId: string, msg: Message) => void;
  deleteConversation: (conversationId: string) => void;
  clearAll: () => void;
  pruneEmptyConversations: () => void;
  exportHistory: () => string;
  /** Persistence — debounced via runtime; this method does the actual write. */
  _persistNow: () => Promise<void>;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

export const useAgent = create<AgentStore>((set, get) => ({
  history: { version: 1, activeConversationId: null, conversations: [] },
  hydrated: false,

  async hydrate() {
    try {
      const loaded = await invoke<AgentHistory>("agent_history_load");
      set({ history: loaded, hydrated: true });
    } catch (err) {
      console.warn("[agent] hydrate failed (using default):", err);
      set({ hydrated: true });
    }
  },

  createConversation(pageContext) {
    const id = genId();
    const now = Date.now();
    const conv: Conversation = {
      id,
      title: "新对话",
      createdAt: now,
      updatedAt: now,
      pageContextAtStart: pageContext,
      summaryUpToMsgId: null,
      summary: null,
      messages: [],
    };
    set((s) => ({
      history: {
        ...s.history,
        activeConversationId: id,
        conversations: [conv, ...s.history.conversations],
      },
    }));
    schedulePersist(get);
    return id;
  },

  switchActive(conversationId) {
    set((s) => ({
      history: { ...s.history, activeConversationId: conversationId },
    }));
    schedulePersist(get);
  },

  addMessage(conversationId, msg) {
    set((s) => ({
      history: {
        ...s.history,
        conversations: s.history.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          const messages = [...c.messages, msg];
          // Title from first user message (only when still default "新对话")
          let title = c.title;
          if (title === "新对话" && msg.role === "user") {
            const content = (msg as UserMessage).content.trim();
            if (content.length > 0) {
              title = content.slice(0, 30);
            }
          }
          return {
            ...c,
            messages,
            updatedAt: Math.max(c.updatedAt, msg.ts),
            title,
          };
        }),
      },
    }));
    schedulePersist(get);
  },

  deleteConversation(conversationId) {
    set((s) => {
      const next = s.history.conversations.filter(
        (c) => c.id !== conversationId,
      );
      const active =
        s.history.activeConversationId === conversationId
          ? next[0]?.id ?? null
          : s.history.activeConversationId;
      return {
        history: {
          ...s.history,
          conversations: next,
          activeConversationId: active,
        },
      };
    });
    schedulePersist(get);
  },

  clearAll() {
    set({
      history: { version: 1, activeConversationId: null, conversations: [] },
    });
    schedulePersist(get);
  },

  pruneEmptyConversations() {
    set((s) => {
      const survivors = s.history.conversations.filter(
        (c) => c.messages.length > 0,
      );
      const stillActive = survivors.some(
        (c) => c.id === s.history.activeConversationId,
      );
      return {
        history: {
          ...s.history,
          conversations: survivors,
          activeConversationId: stillActive
            ? s.history.activeConversationId
            : null,
        },
      };
    });
    schedulePersist(get);
  },

  exportHistory() {
    return JSON.stringify(get().history, null, 2);
  },

  async _persistNow() {
    try {
      await invoke("agent_history_save", { history: get().history });
    } catch (err) {
      console.warn("[agent] save failed:", err);
    }
  },
}));

function schedulePersist(get: () => AgentStore) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void get()._persistNow();
    persistTimer = null;
  }, 500);
}
