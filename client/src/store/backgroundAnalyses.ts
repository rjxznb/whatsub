import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { runAnalysis } from "../llm/analyze";
import { getProvider } from "../llm/providers";
import { dedupSubtitles } from "./analysis";
import { useSettings } from "./settings";
import type { Subtitle, SrtCue, AnalysisResult } from "../llm/types";
import type { TranslationStyle } from "../types/settings";

/**
 * Background-analysis store. Parallel to `useAnalysis` (which stays
 * single-slot for the active Player view); this one tracks every
 * detached analysis loop keyed by videoId so multiple can run at the
 * same time.
 *
 * Lifecycle:
 *  1. User clicks 「在后台解析」 in Player → snapshot of useAnalysis is
 *     handed to runInBackground(); foreground AbortController is aborted;
 *     Player navigates away.
 *  2. runInBackground spawns its own AbortController, registers a job,
 *     calls runAnalysis with onCue/onSummary writing into THIS store
 *     + scheduling save_analysis to disk every 800ms.
 *  3. On completion: save final, mark "done", linger 4s, remove.
 *  4. On user cancel from queue widget: AbortController.abort(), remove
 *     immediately.
 *  5. On Player re-mount for the same videoId: caller (Player effect)
 *     can call `takeOver()` which cancels the BG run, returns the
 *     accumulated state, and the Player resumes in the foreground from
 *     where BG left off.
 */

export interface BgAnalysisJob {
  videoId: string;
  /** Short human label (uses library title once available; falls back
   *  to videoId). */
  label: string;
  phase: "analyzing" | "done" | "error";
  /** Count of cues analyzed so far (for the progress bar). */
  subtitleCount: number;
  /** Total cues from the transcript — used to compute percent. */
  totalCues: number;
  errorMessage: string | null;
  startedAt: number;
  /** Accumulated analyzed subtitles. Drives the takeover hand-back. */
  subtitles: Subtitle[];
  /** Accumulated keyPhrases summary (phase 2 of runAnalysis). */
  summary: Omit<AnalysisResult, "subtitles"> | null;
}

interface BgStore {
  jobs: Record<string, BgAnalysisJob>;
}

export const useBgAnalyses = create<BgStore>(() => ({ jobs: {} }));

// Module-level AbortController registry. NOT in the zustand store
// because AbortControllers are not serializable and don't fit into
// pure state mutations.
const bgControllers = new Map<string, AbortController>();
// Throttled-save timer per video so multiple cue arrivals coalesce
// into ~1 disk write per second.
const bgSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export interface RunInBackgroundOptions {
  videoId: string;
  label: string;
  /** All cues from the transcript (full SRT). */
  cues: SrtCue[];
  /** Snapshot of cues already analyzed at handoff time. The BG run
   *  resumes from index = previouslyAnalyzed.length. */
  previouslyAnalyzed: Subtitle[];
  /** Snapshot of the keyPhrases summary if phase 2 of runAnalysis
   *  already fired (rare for handoff timing, but possible). */
  previousSummary: Omit<AnalysisResult, "subtitles"> | null;
  /** Translation register chosen at import time. */
  style: TranslationStyle;
}

/**
 * Start a background analysis. Idempotent on (videoId): if a job is
 * already running for the same id, the previous one is cancelled and a
 * fresh one starts from the given snapshot. The caller (Player) is
 * responsible for first aborting its own foreground AbortController.
 */
export function runInBackground(opts: RunInBackgroundOptions): void {
  const { videoId } = opts;

  // If a job is already running for this video, replace it.
  const existing = bgControllers.get(videoId);
  if (existing) {
    existing.abort();
    bgControllers.delete(videoId);
  }
  clearSaveTimer(videoId);

  const ac = new AbortController();
  bgControllers.set(videoId, ac);

  useBgAnalyses.setState((state) => ({
    jobs: {
      ...state.jobs,
      [videoId]: {
        videoId,
        label: opts.label,
        phase: "analyzing",
        subtitleCount: opts.previouslyAnalyzed.length,
        totalCues: opts.cues.length,
        errorMessage: null,
        startedAt: Date.now(),
        subtitles: opts.previouslyAnalyzed.slice(),
        summary: opts.previousSummary,
      },
    },
  }));

  // Fire-and-forget. Errors are captured below and surfaced via the
  // job's `phase = "error"`; we deliberately don't reject upward.
  void driveBgAnalysis(ac, opts);
}

async function driveBgAnalysis(ac: AbortController, opts: RunInBackgroundOptions): Promise<void> {
  const { videoId } = opts;
  const remaining = opts.cues.slice(opts.previouslyAnalyzed.length);
  const provider = getProvider(useSettings.getState().settings);

  try {
    if (remaining.length > 0) {
      await runAnalysis({
        provider,
        cues: remaining,
        previouslyAnalyzed: opts.previouslyAnalyzed,
        style: opts.style,
        signal: ac.signal,
        onCue: (c: Subtitle) => {
          if (ac.signal.aborted) return;
          useBgAnalyses.setState((state) => {
            const job = state.jobs[videoId];
            if (!job) return state;
            // Dedup-on-append: same (time, endTime, text) means a
            // retry produced a duplicate — drop it. Matches the
            // foreground useAnalysis behaviour.
            const key = cueKey(c);
            if (job.subtitles.some((x) => cueKey(x) === key)) return state;
            return {
              jobs: {
                ...state.jobs,
                [videoId]: {
                  ...job,
                  subtitles: [...job.subtitles, c],
                  subtitleCount: job.subtitleCount + 1,
                },
              },
            };
          });
          schedulePartialSave(videoId);
        },
        onSummary: (s) => {
          if (ac.signal.aborted) return;
          useBgAnalyses.setState((state) => {
            const job = state.jobs[videoId];
            if (!job) return state;
            return {
              jobs: { ...state.jobs, [videoId]: { ...job, summary: s } },
            };
          });
          schedulePartialSave(videoId);
        },
      });
    }

    if (ac.signal.aborted) return;

    // Phase 2 (summary) completed — write final analysis.json and flip
    // library status to ready. If phase 2 didn't run (no cues, or LLM
    // skipped), the partial-save loop above already persisted what we
    // have.
    clearSaveTimer(videoId);
    const finalJob = useBgAnalyses.getState().jobs[videoId];
    if (finalJob) {
      const finalAnalysis: AnalysisResult = {
        subtitles: dedupSubtitles(finalJob.subtitles),
        keyPhrases: finalJob.summary?.keyPhrases ?? [],
      };
      try {
        await invoke("save_analysis", { videoId, analysis: finalAnalysis });
        if (finalAnalysis.keyPhrases.length > 0) {
          await invoke("library_set_status", {
            id: videoId,
            status: "ready",
            error: null,
          });
        }
      } catch (e) {
        console.warn("BG final save failed", e);
      }
    }

    // Mark done; linger 4s so user sees the green check, then drop.
    useBgAnalyses.setState((state) => {
      const job = state.jobs[videoId];
      if (!job) return state;
      return {
        jobs: { ...state.jobs, [videoId]: { ...job, phase: "done" } },
      };
    });
    bgControllers.delete(videoId);
    setTimeout(() => {
      useBgAnalyses.setState((state) => {
        if (!state.jobs[videoId]) return state;
        const next = { ...state.jobs };
        delete next[videoId];
        return { jobs: next };
      });
    }, 4000);
  } catch (e: unknown) {
    const isAbort =
      ac.signal.aborted ||
      (e instanceof DOMException && e.name === "AbortError") ||
      (typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError");
    if (isAbort) {
      // User cancelled — flush partial, then drop the job. Cancel by
      // takeover removes the job upstream; we still try the disk
      // save here so what was generated isn't lost.
      clearSaveTimer(videoId);
      const job = useBgAnalyses.getState().jobs[videoId];
      if (job && job.subtitles.length > 0) {
        const partial: AnalysisResult = {
          subtitles: dedupSubtitles(job.subtitles),
          keyPhrases: job.summary?.keyPhrases ?? [],
        };
        invoke("save_analysis", { videoId, analysis: partial }).catch((err) =>
          console.warn("BG abort partial save failed", err)
        );
      }
      bgControllers.delete(videoId);
      return;
    }
    useBgAnalyses.setState((state) => {
      const job = state.jobs[videoId];
      if (!job) return state;
      return {
        jobs: {
          ...state.jobs,
          [videoId]: { ...job, phase: "error", errorMessage: String(e) },
        },
      };
    });
    bgControllers.delete(videoId);
  }
}

/**
 * User-initiated cancel from the queue widget. Aborts the in-flight
 * controller and removes the job from the store. The catch handler in
 * driveBgAnalysis sees the abort and writes a partial save for resume.
 */
export function cancelBackground(videoId: string): void {
  const ac = bgControllers.get(videoId);
  if (ac) {
    ac.abort();
    bgControllers.delete(videoId);
  }
  clearSaveTimer(videoId);
  useBgAnalyses.setState((state) => {
    if (!state.jobs[videoId]) return state;
    const next = { ...state.jobs };
    delete next[videoId];
    return { jobs: next };
  });
}

/**
 * Called by Player on mount for a videoId that has a BG job. Cancels
 * the BG controller (no more BG writes) and returns the accumulated
 * state so Player can promote it into useAnalysis and continue in
 * the foreground from where BG left off.
 */
export function takeOverBackground(
  videoId: string,
): { subtitles: Subtitle[]; summary: Omit<AnalysisResult, "subtitles"> | null } | null {
  const job = useBgAnalyses.getState().jobs[videoId];
  if (!job) return null;
  const ac = bgControllers.get(videoId);
  if (ac) {
    ac.abort();
    bgControllers.delete(videoId);
  }
  clearSaveTimer(videoId);
  // Drop the job from the queue UI — Player owns it from here.
  useBgAnalyses.setState((state) => {
    const next = { ...state.jobs };
    delete next[videoId];
    return { jobs: next };
  });
  return { subtitles: job.subtitles, summary: job.summary };
}

function schedulePartialSave(videoId: string): void {
  clearSaveTimer(videoId);
  const t = setTimeout(() => {
    const job = useBgAnalyses.getState().jobs[videoId];
    if (!job) return;
    const partial: AnalysisResult = {
      subtitles: dedupSubtitles(job.subtitles),
      keyPhrases: job.summary?.keyPhrases ?? [],
    };
    invoke("save_analysis", { videoId, analysis: partial }).catch((e) =>
      console.warn("BG partial save failed", e)
    );
  }, 800);
  bgSaveTimers.set(videoId, t);
}

function clearSaveTimer(videoId: string): void {
  const t = bgSaveTimers.get(videoId);
  if (t) {
    clearTimeout(t);
    bgSaveTimers.delete(videoId);
  }
}

function cueKey(c: Subtitle): string {
  return `${c.time}|${c.endTime}|${c.text}`;
}
