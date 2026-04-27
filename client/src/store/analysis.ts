import { create } from "zustand";
import type { Subtitle, AnalysisResult } from "../llm/types";

/** Drop entries that share (time, endTime, text) with a previous one. */
export function dedupSubtitles(subs: Subtitle[]): Subtitle[] {
  const seen = new Set<string>();
  const out: Subtitle[] = [];
  for (const s of subs) {
    const key = `${s.time}|${s.endTime}|${s.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

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
  appendSubtitle: (s) =>
    set((st) => {
      // Defensive dedup at append time too — if the same cue arrives via two
      // parallel runs (e.g. StrictMode double-mount race), only keep the first.
      const key = `${s.time}|${s.endTime}|${s.text}`;
      if (st.subtitles.some((x) => `${x.time}|${x.endTime}|${x.text}` === key)) {
        return st;
      }
      return { subtitles: [...st.subtitles, s] };
    }),
  setSubtitles: (s) => set({ subtitles: dedupSubtitles(s) }),
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
