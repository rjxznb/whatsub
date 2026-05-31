/**
 * VoiceMode — full-screen voice conversation portal.
 *
 * Rendered as a fixed full-screen overlay (z-[110]) via ReactDOM.createPortal
 * to document.body. Driven by the `useVoiceMode` store; renders null when
 * the store is closed.
 *
 * On mount: creates a VoiceConversation instance, wires its handlers to local
 * React state, and calls start(). On unmount / close: calls stop().
 *
 * Guard: useRef + started flag prevents React StrictMode double-mount from
 * starting two conversations.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useVoiceMode } from "../../store/voiceMode";
import { useSettings } from "../../store/settings";
import { VoiceConversation } from "../../voice/voiceConversation";
import type { VoiceState } from "../../voice/types";

// ── Orb ───────────────────────────────────────────────────────────────────────

interface OrbProps {
  state: VoiceState;
  level: number;
}

function Orb({ state, level }: OrbProps) {
  // Clamp level to [0, 1], amplify a bit so subtle speech visibly moves the ring.
  const clamped = Math.min(1, Math.max(0, level));
  const ringScale = 1 + clamped * 0.45;

  // Core animation class based on current state.
  let coreClass = "";
  if (state === "listening") {
    coreClass = "animate-voice-breathe";
  } else if (state === "transcribing" || state === "thinking") {
    coreClass = "animate-voice-spin";
  } else if (state === "speaking") {
    coreClass = "animate-voice-ripple";
  }

  const dimmed = state === "error" || state === "idle";

  return (
    <div className="relative flex items-center justify-center" style={{ width: 180, height: 180 }}>
      {/* Outer glow ring — scales with mic level */}
      <div
        className="absolute rounded-full pointer-events-none transition-transform duration-75"
        style={{
          width: 180,
          height: 180,
          transform: `scale(${ringScale})`,
          background:
            "radial-gradient(circle, rgba(56,189,248,0.18) 0%, rgba(14,165,233,0.06) 55%, transparent 75%)",
        }}
      />

      {/* Core orb */}
      <div
        className={`rounded-full ${coreClass} ${dimmed ? "opacity-30" : "opacity-100"} transition-opacity duration-300`}
        style={{
          width: 144,
          height: 144,
          background: dimmed
            ? "radial-gradient(circle at 40% 35%, #71717a 0%, #3f3f46 100%)"
            : "radial-gradient(circle at 40% 35%, #38bdf8 0%, #0ea5e9 45%, #0369a1 100%)",
          boxShadow: dimmed
            ? "none"
            : "0 0 32px 4px rgba(14,165,233,0.35), 0 0 80px 8px rgba(56,189,248,0.12), inset 0 2px 6px rgba(255,255,255,0.18)",
        }}
      />
    </div>
  );
}

// ── Status line ───────────────────────────────────────────────────────────────

function statusLabel(state: VoiceState, errorMsg: string): string {
  switch (state) {
    case "listening":
      return "在听，请说…";
    case "transcribing":
      return "识别中…";
    case "thinking":
      return "在想…";
    case "speaking":
      return "";
    case "error":
      return errorMsg || "出错了";
    case "idle":
    default:
      return "";
  }
}

// ── Main component ────────────────────────────────────────────────────────────

function VoiceModeInner() {
  const closeVoice = useVoiceMode((s) => s.closeVoice);
  const settings = useSettings((s) => s.settings);

  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [level, setLevel] = useState(0);
  const [userText, setUserText] = useState("");
  const [assistantText, setAssistantText] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [micDenied, setMicDenied] = useState(false);

  const convRef = useRef<VoiceConversation | null>(null);
  const startedRef = useRef(false);

  const startConversation = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    setMicDenied(false);
    setErrorMsg("");
    setVoiceState("idle");

    const conv = new VoiceConversation(settings, {
      onState: (s) => setVoiceState(s),
      onLevel: (rms) => setLevel(rms),
      onUserText: (text) => setUserText(text),
      onAssistantText: (text, _done) => setAssistantText(text),
      onError: (msg) => {
        setErrorMsg(msg);
        if (msg.includes("permission") || msg.includes("microphone") || msg.includes("denied")) {
          setMicDenied(true);
        }
      },
    });

    convRef.current = conv;
    conv.start().catch(() => {
      // start() only throws if mic is denied — already handled by onError.
    });
  }, [settings]);

  // Mount: start conversation once (StrictMode-safe guard via startedRef).
  useEffect(() => {
    startConversation();

    return () => {
      // Unmount: stop and release.
      convRef.current?.stop();
      convRef.current = null;
      startedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleClose() {
    convRef.current?.stop();
    convRef.current = null;
    startedRef.current = false;
    closeVoice();
  }

  function handleRetry() {
    convRef.current?.stop();
    convRef.current = null;
    startedRef.current = false;
    // Small delay so stop() cleans up before restart.
    setTimeout(() => startConversation(), 60);
  }

  const label = statusLabel(voiceState, errorMsg);

  return (
    <div
      data-voice-mode
      className="fixed inset-0 z-[110] bg-zinc-950 flex flex-col items-center justify-center"
      style={{
        background:
          "radial-gradient(ellipse 60% 55% at 50% 55%, rgba(14,165,233,0.07) 0%, transparent 70%), #09090b",
      }}
    >
      {/* Close button */}
      <button
        type="button"
        onClick={handleClose}
        aria-label="关闭语音模式"
        className="absolute top-5 right-5 flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
      >
        <X className="h-5 w-5" />
      </button>

      {micDenied ? (
        /* ── Mic permission error ────────────────────────────────────────── */
        <div className="flex flex-col items-center gap-5 px-8 text-center max-w-sm">
          <div className="text-4xl select-none">🎤</div>
          <p className="text-zinc-200 text-sm leading-relaxed">
            无法访问麦克风。请在系统设置中允许 whatsub 使用麦克风后重试。
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleRetry}
              className="px-4 py-2 bg-sky-500 hover:bg-sky-400 text-white text-sm rounded font-medium transition-colors"
            >
              重试
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 text-zinc-400 hover:text-zinc-200 text-sm transition-colors"
            >
              关闭
            </button>
          </div>
        </div>
      ) : (
        /* ── Main orb + captions ─────────────────────────────────────────── */
        <div className="flex flex-col items-center gap-6">
          <Orb state={voiceState} level={level} />

          {/* Status line */}
          <div className="h-6 flex items-center justify-center">
            <span
              className={`text-sm font-medium transition-opacity duration-200 ${
                label ? "opacity-100" : "opacity-0"
              } ${
                voiceState === "error"
                  ? "text-rose-400"
                  : "text-zinc-400"
              }`}
            >
              {label || " "}
            </span>
          </div>

          {/* Captions: last user line + streaming assistant line */}
          <div className="flex flex-col items-center gap-2 min-h-[56px] w-full max-w-md px-6">
            {userText && (
              <p className="text-zinc-500 text-sm text-center leading-snug truncate w-full">
                你：{userText}
              </p>
            )}
            {assistantText && (
              <p className="text-zinc-100 text-sm text-center leading-snug w-full line-clamp-3">
                AI：{assistantText}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Portal wrapper ────────────────────────────────────────────────────────────

export function VoiceMode() {
  const open = useVoiceMode((s) => s.open);
  if (!open) return null;
  return createPortal(<VoiceModeInner />, document.body);
}
