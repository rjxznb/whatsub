// src/components/agent/AgentRoot.tsx
//
// Single composite that mounts the Spotlight-style ChatBar (UX revision
// 2026-05-30 — replaces the old ChatWidget+ChatPanel pattern) + wires the
// runtime entrypoint. App.tsx mounts <AgentRoot /> once inside the
// BrowserRouter so this component has access to useNavigate(); App.tsx itself
// only adds one import + one JSX line.
//
// Responsibilities (per Task 26 spec + Task 30 UX refactor):
//   1. Hydrate useAgent once on mount.
//   2. setNavigator(useNavigate()) so the nav tools (T15) can do
//      navigate("/library") without dragging React Router into agent core.
//   3. Own panelOpen (localStorage-persisted, same key as before for
//      backwards-compat — semantics now "expanded vs collapsed") + unread
//      flag + streaming msg id.
//   4. Own the AbortController for the in-flight turn. Bar collapse aborts +
//      rejects pending MID confirmations with "no_panel_closed"; stop button
//      aborts only.
//   5. Switch between MessageList+InlineConfirmList (has messages) and
//      EmptyState (no messages OR LLM not configured).
//   6. InputBox.onSend → ensures an active conversation exists → calls
//      runTurn(), threading runtime callbacks into useAgent.addMessage.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgent } from "../../store/agent";
import { useAgentConfirms, confirmViaUI } from "../../store/agentConfirms";
import { useSettings } from "../../store/settings";
import { setNavigator } from "../../agent/nav";
import { runTurn } from "../../agent/runtime";
import { getProvider } from "../../llm/providers";
import { getVendorKey, getModelName } from "../../llm/llmIdentity";
import type { Message, UserMessage } from "../../types/agent";
import type { Settings } from "../../types/settings";
import { ChatBar } from "./ChatBar";
import { ConversationHeader } from "./ConversationHeader";
import { MessageList } from "./MessageList";
import { InlineConfirmList } from "./InlineConfirmList";
import { InputBox } from "./InputBox";
import { EmptyState } from "./EmptyState";

const PANEL_OPEN_KEY = "agentPanelOpen";

/** Tiny presence check on the configured LLM credentials. We only need to know
 *  "can a turn be sent" — full validation belongs to the provider call itself.
 *  Matches the shape used elsewhere in the app (see Settings + Library import). */
function isLlmConfigured(settings: Settings | null | undefined): boolean {
  if (!settings) return false;
  if (settings.llmProvider === "claude") return !!settings.claude?.apiKey;
  if (settings.llmProvider === "gemini") return !!settings.gemini?.apiKey;
  if (settings.llmProvider === "openai-compatible")
    return !!settings.openaiCompatible?.apiKey;
  return false;
}

export function AgentRoot() {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PANEL_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  // unreadFlag is kept in state so future ChatBar variants can render an
  // "unread" dot when an assistant message lands while collapsed. The current
  // bar doesn't render it yet, hence the `_` prefix to silence noUnusedLocals.
  const [_unreadFlag, setUnreadFlag] = useState(false);
  const [suggestionToPrefill, setSuggestionToPrefill] = useState<
    string | undefined
  >(undefined);
  const abortRef = useRef<AbortController | null>(null);

  // Set up the navigator bridge once + hydrate persisted history once.
  // (Both are idempotent — useAgent.hydrate sets `hydrated` true, callers
  // tolerate concurrent calls; setNavigator just overwrites the ref.)
  useEffect(() => {
    setNavigator(navigate);
    void useAgent.getState().hydrate();
    return () => setNavigator(null);
  }, [navigate]);

  // Persist panelOpen across launches.
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_OPEN_KEY, panelOpen ? "1" : "0");
    } catch {
      // localStorage unavailable (extremely rare); silently drop.
    }
  }, [panelOpen]);

  // Open → clear unread badge. Close → abort in-flight + reject pending MIDs.
  useEffect(() => {
    if (panelOpen) {
      setUnreadFlag(false);
      return;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    useAgentConfirms.getState().rejectAllPanelClosed();
    setStreamingMsgId(null);
  }, [panelOpen]);

  const noLlm = !isLlmConfigured(settings);

  const handleSend = useCallback(
    async (text: string) => {
      if (noLlm) return;

      // Ensure there's an active conversation (lazy-create on first send).
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

      // Build provider + abort controller LATE — `settings` is read at send
      // time so a user changing the model between turns picks up immediately.
      // getProvider() returns the narrow Provider (stream-only) interface,
      // but every concrete factory also implements AgentProvider (streamWithTools);
      // we cast through unknown rather than widening the index.ts return type to
      // avoid the change rippling into every other Provider consumer.
      const provider = getProvider(settings) as unknown as Parameters<
        typeof runTurn
      >[0]["provider"];
      const ac = new AbortController();
      abortRef.current = ac;

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
          signal: ac.signal,
          confirm: confirmViaUI,
          onMessage: (m: Message) => {
            useAgent.getState().addMessage(activeId!, m);
            if (m.role === "assistant") {
              setStreamingMsgId(null);
              if (!panelOpen) setUnreadFlag(true);
            }
          },
          onAssistantTextDelta: (msgId: string, _delta: string) => {
            setStreamingMsgId(msgId);
          },
        });
      } catch (e) {
        // runTurn itself never throws on signal abort (it returns); a thrown
        // error here is genuinely unexpected — log and let the turn end.
        // eslint-disable-next-line no-console
        console.warn("[agent] runTurn error:", e);
      } finally {
        abortRef.current = null;
        setStreamingMsgId(null);
      }
    },
    [noLlm, settings, panelOpen],
  );

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setStreamingMsgId(null);
  }, []);

  const handleSuggestionClick = useCallback((text: string) => {
    setSuggestionToPrefill(text);
    // Reset after a tick so the InputBox useEffect's `if (initialValue)` guard
    // re-triggers on subsequent clicks of the same suggestion.
    setTimeout(() => setSuggestionToPrefill(undefined), 50);
  }, []);

  // Subscribe to history for body/empty switching.
  const history = useAgent((s) => s.history);
  const activeConv = history.conversations.find(
    (c) => c.id === history.activeConversationId,
  );
  const hasMessages = (activeConv?.messages.length ?? 0) > 0;

  const body = hasMessages ? (
    <MessageList streamingMsgId={streamingMsgId} />
  ) : (
    <EmptyState
      noLlm={noLlm}
      onOpenSettings={() => {
        navigate("/settings");
        setPanelOpen(false);
      }}
      onSuggestionClick={handleSuggestionClick}
    />
  );

  const inputBox = (
    <InputBox
      streaming={streamingMsgId != null}
      noLlm={noLlm}
      initialValue={suggestionToPrefill}
      onSend={handleSend}
      onStop={handleStop}
    />
  );

  const header = <ConversationHeader onClose={() => setPanelOpen(false)} />;

  return (
    <ChatBar
      expanded={panelOpen}
      onExpand={() => setPanelOpen(true)}
      onCollapse={() => setPanelOpen(false)}
      streaming={streamingMsgId != null}
      header={header}
      body={body}
      inlineConfirms={<InlineConfirmList />}
      inputBox={inputBox}
    />
  );
}
