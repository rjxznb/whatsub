/**
 * VoiceMode — Siri-style transparent voice overlay.
 *
 * Opened via Shift+V (or useVoiceMode.openVoice()). Renders a translucent
 * full-screen layer (the app stays visible behind it) with a single pulsing
 * orb that grows as the user speaks. The AI's reply shows as ONE line — no
 * scrollback; past replies are reached with ←/→. After a few seconds of
 * silence the overlay auto-dismisses.
 *
 * Drives a VoiceConversation (same tool-using agent). StrictMode-safe via a
 * started ref.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useVoiceMode } from "../../store/voiceMode";
import { useSettings } from "../../store/settings";
import { usePlayerState } from "../../store/playerState";
import { VoiceConversation } from "../../voice/voiceConversation";
import type { VoiceState } from "../../voice/types";

const IDLE_DISMISS_MS = 6000; // silence this long (while listening) → close
const ACTIVITY_LEVEL = 0.03; // mic RMS above this counts as "user is talking"

// ── Orb ───────────────────────────────────────────────────────────────────────

function Orb({ state, level }: { state: VoiceState; level: number }) {
  const clamped = Math.min(1, Math.max(0, level));
  // The orb visibly GROWS as the user speaks.
  const scale = 1 + clamped * 0.5;
  const glowScale = 1 + clamped * 1.0;
  const dimmed = state === "error" || state === "idle";

  return (
    <div className="relative" style={{ width: 116, height: 116 }}>
      {/* soft outer glow — reacts most to mic level */}
      <div
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{
          transform: `scale(${glowScale})`,
          transition: "transform 90ms ease-out",
          background:
            "radial-gradient(circle, rgba(129,140,248,0.40) 0%, rgba(56,189,248,0.14) 55%, transparent 72%)",
          filter: "blur(6px)",
        }}
      />
      {/* level scale on the wrapper; the iridescent layer spins inside it. */}
      <div
        className="absolute inset-0"
        style={{ transform: `scale(${scale})`, transition: "transform 90ms ease-out" }}
      >
        {/* iridescent glassy sphere — slowly swirling conic gradient */}
        <div
          className={dimmed ? "" : "animate-voice-spin"}
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "9999px",
            opacity: dimmed ? 0.4 : 1,
            background: dimmed
              ? "radial-gradient(circle at 40% 35%, #a1a1aa 0%, #3f3f46 100%)"
              : "conic-gradient(from 0deg, #22d3ee, #3b82f6, #8b5cf6, #ec4899, #f472b6, #38bdf8, #22d3ee)",
            boxShadow: dimmed
              ? "none"
              : "0 0 48px 10px rgba(99,102,241,0.45), 0 0 90px 18px rgba(56,189,248,0.18), inset 0 0 28px rgba(255,255,255,0.28)",
          }}
        />
        {/* static glassy highlight (fixed light source — doesn't spin) */}
        {!dimmed && (
          <div
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{
              background:
                "radial-gradient(circle at 35% 28%, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.2) 20%, transparent 46%)",
            }}
          />
        )}
      </div>
    </div>
  );
}

function statusHint(state: VoiceState, errorMsg: string): string {
  switch (state) {
    case "listening":
      return "在听，请说…";
    case "transcribing":
      return "识别中…";
    case "thinking":
      return "在想…";
    case "error":
      return errorMsg || "出错了";
    default:
      return "";
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

function VoiceModeInner() {
  const closeVoice = useVoiceMode((s) => s.closeVoice);
  const settings = useSettings((s) => s.settings);

  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [level, setLevel] = useState(0);
  const [liveReply, setLiveReply] = useState(""); // currently-streaming reply
  const [replies, setReplies] = useState<string[]>([]); // completed reply history
  const [replyIndex, setReplyIndex] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [micDenied, setMicDenied] = useState(false);

  const convRef = useRef<VoiceConversation | null>(null);
  const startedRef = useRef(false);
  const lastActivityRef = useRef(Date.now());
  const bumpActivity = () => {
    lastActivityRef.current = Date.now();
  };

  // When opened on the Player page, pause the video for the duration of the
  // conversation and resume it on close (only if it was actually playing).
  const wasPlayingRef = useRef(false);
  const resumeVideo = useCallback(() => {
    if (wasPlayingRef.current) {
      wasPlayingRef.current = false;
      usePlayerState.getState().playHandler?.();
    }
  }, []);

  const startConversation = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    setMicDenied(false);
    setErrorMsg("");
    setVoiceState("idle");
    bumpActivity();

    const conv = new VoiceConversation(settings, {
      onState: (s) => {
        setVoiceState(s);
        // While the AI is busy, keep the overlay alive.
        if (s === "transcribing" || s === "thinking" || s === "speaking") bumpActivity();
      },
      onLevel: (rms) => {
        setLevel(rms);
        if (rms > ACTIVITY_LEVEL) bumpActivity();
      },
      onUserText: () => bumpActivity(),
      onAssistantText: (text, done) => {
        bumpActivity();
        if (done) {
          setReplies((prev) => {
            const next = [...prev, text];
            setReplyIndex(next.length - 1);
            return next;
          });
          setLiveReply("");
        } else {
          setLiveReply(text);
        }
      },
      onError: (msg) => {
        setErrorMsg(msg);
        if (msg.includes("permission") || msg.includes("microphone") || msg.includes("denied")) {
          setMicDenied(true);
        }
      },
    });
    convRef.current = conv;
    conv.start().catch(() => {
      /* mic-denied already surfaced via onError */
    });
  }, [settings]);

  const handleClose = useCallback(() => {
    convRef.current?.stop();
    convRef.current = null;
    startedRef.current = false;
    resumeVideo();
    closeVoice();
  }, [closeVoice, resumeVideo]);

  // Mount: pause the player video (if any), then start the conversation once.
  useEffect(() => {
    wasPlayingRef.current = usePlayerState.getState().pauseHandler?.() ?? false;
    startConversation();
    return () => {
      convRef.current?.stop();
      convRef.current = null;
      startedRef.current = false;
      resumeVideo();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-dismiss after silence (only while idly listening, never mid-AI-turn
  // or on the mic-denied screen).
  useEffect(() => {
    const iv = setInterval(() => {
      if (micDenied) return;
      if (voiceState === "listening" && Date.now() - lastActivityRef.current > IDLE_DISMISS_MS) {
        handleClose();
      }
    }, 700);
    return () => clearInterval(iv);
  }, [voiceState, micDenied, handleClose]);

  // ←/→ to browse reply history, Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      } else if (e.key === "ArrowLeft") {
        bumpActivity();
        setReplyIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight") {
        bumpActivity();
        setReplyIndex((i) => Math.min(replies.length - 1, i + 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [replies.length, handleClose]);

  // What to show: the live streaming reply, else the selected history reply.
  const shownReply = liveReply || replies[replyIndex] || "";
  const showingHistory = !liveReply && replies.length > 0;
  const canPrev = showingHistory && replyIndex > 0;
  const canNext = showingHistory && replyIndex < replies.length - 1;
  const hint = statusHint(voiceState, errorMsg);

  return createPortal(
    <div
      data-voice-mode
      className="fixed inset-0 z-[110] flex flex-col items-center justify-end pb-16 gap-6 bg-black/35 backdrop-blur-sm"
      // Click anywhere outside the orb/caption dismisses (Siri-like).
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      {micDenied ? (
        <div className="flex flex-col items-center gap-5 px-8 text-center max-w-sm">
          <p
            className="text-zinc-100 text-sm leading-relaxed"
            style={{ textShadow: "0 1px 10px rgba(0,0,0,0.85)" }}
          >
            无法访问麦克风。请在系统设置中允许 whatsub 使用麦克风后重试。
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                convRef.current?.stop();
                convRef.current = null;
                startedRef.current = false;
                setTimeout(() => startConversation(), 60);
              }}
              className="px-4 py-2 bg-blue-500 hover:bg-blue-400 text-black text-sm rounded font-medium transition-colors"
            >
              重试
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 text-zinc-300 hover:text-zinc-100 text-sm transition-colors"
            >
              关闭
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Single reply, in a translucent pill, with ←/→ history nav beside it. */}
          {shownReply && (
            <div className="flex items-center gap-2 px-4 max-w-[680px] w-full justify-center">
              <button
                type="button"
                aria-label="上一条"
                disabled={!canPrev}
                onClick={() => {
                  bumpActivity();
                  setReplyIndex((i) => Math.max(0, i - 1));
                }}
                className={
                  "shrink-0 grid place-items-center h-9 w-9 rounded-full text-zinc-200 transition-opacity " +
                  (canPrev ? "hover:bg-white/15" : "opacity-0 pointer-events-none")
                }
              >
                <ChevronLeft size={22} />
              </button>
              <div className="bg-black/45 backdrop-blur-xl rounded-3xl px-6 py-3.5 max-w-[560px] ring-1 ring-white/10">
                <p className="text-center text-[16px] leading-relaxed text-zinc-50">
                  {shownReply}
                </p>
              </div>
              <button
                type="button"
                aria-label="下一条"
                disabled={!canNext}
                onClick={() => {
                  bumpActivity();
                  setReplyIndex((i) => Math.min(replies.length - 1, i + 1));
                }}
                className={
                  "shrink-0 grid place-items-center h-9 w-9 rounded-full text-zinc-200 transition-opacity " +
                  (canNext ? "hover:bg-white/15" : "opacity-0 pointer-events-none")
                }
              >
                <ChevronRight size={22} />
              </button>
            </div>
          )}

          <Orb state={voiceState} level={level} />

          {hint && (
            <div
              className="text-xs text-zinc-300/90"
              style={{ textShadow: "0 1px 8px rgba(0,0,0,0.8)" }}
            >
              {hint}
            </div>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}

export function VoiceMode() {
  const open = useVoiceMode((s) => s.open);
  if (!open) return null;
  // VoiceModeInner already renders into a portal.
  return <VoiceModeInner />;
}
