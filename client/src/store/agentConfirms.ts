// src/store/agentConfirms.ts
//
// Bridges the agent runtime's `opts.confirm` Promise contract (see
// `runtime.ts::RunTurnOpts.confirm`) with the chat-panel UI.
//
// - MID-risk tools: a PendingConfirm is pushed into this store; the
//   InlineConfirmCard renders 确认/取消 buttons; clicking calls
//   `resolveOne(id, decision)` which resolves the awaiting Promise.
// - HIGH-risk tools: a Tauri @tauri-apps/plugin-dialog system confirm is
//   awaited directly (no store entry). `window.confirm` is unreliable in
//   the Tauri v2 webview per CLAUDE.md.
// - Panel close: ChatPanel calls `rejectAllPanelClosed()` which resolves
//   every pending Promise with "no_panel_closed" so the runtime finalizes
//   the turn with cancelled_by_user (confirmDecision="panel_closed").

import { create } from "zustand";
import type { ToolDef } from "../agent/types";
import type { ConfirmDecision } from "../agent/runtime";

export type { ConfirmDecision };

export interface PendingConfirm {
  id: string;
  toolDef: ToolDef;
  args: unknown;
  tier: "MID" | "HIGH";
  resolve: (decision: ConfirmDecision) => void;
}

interface AgentConfirmsStore {
  pending: PendingConfirm[];
  push: (c: PendingConfirm) => void;
  resolveOne: (id: string, decision: ConfirmDecision) => void;
  /** Resolve all pending with "no_panel_closed". Called when panel closes. */
  rejectAllPanelClosed: () => void;
}

let _nextId = 0;
function genConfirmId(): string {
  _nextId += 1;
  return `confirm_${Date.now()}_${_nextId}`;
}

export const useAgentConfirms = create<AgentConfirmsStore>((set, get) => ({
  pending: [],
  push(c) {
    set((s) => ({ pending: [...s.pending, c] }));
  },
  resolveOne(id, decision) {
    const entry = get().pending.find((p) => p.id === id);
    if (!entry) return;
    entry.resolve(decision);
    set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
  },
  rejectAllPanelClosed() {
    const all = get().pending;
    for (const e of all) e.resolve("no_panel_closed");
    set({ pending: [] });
  },
}));

/**
 * Wrapper for the runtime's `confirm` callback. Pushes a pending confirm and
 * awaits the resulting Promise. For HIGH-risk tools, uses the Tauri system
 * dialog (a separate modal); for MID-risk tools, pushes to the store so
 * InlineConfirmCard can render the prompt inline in the chat thread.
 */
export async function confirmViaUI(
  toolDef: ToolDef,
  args: unknown,
  tier: "MID" | "HIGH",
): Promise<ConfirmDecision> {
  if (tier === "HIGH") {
    // window.confirm is unreliable in Tauri v2 webview — use plugin-dialog.
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    try {
      const ok = await confirm(
        `AI 助手要执行 ${toolDef.id}\n\n${summarizeArgsForDisplay(toolDef.id, args)}`,
        {
          title: "需要确认",
          okLabel: "执行",
          cancelLabel: "取消",
          kind: "warning",
        },
      );
      return ok ? "yes" : "no_user_clicked";
    } catch (e) {
      console.warn("[agentConfirms] HIGH confirm failed:", e);
      return "no_user_clicked";
    }
  }
  // MID: push to store and await user click via InlineConfirmCard.
  return new Promise((resolve) => {
    useAgentConfirms.getState().push({
      id: genConfirmId(),
      toolDef,
      args,
      tier,
      resolve,
    });
  });
}

/**
 * Generic args summary for display in confirmation prompts. Tools may
 * override via a future `confirmSummary` field (deferred). For now: pretty
 * JSON, falling back to String() on circular refs etc.
 */
export function summarizeArgsForDisplay(_toolId: string, args: unknown): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
