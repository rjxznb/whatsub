import { create } from "zustand";

interface PlayerStateStore {
  videoId: string | null;
  currentIdx: number | null;
  currentTime: number | null;
  videoTitle: string | null;
  /** Registered by Player.tsx on mount via a videoRef-closure callback so
   *  the AI Agent's seek tools (seek_to_time / jump_to_cue) can drive the
   *  player without importing Player.tsx internals. Null when not on the
   *  Player page (set on Player mount, cleared on unmount). */
  seekHandler: ((sec: number) => void) | null;
  setActive: (args: { videoId: string; videoTitle: string }) => void;
  setCue: (args: { currentIdx: number | null; currentTime: number | null }) => void;
  setSeekHandler: (fn: ((sec: number) => void) | null) => void;
  clear: () => void;
}

export const usePlayerState = create<PlayerStateStore>((set) => ({
  videoId: null,
  currentIdx: null,
  currentTime: null,
  videoTitle: null,
  seekHandler: null,
  setActive: ({ videoId, videoTitle }) => set({ videoId, videoTitle }),
  setCue: ({ currentIdx, currentTime }) => set({ currentIdx, currentTime }),
  setSeekHandler: (fn) => set({ seekHandler: fn }),
  clear: () =>
    set({
      videoId: null,
      currentIdx: null,
      currentTime: null,
      videoTitle: null,
      seekHandler: null,
    }),
}));
