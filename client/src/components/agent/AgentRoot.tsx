// src/components/agent/AgentRoot.tsx
//
// Single composite that mounts the Spotlight-style ChatBar (UX revision
// 2026-05-30, three-state Task 33 refresh) + wires the runtime entrypoint.
// App.tsx mounts <AgentRoot /> once inside the BrowserRouter so this
// component has access to useNavigate(); App.tsx itself only adds one
// import + one JSX line.
//
// Responsibilities:
//   1. Hydrate useAgent once on mount.
//   2. setNavigator(useNavigate()) so the nav tools (T15) can do
//      navigate("/library") without dragging React Router into agent core.
//   3. Own `mode` (icon | bar | panel), persisted in localStorage. Initial
//      mode reads the persisted value; absent → page-default.
//      Page-default: pathname starts with /player/ → "icon", else → "bar".
//   4. On navigation: nudge mode toward the new page-default UNLESS the user
//      already opened the panel (panel state is sticky across nav).
//   5. Own AbortController for in-flight turn. Mode collapsing from "panel"
//      → "icon"/"bar" aborts + rejects pending MID confirmations with
//      "no_panel_closed"; stop button aborts only.
//   6. Switch between MessageList+InlineConfirmList (has messages) and
//      EmptyState (no messages OR LLM not configured).
//   7. InputBox.onSend → ensures an active conversation exists → calls
//      runTurn(), threading runtime callbacks into useAgent.addMessage.
//      Also flips mode to "panel" so streaming output is visible.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAgent } from "../../store/agent";
import { useAgentConfirms, confirmViaUI } from "../../store/agentConfirms";
import { useSettings } from "../../store/settings";
import { setNavigator } from "../../agent/nav";
import { runTurn } from "../../agent/runtime";
import { getProvider } from "../../llm/providers";
import { getVendorKey, getModelName } from "../../llm/llmIdentity";
import type { Message, UserMessage } from "../../types/agent";
import type { Settings } from "../../types/settings";
import { ChatBar, type ChatBarMode } from "./ChatBar";
import { ConversationHeader } from "./ConversationHeader";
import { MessageList } from "./MessageList";
import { InlineConfirmList } from "./InlineConfirmList";
import { InputBox } from "./InputBox";
import { EmptyState } from "./EmptyState";
import { useTutorRuntime } from "../../store/tutorRuntime";

const BAR_MODE_KEY = "agentBarMode";
const LEGACY_PANEL_OPEN_KEY = "agentPanelOpen";

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

/** Page-default collapsed mode. /player/* keeps the video real-estate clean
 *  by defaulting to the small icon; everywhere else uses the regular bar. */
export function pageDefaultMode(pathname: string): "icon" | "bar" {
  return pathname.startsWith("/player/") ? "icon" : "bar";
}

function loadInitialMode(pathname: string): ChatBarMode {
  try {
    const saved = localStorage.getItem(BAR_MODE_KEY);
    if (saved === "icon" || saved === "bar" || saved === "panel") return saved;
  } catch {
    /* ignore */
  }
  return pageDefaultMode(pathname);
}

export function AgentRoot() {
  const navigate = useNavigate();
  const location = useLocation();
  const { settings } = useSettings();
  const pageDefault = pageDefaultMode(location.pathname);
  const tutorActive = useTutorRuntime((s) => s.mode.kind !== "none");

  const [mode, setMode] = useState<ChatBarMode>(() =>
    loadInitialMode(location.pathname),
  );
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const [unreadFlag, setUnreadFlag] = useState(false);
  const [suggestionToPrefill, setSuggestionToPrefill] = useState<
    string | undefined
  >(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const prevModeRef = useRef<ChatBarMode>(mode);

  // Set up the navigator bridge once + hydrate persisted history once.
  // (Both are idempotent — useAgent.hydrate sets `hydrated` true, callers
  // tolerate concurrent calls; setNavigator just overwrites the ref.)
  useEffect(() => {
    setNavigator(navigate);
    void useAgent.getState().hydrate();
    return () => setNavigator(null);
  }, [navigate]);

  // Clean up legacy localStorage key (was a boolean; now replaced by mode).
  // Safe to run unconditionally — removeItem is a no-op when absent.
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_PANEL_OPEN_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  // Persist mode across launches.
  useEffect(() => {
    try {
      localStorage.setItem(BAR_MODE_KEY, mode);
    } catch {
      /* localStorage unavailable — drop silently */
    }
  }, [mode]);

  // Navigation nudge: when route's page-default changes (e.g. user navigates
  // from /library to /player/X), follow the new default UNLESS the panel is
  // already open (panel state is sticky across nav). intentionally omits
  // `mode` from deps — we only react to navigation changes.
  useEffect(() => {
    if (mode === "panel") return;
    setMode(pageDefault);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageDefault]);

  // Mode transition side effects:
  //   panel → icon|bar : abort in-flight + reject pending MIDs (collapse)
  //   anything → not-icon : clear unread (user has the agent visible)
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = mode;
    if (prev === "panel" && mode !== "panel") {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      useAgentConfirms.getState().rejectAllPanelClosed();
      setStreamingMsgId(null);
    }
    if (mode !== "icon") {
      setUnreadFlag(false);
    }
  }, [mode]);

  // While a tutor overlay is up, force the agent to icon mode so it doesn't
  // cover the lesson. We deliberately do NOT auto-restore on close — the tutor
  // is only launchable from /player/* (page default = icon), and a later route
  // change re-runs the nav-nudge effect above which self-corrects the mode.
  useEffect(() => {
    if (tutorActive) {
      setMode("icon");
    }
  }, [tutorActive]);

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

      // Auto-expand to panel so the streaming assistant reply is visible.
      // (Sending from "bar" without this would queue the assistant reply
      // behind a closed UI surface; user would just see their bar reset.)
      setMode("panel");

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
              // Only set unread if user actually has the icon up (collapsed +
              // not visible). Bar/panel users already see the response inline.
              if (mode === "icon") setUnreadFlag(true);
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
    [noLlm, settings, mode],
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
        setMode(pageDefault);
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

  // ✕ in the header steps down from panel to bar (matches the click-outside
  // step-down). User can then close the bar via another click-outside or
  // keep typing.
  const header = <ConversationHeader onClose={() => setMode("bar")} />;

  return (
    <ChatBar
      mode={mode}
      onModeChange={setMode}
      streaming={streamingMsgId != null}
      hasUnread={unreadFlag}
      header={header}
      body={body}
      inlineConfirms={<InlineConfirmList />}
      inputBox={inputBox}
    />
  );
}
