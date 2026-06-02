// src/components/tutor/VoiceAnswerButton.tsx
//
// Mic button for answering tutor questions by VOICE instead of typing. Click →
// record; the first utterance (or a manual stop) is transcribed and appended to
// the answer draft via onText. Logic lives in useVoiceDictation.

import { Mic, Square, Loader2 } from "lucide-react";
import { useVoiceDictation } from "../../voice/useVoiceDictation";

interface Props {
  /** Called with the transcribed text (caller decides append vs replace). */
  onText: (text: string) => void;
  disabled?: boolean;
}

export function VoiceAnswerButton({ onText, disabled }: Props) {
  const { state, toggle } = useVoiceDictation(onText);

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
      onClick={toggle}
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
