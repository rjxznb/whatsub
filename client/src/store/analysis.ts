import { create } from "zustand";
import type { Subtitle, AnalysisResult } from "../llm/types";

export type AnalysisPhase =
  | "idle"
  | "downloading"
  | "extracting"
  | "transcribing"
  | "analyzing"
  | "complete"
  | "error";

interface AnalysisState {
  videoId: string | null;
  phase: AnalysisPhase;
  progressPercent: number;
  subtitles: Subtitle[];
  summary: Omit<AnalysisResult, "subtitles"> | null;
  errorMessage: string | null;

  startFor: (videoId: string) => void;
  setPhase: (phase: AnalysisPhase, percent?: number) => void;
  appendSubtitle: (s: Subtitle) => void;
  setSubtitles: (s: Subtitle[]) => void;
  setSummary: (s: Omit<AnalysisResult, "subtitles">) => void;
  setError: (msg: string) => void;
  reset: () => void;
}

export const useAnalysis = create<AnalysisState>((set) => ({
  videoId: null,
  phase: "idle",
  progressPercent: 0,
  subtitles: [],
  summary: null,
  errorMessage: null,

  startFor: (id) =>
    set({
      videoId: id,
      phase: "downloading",
      progressPercent: 0,
      subtitles: [],
      summary: null,
      errorMessage: null,
    }),
  setPhase: (phase, percent) =>
    set((s) => ({ phase, progressPercent: percent ?? s.progressPercent })),
  appendSubtitle: (s) => set((st) => ({ subtitles: [...st.subtitles, s] })),
  setSubtitles: (s) => set({ subtitles: s }),
  setSummary: (s) => set({ summary: s }),
  setError: (msg) => set({ phase: "error", errorMessage: msg }),
  reset: () =>
    set({
      videoId: null,
      phase: "idle",
      progressPercent: 0,
      subtitles: [],
      summary: null,
      errorMessage: null,
    }),
}));
