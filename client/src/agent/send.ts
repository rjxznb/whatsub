// src/agent/send.ts
//
// Reusable, UI-agnostic core for sending a message to the active agent
// conversation and running a full ReAct turn. Both the text ChatBar (AgentRoot)
// and the voice loop (voiceConversation) call this function.
//
// Consumers supply side-effect callbacks via SendAgentOpts; the function itself
// owns the store/settings reads, conversation lazy-creation, and runTurn call.

import { useAgent } from "../store/agent";
import { useSettings } from "../store/settings";
import { runTurn } from "./runtime";
import { getProvider } from "../llm/providers";
import { getVendorKey, getModelName } from "../llm/llmIdentity";
import { confirmViaUI } from "../store/agentConfirms";
import type { Message, UserMessage, AssistantMessage } from "../types/agent";
import type { ConfirmDecision } from "./runtime";
import type { ToolDef } from "./types";

export interface SendAgentOpts {
  /** Fires for every finalized message (user, assistant, tool). */
  onAssistantMessage?: (m: Message) => void;
  /** Fires on every text delta inside an assistant message. */
  onTextDelta?: (msgId: string, delta: string) => void;
  /** Override the confirm callback. Defaults to confirmViaUI. */
  confirm?: (
    toolDef: ToolDef,
    args: unknown,
    tier: "MID" | "HIGH",
  ) => Promise<ConfirmDecision>;
  /** AbortSignal to cancel the turn. */
  signal?: AbortSignal;
}

/**
 * Send `text` to the active agent conversation, run the ReAct turn (tools +
 * page context), and resolve with the FINAL assistant text reply (the
 * concatenated text blocks of the last assistant message), or "" if none.
 *
 * Lazy-creates a conversation if none is active.
 * Reuses runTurn + useAgent store.
 */
export async function sendAgentMessage(
  text: string,
  opts?: SendAgentOpts,
): Promise<string> {
  const settings = useSettings.getState().settings;

  // Lazy-create the active conversation if there is none.
  let activeId = useAgent.getState().history.activeConversationId;
  if (
    !activeId ||
    !useAgent
      .getState()
      .history.conversations.find((c) => c.id === activeId)
  ) {
    const pathname =
      typeof window !== "undefined" ? window.location.pathname : "/";
    activeId = useAgent.getState().createConversation({ pathname });
  }

  const userMsg: UserMessage = {
    role: "user",
    id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    content: text,
  };

  // Build provider at send-time so model/key changes are picked up immediately.
  const provider = getProvider(settings) as unknown as Parameters<
    typeof runTurn
  >[0]["provider"];

  const ac = opts?.signal ? null : new AbortController();
  const signal = opts?.signal ?? ac!.signal;

  const pathname =
    typeof window !== "undefined" ? window.location.pathname : "/";

  try {
    await runTurn({
      history:
        useAgent
          .getState()
          .history.conversations.find((c) => c.id === activeId)
          ?.messages ?? [],
      userMessage: userMsg,
      provider,
      vendor: getVendorKey(settings),
      model: getModelName(settings),
      page: { pathname },
      signal,
      confirm: opts?.confirm ?? confirmViaUI,
      onMessage: (m: Message) => {
        useAgent.getState().addMessage(activeId!, m);
        opts?.onAssistantMessage?.(m);
      },
      onAssistantTextDelta: (msgId: string, delta: string) => {
        opts?.onTextDelta?.(msgId, delta);
      },
    });
  } catch (e) {
    // runTurn never throws on signal abort; a thrown error is unexpected.
    // eslint-disable-next-line no-console
    console.warn("[agent/send] runTurn error:", e);
  }

  // Find the last assistant message and concatenate its text blocks.
  const conv = useAgent
    .getState()
    .history.conversations.find((c) => c.id === activeId);
  if (!conv) return "";

  const msgs = conv.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "assistant") {
      const asst = m as AssistantMessage;
      return asst.blocks
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
    }
  }
  return "";
}
