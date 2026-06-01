// src/tutor/ttsStatus.ts
//
// Tiny reactive store reporting which TTS engine actually played the last
// utterance — so the UI can show whether we're on the online Edge neural
// voice ("edge") or the local Web Speech fallback ("local"), and WHY it fell
// back. Purely diagnostic.

import { create } from "zustand";

export type TtsEngine = "idle" | "edge" | "local";

interface TtsStatusStore {
  engine: TtsEngine;
  /** When engine === "local": the edge-tts failure reason that caused the
   *  fallback (network / autoplay / GEC / …). Empty otherwise. */
  reason: string;
  set: (engine: TtsEngine, reason?: string) => void;
}

export const useTtsStatus = create<TtsStatusStore>((set) => ({
  engine: "idle",
  reason: "",
  set: (engine, reason = "") => set({ engine, reason }),
}));
