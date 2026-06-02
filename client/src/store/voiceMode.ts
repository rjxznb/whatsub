import { create } from "zustand";

/** When voice mode is opened to run a roleplay, the caller supplies how to
 *  produce the AI character's reply (driving a RoleplayRuntime) + a title and
 *  an onClose hook (to finish/flush the runtime). Absent = normal agent chat. */
export interface VoiceRoleplay {
  title: string;
  respond: (userText: string, signal: AbortSignal) => Promise<string>;
  onClose?: () => void;
}

interface VoiceModeState {
  open: boolean;
  roleplay: VoiceRoleplay | null;
  /** Open voice mode. Pass a roleplay config to run a roleplay in the orb UI. */
  openVoice: (roleplay?: VoiceRoleplay | null) => void;
  closeVoice: () => void;
}

export const useVoiceMode = create<VoiceModeState>((set) => ({
  open: false,
  roleplay: null,
  openVoice: (roleplay = null) => set({ open: true, roleplay }),
  closeVoice: () => set({ open: false, roleplay: null }),
}));
