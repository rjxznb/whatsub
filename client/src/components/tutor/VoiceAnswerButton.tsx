// src/components/tutor/VoiceAnswerButton.tsx
//
// Mic button for answering tutor questions by VOICE instead of typing. Click →
// record (mic + VAD); on the first detected utterance (or a manual stop) the
// WAV is transcribed via the same whisper path as voice mode and the text is
// handed back via onText (the caller appends it to the answer draft).

import { useRef, useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { startVoiceCapture, type VoiceCapture } from "../../voice/voiceCapture";
import { transcribeVoice } from "../../voice/voiceStt";

interface Props {
  /** Called with the transcribed text (caller decides append vs replace). */
  onText: (text: string) => void;
  disabled?: boolean;
}

type State = "idle" | "recording" | "transcribing";

export function VoiceAnswerButton({ onText, disabled }: Props) {
  const [state, setState] = useState<State>("idle");
  const capRef = useRef<VoiceCapture | null>(null);
  const handledRef = useRef(false);

  const teardown = () => {
    capRef.current?.stop();
    capRef.current = null;
  };

  const start = async () => {
    handledRef.current = false;
    setState("recording");
    try {
      capRef.current = await startVoiceCapture({
        onUtterance: async (wav) => {
          if (handledRef.current) return; // one answer per recording
          handledRef.current = true;
          teardown();
          setState("transcribing");
          try {
            const text = await transcribeVoice(wav);
            if (text.trim()) onText(text.trim());
          } catch {
            /* transcription failed — drop silently, user can retry */
          } finally {
            setState("idle");
          }
        },
        onError: () => {
          teardown();
          setState("idle");
        },
      });
    } catch {
      // mic denied / AudioContext failed
      setState("idle");
    }
  };

  const onClick = () => {
    if (state === "transcribing") return;
    if (state === "recording") {
      // Flushing the capture fires onUtterance synchronously if speech was
      // buffered; if nothing was captured, fall back to idle.
      teardown();
      if (!handledRef.current) setState("idle");
      return;
    }
    void start();
  };

  const icon =
    state === "recording" ? (
      <Square size={14} fill="currentColor" />
    ) : state === "transcribing" ? (
      <Loader2 size={15} className="animate-spin" />
    ) : (
      <Mic size={15} />
    );

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || state === "transcribing"}
      title={
        state === "recording"
          ? "停止并识别"
          : state === "transcribing"
            ? "识别中…"
            : "语音作答"
      }
      aria-label="语音作答"
      className={
        "grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-60 " +
        (state === "recording"
          ? "text-rose-400 animate-pulse"
          : "text-zinc-400 hover:text-zinc-100 hover:bg-white/5")
      }
    >
      {icon}
    </button>
  );
}
