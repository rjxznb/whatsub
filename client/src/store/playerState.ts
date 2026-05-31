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
  /** Registered by Player.tsx — seek to `start`, play, and auto-pause at
   *  `end`. Used by 精讲's 重听原句 to replay just one cue's audio while the
   *  full-screen lesson overlay is up (the video is heard, not seen). */
  playRangeHandler: ((start: number, end: number) => void) | null;
  /** Registered by Player.tsx — pause the video, returning whether it was
   *  playing. Voice mode pauses the video while the AI conversation is up. */
  pauseHandler: (() => boolean) | null;
  /** Registered by Player.tsx — resume playback (used on voice-mode close). */
  playHandler: (() => void) | null;
  setActive: (args: { videoId: string; videoTitle: string }) => void;
  setCue: (args: { currentIdx: number | null; currentTime: number | null }) => void;
  setSeekHandler: (fn: ((sec: number) => void) | null) => void;
  setPlayRangeHandler: (fn: ((start: number, end: number) => void) | null) => void;
  setPauseHandler: (fn: (() => boolean) | null) => void;
  setPlayHandler: (fn: (() => void) | null) => void;
  clear: () => void;
}

export const usePlayerState = create<PlayerStateStore>((set) => ({
  videoId: null,
  currentIdx: null,
  currentTime: null,
  videoTitle: null,
  seekHandler: null,
  playRangeHandler: null,
  pauseHandler: null,
  playHandler: null,
  setActive: ({ videoId, videoTitle }) => set({ videoId, videoTitle }),
  setCue: ({ currentIdx, currentTime }) => set({ currentIdx, currentTime }),
  setSeekHandler: (fn) => set({ seekHandler: fn }),
  setPlayRangeHandler: (fn) => set({ playRangeHandler: fn }),
  setPauseHandler: (fn) => set({ pauseHandler: fn }),
  setPlayHandler: (fn) => set({ playHandler: fn }),
  clear: () =>
    set({
      videoId: null,
      currentIdx: null,
      currentTime: null,
      videoTitle: null,
      seekHandler: null,
      playRangeHandler: null,
      pauseHandler: null,
      playHandler: null,
    }),
}));
