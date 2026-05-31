import { create } from "zustand";

interface VoiceModeState {
  open: boolean;
  openVoice: () => void;
  closeVoice: () => void;
}

export const useVoiceMode = create<VoiceModeState>((set) => ({
  open: false,
  openVoice: () => set({ open: true }),
  closeVoice: () => set({ open: false }),
}));
