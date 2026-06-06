// src/voice/useVoiceDictation.ts
//
// One-shot voice DICTATION: record (mic + VAD) → transcribe the first utterance
// (or a manual stop) via the whisper path → hand the text back. Used for both
// the tutor answer button and the chat input's mic (speech-to-text into the
// field, NOT a full spoken conversation — that's the orb VoiceMode).

import { useRef, useState } from "react";
import { startVoiceCapture, type VoiceCapture } from "./voiceCapture";
import { transcribeVoice } from "./voiceStt";
import { notify } from "../store/appDialog";

export type DictationState = "idle" | "recording" | "transcribing";

/** Turn a getUserMedia / AudioContext failure into actionable Chinese copy —
 *  these used to be swallowed silently, so the mic button looked dead. */
function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? "";
  const msg = e instanceof Error ? e.message : String(e);
  if (name === "NotAllowedError" || /permission|denied|not allowed/i.test(msg)) {
    return "麦克风权限被拒绝。请到 Windows 设置 → 隐私和安全性 → 麦克风，允许桌面应用使用麦克风，然后重启 whatsub 再试。";
  }
  if (name === "NotFoundError" || /not found|no .*device|requested device/i.test(msg)) {
    return "没检测到麦克风设备，请确认麦克风已插好。";
  }
  if (/audiocontext/i.test(msg)) {
    return "音频初始化失败，请重试或重启应用。";
  }
  return `语音输入启动失败：${msg}`;
}

/** Raw mic RMS rarely exceeds ~0.08 even when speaking; map onto 0..1 so the
 *  waveform bars actually move. */
const VOLUME_FULL_SCALE = 0.08;

export function useVoiceDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>("idle");
  const [volume, setVolume] = useState(0); // 0..1 mic level (for waveform bars)
  const capRef = useRef<VoiceCapture | null>(null);
  const handledRef = useRef(false);
  // Keep the latest callback so the async capture closure never goes stale.
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const teardown = () => {
    capRef.current?.stop();
    capRef.current = null;
    setVolume(0);
  };

  const start = async () => {
    handledRef.current = false;
    setState("recording");
    try {
      capRef.current = await startVoiceCapture({
        onLevel: (rms) => setVolume(Math.min(1, rms / VOLUME_FULL_SCALE)),
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
        onError: (e) => {
          teardown();
          setState("idle");
          void notify(micErrorMessage(e));
        },
      });
    } catch (e) {
      // mic denied / AudioContext failed — surface it instead of looking dead.
      setState("idle");
      void notify(micErrorMessage(e));
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

  return { state, toggle, volume };
}
