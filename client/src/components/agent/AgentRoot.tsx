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
import { registerOpenPanel } from "../../agent/chatBarBridge";
import { sendAgentMessage } from "../../agent/send";
import type { Message } from "../../types/agent";
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

/** Page-default resting mode. With the unified voice-first AI, the resting
 *  state is always the collapsed icon (click → voice); text chat is reached
 *  via the panel. The old always-visible `bar` input strip is no longer a
 *  default on any page. */
export function pageDefaultMode(_pathname: string): "icon" | "bar" {
  return "icon";
}

function loadInitialMode(pathname: string): ChatBarMode {
  // On launch, start collapsed (icon) — only restore the panel if the user
  // was mid-conversation. A persisted "bar" migrates to "icon" (bar is no
  // longer a resting default).
  try {
    if (localStorage.getItem(BAR_MODE_KEY) === "panel") return "panel";
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

  // Register the panel-open bridge so VoiceMode's "打字" button can open
  // the chat panel without prop-drilling through the portal boundary.
  useEffect(() => {
    registerOpenPanel(() => setMode("panel"));
    return () => registerOpenPanel(null);
  }, []);

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

      // Auto-expand to panel so the streaming assistant reply is visible.
      setMode("panel");

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        await sendAgentMessage(text, {
          signal: ac.signal,
          confirm: confirmViaUI,
          onAssistantMessage: (m: Message) => {
            if (m.role === "assistant") {
              setStreamingMsgId(null);
              // Only set unread if user actually has the icon up (collapsed +
              // not visible). Bar/panel users already see the response inline.
              if (mode === "icon") setUnreadFlag(true);
            }
          },
          onTextDelta: (msgId: string, _delta: string) => {
            setStreamingMsgId(msgId);
          },
        });
      } finally {
        abortRef.current = null;
        setStreamingMsgId(null);
      }
    },
    [noLlm, mode],
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
      panelMode={mode === "panel"}
      onSend={handleSend}
      onStop={handleStop}
    />
  );

  // ✕ in the header steps down from panel to bar (matches the click-outside
  // step-down). User can then close the bar via another click-outside or
  // keep typing.
  const header = <ConversationHeader onClose={() => setMode("icon")} />;

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
