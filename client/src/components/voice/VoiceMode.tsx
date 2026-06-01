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

/** Siri-style iridescent orb — a layered port of the iOS VoiceOrbView:
 *  a bright cyan/white emissive body with soft pink wisp ellipses and a white
 *  swoosh brushstroke, all blurred (no hard conic seams). The whole orb scales
 *  with mic level (the size IS the listening signal). A warm palette shift is
 *  used only while transcribing. */
function Orb({ state, level }: { state: VoiceState; level: number }) {
  const clamped = Math.min(1, Math.max(0, level));
  // The orb visibly GROWS as the user speaks — the size is the signal.
  const scale = 1 + clamped * 0.55;
  const active = state !== "error";
  const warm = state === "transcribing";

  const SIZE = 120;
  const HALO = SIZE * 1.8;

  // Palette (sky-cyan/pink normally; warm amber while transcribing).
  const bodyCenter = "rgba(245,252,255,1)";
  const bodyMid = warm ? "rgba(255,206,112,1)" : "rgba(96,188,255,1)";
  const bodyEdge = warm ? "rgba(238,168,68,0.9)" : "rgba(62,150,236,0.9)";
  const pink = warm ? "rgba(255,170,72,0.92)" : "rgba(248,150,214,0.92)";
  const glowCyan = warm ? "rgba(255,200,90," : "rgba(96,188,255,";
  const glowPink = warm ? "rgba(255,150,60," : "rgba(248,150,214,";
  const glowAlpha = 0.5 + clamped * 0.3;

  return (
    <div
      className="relative pointer-events-none"
      style={{
        width: HALO,
        height: HALO,
        transform: `scale(${scale})`,
        transition: "transform 90ms ease-out",
      }}
    >
      {/* 1. soft outer glow — cyan→pink halo, blurred, gently breathing */}
      <div
        className={active ? "absolute inset-0 animate-orb-glow-breathe" : "absolute inset-0"}
        style={{
          borderRadius: "9999px",
          background: `radial-gradient(circle, ${glowCyan}${glowAlpha}) 0%, ${glowPink}0.28) 45%, transparent 70%)`,
          filter: "blur(26px)",
        }}
      />

      {/* orb circle: body + wisps + swoosh + highlight, clipped to a circle */}
      <div
        className="absolute overflow-hidden rounded-full"
        style={{
          width: SIZE,
          height: SIZE,
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          opacity: active ? 1 : 0.5,
          boxShadow: `0 0 40px 8px ${glowCyan}0.45), inset 0 0 30px rgba(255,255,255,0.22)`,
        }}
      >
        {/* 3. emissive body — near-white center → bright cyan → soft cyan edge */}
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(circle at 45% 40%, ${bodyCenter} 0%, ${bodyMid} 42%, ${bodyEdge} 100%)`,
          }}
        />
        {/* 2. pink wisp — rotating elongated ellipse (iridescent tint) */}
        <div className="absolute inset-0 grid place-items-center">
          <div
            className={active ? "animate-orb-wisp-a" : ""}
            style={{
              width: "118%",
              height: "55%",
              borderRadius: "9999px",
              background: `linear-gradient(90deg, transparent 0%, ${pink} 50%, transparent 100%)`,
              filter: "blur(13px)",
            }}
          />
        </div>
        {/* 4. white swoosh — counter-rotating bright brushstroke */}
        <div className="absolute inset-0 grid place-items-center">
          <div
            className={active ? "animate-orb-wisp-b" : ""}
            style={{
              width: "110%",
              height: "42%",
              borderRadius: "9999px",
              background:
                "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.95) 50%, transparent 100%)",
              filter: "blur(8px)",
              mixBlendMode: "screen",
            }}
          />
        </div>
        {/* 5. glass sheen — small bright spot upper-left */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 33% 27%, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.18) 18%, transparent 44%)",
            mixBlendMode: "screen",
          }}
        />
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
