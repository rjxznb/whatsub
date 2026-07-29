import { create } from "zustand";
import type {
  AnalysisCheckpoint,
  AnalysisResult,
  CheckpointedAnalysis,
  Subtitle,
} from "../llm/types";

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
  | "paused"
  | "complete"
  | "error";

export type AnalysisErrorStage = "transcription" | "analysis";

interface AnalysisState {
  videoId: string | null;
  phase: AnalysisPhase;
  progressPercent: number;
  subtitles: Subtitle[];
  summary: Omit<AnalysisResult, "subtitles"> | null;
  checkpoint: AnalysisCheckpoint | null;
  errorMessage: string | null;
  errorStage: AnalysisErrorStage | null;
  retryMessage: string | null;
  /** True when the error is a whatSub-relay upsell wall (quota / license) —
   *  ProgressBanner then shows a 「升级 Pro」 CTA next to the message. */
  errorUpsell: boolean;

  startFor: (videoId: string) => void;
  setPhase: (phase: AnalysisPhase, percent?: number) => void;
  appendSubtitle: (s: Subtitle) => void;
  setSubtitles: (s: Subtitle[]) => void;
  setSummary: (s: Omit<AnalysisResult, "subtitles">) => void;
  setCommittedAnalysis: (analysis: CheckpointedAnalysis, totalCues: number) => void;
  setRetryMessage: (message: string | null) => void;
  setError: (msg: string, upsell?: boolean, stage?: AnalysisErrorStage) => void;
  updateSubtitle: (idx: number, partial: Partial<Subtitle>) => void;
  deleteSubtitle: (idx: number) => void;
  insertSubtitle: (idx: number, sub: Subtitle) => void;
  reorderSubtitles: (fromIdx: number, toIdx: number) => void;
  reset: () => void;
}

export const useAnalysis = create<AnalysisState>((set) => ({
  videoId: null,
  phase: "idle",
  progressPercent: 0,
  subtitles: [],
  summary: null,
  checkpoint: null,
  errorMessage: null,
  errorStage: null,
  retryMessage: null,
  errorUpsell: false,

  startFor: (id) =>
    set({
      videoId: id,
      phase: "downloading",
      progressPercent: 0,
      subtitles: [],
      summary: null,
      checkpoint: null,
      errorMessage: null,
      errorStage: null,
      retryMessage: null,
      errorUpsell: false,
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
  setCommittedAnalysis: (analysis, totalCues) =>
    set({
      subtitles: dedupSubtitles(analysis.subtitles),
      summary: { keyPhrases: analysis.keyPhrases },
      checkpoint: analysis.checkpoint,
      progressPercent: totalCues > 0
        ? Math.min(100, (analysis.checkpoint.nextCueOffset / totalCues) * 100)
        : 100,
      retryMessage: null,
    }),
  setRetryMessage: (retryMessage) => set({ retryMessage }),
  setError: (msg, upsell = false, stage = "analysis") =>
    set({
      phase: "error",
      errorMessage: msg,
      errorUpsell: upsell,
      errorStage: stage,
      retryMessage: null,
    }),
  updateSubtitle: (idx, partial) =>
    set((st) => ({
      subtitles: st.subtitles.map((s, i) => (i === idx ? { ...s, ...partial } : s)),
    })),
  deleteSubtitle: (idx) =>
    set((st) => ({ subtitles: st.subtitles.filter((_, i) => i !== idx) })),
  insertSubtitle: (idx, sub) =>
    set((st) => {
      const next = [...st.subtitles];
      const at = Math.max(0, Math.min(idx, next.length));
      next.splice(at, 0, sub);
      return { subtitles: next };
    }),
  reorderSubtitles: (fromIdx, toIdx) =>
    set((st) => {
      if (fromIdx === toIdx) return st;
      if (fromIdx < 0 || fromIdx >= st.subtitles.length) return st;
      const next = [...st.subtitles];
      const [moved] = next.splice(fromIdx, 1);
      const at = Math.max(0, Math.min(toIdx, next.length));
      next.splice(at, 0, moved);
      return { subtitles: next };
    }),
  reset: () =>
    set({
      videoId: null,
      phase: "idle",
      progressPercent: 0,
      subtitles: [],
      summary: null,
      checkpoint: null,
      errorMessage: null,
      errorStage: null,
      retryMessage: null,
      errorUpsell: false,
    }),
}));
