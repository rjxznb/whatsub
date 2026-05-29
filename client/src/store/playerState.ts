import { create } from "zustand";

interface PlayerStateStore {
  videoId: string | null;
  currentIdx: number | null;
  currentTime: number | null;
  videoTitle: string | null;
  setActive: (args: { videoId: string; videoTitle: string }) => void;
  setCue: (args: { currentIdx: number | null; currentTime: number | null }) => void;
  clear: () => void;
}

export const usePlayerState = create<PlayerStateStore>((set) => ({
  videoId: null,
  currentIdx: null,
  currentTime: null,
  videoTitle: null,
  setActive: ({ videoId, videoTitle }) => set({ videoId, videoTitle }),
  setCue: ({ currentIdx, currentTime }) => set({ currentIdx, currentTime }),
  clear: () => set({ videoId: null, currentIdx: null, currentTime: null, videoTitle: null }),
}));
