// src/voice/useVoiceDictation.ts
//
// One-shot voice DICTATION: record (mic + VAD) → transcribe the first utterance
// (or a manual stop) via the whisper path → hand the text back. Used for both
// the tutor answer button and the chat input's mic (speech-to-text into the
// field, NOT a full spoken conversation — that's the orb VoiceMode).

import { useRef, useState } from "react";
import { startVoiceCapture, type VoiceCapture } from "./voiceCapture";
import { transcribeVoice } from "./voiceStt";

export type DictationState = "idle" | "recording" | "transcribing";

export function useVoiceDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>("idle");
  const capRef = useRef<VoiceCapture | null>(null);
  const handledRef = useRef(false);
  // Keep the latest callback so the async capture closure never goes stale.
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

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
          if (handledRef.current) return; // one dictation per recording
          handledRef.current = true;
          teardown();
          setState("transcribing");
          try {
            const text = await transcribeVoice(wav);
            if (text.trim()) onTextRef.current(text.trim());
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

  /** Toggle: idle → record; recording → stop (flush transcribes if any). */
  const toggle = () => {
    if (state === "transcribing") return;
    if (state === "recording") {
      teardown();
      if (!handledRef.current) setState("idle");
      return;
    }
    void start();
  };

  return { state, toggle };
}
