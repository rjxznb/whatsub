// src/components/voice/VoiceDictationButton.tsx
//
// Voice-input button (speech-to-text into a field), styled after Enghub's
// RecordButton: a waveform icon that reacts to mic volume, the button expands +
// turns accent while recording, and pulses while transcribing. Used by the chat
// input and the tutor answer fields. Self-contained (owns the recorder hook +
// volume state) so the host doesn't re-render every audio frame.

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { useVoiceDictation } from "../../voice/useVoiceDictation";
import { registerDictationStarter } from "../../agent/chatBarBridge";
import { VoiceBars } from "./VoiceBars";

interface Props {
  /** Called with transcribed text (caller appends/replaces). */
  onText: (text: string) => void;
  disabled?: boolean;
  /** Register as the global Shift+V dictation target (chat input only). */
  registerGlobal?: boolean;
}

export function VoiceDictationButton({ onText, disabled, registerGlobal }: Props) {
  const { state, toggle, volume } = useVoiceDictation(onText);

  // Expose toggle to the Shift+V bridge (ref keeps it fresh without re-register).
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    if (!registerGlobal) return;
    registerDictationStarter(() => toggleRef.current());
    return () => registerDictationStarter(null);
  }, [registerGlobal]);

  const recording = state === "recording";
  const transcribing = state === "transcribing";

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled || transcribing}
      aria-label="语音输入"
      title={recording ? "停止并识别" : transcribing ? "识别中…" : "语音输入"}
      className={
        "grid h-8 shrink-0 place-items-center rounded-full transition-all duration-300 disabled:opacity-60 " +
        (recording
          ? "w-12 bg-rose-500/20 text-rose-300"
          : "w-8 text-zinc-400 hover:text-zinc-100 hover:bg-white/5")
      }
    >
      {transcribing ? (
        <Loader2 size={15} className="animate-spin" />
      ) : (
        <VoiceBars volume={recording ? volume : undefined} />
      )}
    </button>
  );
}
