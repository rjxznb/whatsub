import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  executeAnalysisSession,
  openStoredAnalysisSession,
  StaleAnalysisSessionError,
  type PersistedAnalysisSession,
} from "../llm/analysisSession";
import type { AnalysisPreview } from "../llm/analyze";
import { analysisRetryMessage } from "../llm/analysisRetryMessage";
import { getProvider } from "../llm/providers";
import { useSettings } from "./settings";
import { useLibrary } from "./library";
import type { CheckpointedAnalysis, SrtCue, Subtitle } from "../llm/types";
import type { TranslationStyle } from "../types/settings";
import {
  quotaDetailsFromRelayError,
  type QuotaExhaustedDetails,
} from "../llm/quotaRecovery";

export interface BgAnalysisJob {
  videoId: string;
  label: string;
  phase: "transcribing" | "analyzing" | "done" | "error";
  /** Visible model outputs, including the current uncommitted preview. */
  subtitleCount: number;
  /** Authoritative count of transcript inputs committed to analysis.json. */
  committedCueOffset: number;
  totalCues: number;
  errorMessage: string | null;
  quotaError: QuotaExhaustedDetails | null;
  retryMessage: string | null;
  startedAt: number;
  subtitles: Subtitle[];
  summary: { keyPhrases: CheckpointedAnalysis["keyPhrases"] } | null;
}

interface BgStore {
  jobs: Record<string, BgAnalysisJob>;
}

export const useBgAnalyses = create<BgStore>(() => ({ jobs: {} }));

type RuntimeDisposition = "background" | "takeover" | "cancel";

interface BgRuntime {
  videoId: string;
  label: string;
  style: TranslationStyle;
  mode: "analysis" | "retranscribe";
  whisperModel?: string;
  session: PersistedAnalysisSession | null;
  cues: SrtCue[] | null;
  controller: AbortController;
  disposition: RuntimeDisposition;
  needsSessionReload: boolean;
  runner: Promise<void>;
}

const runtimes = new Map<string, BgRuntime>();

export interface RunInBackgroundOptions {
  videoId: string;
  label: string;
  cues: SrtCue[];
  session: PersistedAnalysisSession;
  style: TranslationStyle;
  /** Foreground request teardown that must finish before background consumes the lease. */
  waitFor?: Promise<unknown>;
}

export interface BackgroundTakeover {
  session: PersistedAnalysisSession;
  cues: SrtCue[];
  analysis: CheckpointedAnalysis;
  errorMessage: string | null;
  quotaError: QuotaExhaustedDetails | null;
}

/** Transfer an existing producer lease into the background without reopening it. */
export function runInBackground(opts: RunInBackgroundOptions): void {
  if (runtimes.has(opts.videoId)) return;

  const runtime: BgRuntime = {
    videoId: opts.videoId,
    label: opts.label,
    style: opts.style,
    mode: "analysis",
    session: opts.session,
    cues: opts.cues,
    controller: new AbortController(),
    disposition: "background",
    needsSessionReload: false,
    runner: Promise.resolve(),
  };
  runtimes.set(opts.videoId, runtime);
  publishAnalysis(runtime, opts.session.analysis, "analyzing");
  runtime.runner = (async () => {
    try {
      await opts.waitFor;
      if (runtime.controller.signal.aborted) return;
      await driveAnalysis(runtime);
    } catch (error) {
      failRuntime(runtime, error);
    }
  })();
}

export interface RetranscribeBgOptions {
  videoId: string;
  label: string;
  style: TranslationStyle;
  whisperModel: string;
}

/** Explicit re-transcription starts without a lease, then creates one for the new transcript. */
export function retranscribeAndAnalyzeInBackground(opts: RetranscribeBgOptions): void {
  if (runtimes.has(opts.videoId)) return;
  const runtime: BgRuntime = {
    videoId: opts.videoId,
    label: opts.label,
    style: opts.style,
    mode: "retranscribe",
    whisperModel: opts.whisperModel,
    session: null,
    cues: null,
    controller: new AbortController(),
    disposition: "background",
    needsSessionReload: false,
    runner: Promise.resolve(),
  };
  runtimes.set(opts.videoId, runtime);
  useBgAnalyses.setState((state) => ({
    jobs: {
      ...state.jobs,
      [opts.videoId]: {
        videoId: opts.videoId,
        label: opts.label,
        phase: "transcribing",
        subtitleCount: 0,
        committedCueOffset: 0,
        totalCues: 0,
        errorMessage: null,
        quotaError: null,
        retryMessage: null,
        startedAt: Date.now(),
        subtitles: [],
        summary: null,
      },
    },
  }));
  runtime.runner = driveRetranscribeThenAnalyze(runtime);
}

async function driveRetranscribeThenAnalyze(runtime: BgRuntime): Promise<void> {
  try {
    await invoke("retranscribe_video", {
      videoId: runtime.videoId,
      whisperModel: runtime.whisperModel,
    });
    if (runtime.controller.signal.aborted) return;

    const stored = await openStoredAnalysisSession(runtime.videoId, {
      reset: true,
      style: runtime.style,
    });
    if (!stored) throw new Error("找不到 transcript.srt — 重新转录可能失败了");
    if (runtime.controller.signal.aborted) {
      await stored.session.close().catch(() => {});
      return;
    }

    runtime.cues = stored.cues;
    runtime.session = stored.session;
    runtime.needsSessionReload = false;
    if (runtime.controller.signal.aborted) return;
    publishAnalysis(runtime, runtime.session.analysis, "analyzing");
    await driveAnalysis(runtime);
  } catch (error) {
    failRuntime(runtime, error);
  } finally {
    if (runtime.controller.signal.aborted && runtime.disposition === "cancel") {
      await runtime.session?.close().catch(() => {});
    }
  }
}

async function driveAnalysis(runtime: BgRuntime): Promise<void> {
  const session = runtime.session;
  const cues = runtime.cues;
  if (!session || !cues || runtime.controller.signal.aborted) return;

  try {
    const completed = await executeAnalysisSession({
      session,
      provider: getProvider(useSettings.getState().settings),
      cues,
      style: runtime.style,
      signal: runtime.controller.signal,
      onCommitted: (analysis) => {
        if (runtimes.get(runtime.videoId) !== runtime) return;
        publishAnalysis(runtime, analysis, "analyzing");
      },
      onPreview: (committed, preview) => {
        publishPreview(runtime, committed, preview);
      },
      onRetry: (event) => {
        if (runtimes.get(runtime.videoId) !== runtime) return;
        updateJob(runtime.videoId, (job) => ({
          ...job,
          retryMessage: analysisRetryMessage(event),
        }));
      },
    });

    if (runtime.controller.signal.aborted || runtime.disposition !== "background") return;
    if (completed.checkpoint.phase !== "complete") return;

    await invoke("library_set_status", {
      id: runtime.videoId,
      status: "ready",
      error: null,
    });
    await useLibrary.getState().reload();
    publishAnalysis(runtime, completed, "done");
    const completedJob = useBgAnalyses.getState().jobs[runtime.videoId];
    runtimes.delete(runtime.videoId);
    await session.close();
    setTimeout(() => {
      if (useBgAnalyses.getState().jobs[runtime.videoId] === completedJob) {
        removeJob(runtime.videoId);
      }
    }, 4000);
  } catch (error) {
    failRuntime(runtime, error);
  }
}

function publishAnalysis(
  runtime: BgRuntime,
  analysis: CheckpointedAnalysis,
  phase: BgAnalysisJob["phase"],
): void {
  const previous = useBgAnalyses.getState().jobs[runtime.videoId];
  useBgAnalyses.setState((state) => ({
    jobs: {
      ...state.jobs,
      [runtime.videoId]: {
        videoId: runtime.videoId,
        label: runtime.label,
        phase,
        subtitleCount: analysis.subtitles.length,
        committedCueOffset: analysis.checkpoint.nextCueOffset,
        totalCues: runtime.cues?.length ?? 0,
        errorMessage: null,
        quotaError: null,
        retryMessage: null,
        startedAt: previous?.startedAt ?? Date.now(),
        subtitles: analysis.subtitles,
        summary: { keyPhrases: analysis.keyPhrases },
      },
    },
  }));
}

function publishPreview(
  runtime: BgRuntime,
  committed: CheckpointedAnalysis,
  preview: AnalysisPreview | null,
): void {
  if (runtimes.get(runtime.videoId) !== runtime) return;
  publishAnalysis(
    runtime,
    {
      ...committed,
      subtitles: [...committed.subtitles, ...(preview?.subtitles ?? [])],
    },
    "analyzing",
  );
}

function failRuntime(runtime: BgRuntime, error: unknown): void {
  if (runtime.controller.signal.aborted) return;
  // Once a lease is known stale, keep recovery in transcript-reopen mode
  // across temporary load/open failures.  Clearing this bit while session is
  // null would incorrectly route the next retry through Whisper.
  runtime.needsSessionReload ||= error instanceof StaleAnalysisSessionError;
  updateJob(runtime.videoId, (job) => {
    const committedCueOffset =
      runtime.session?.analysis.checkpoint.nextCueOffset ??
      job.committedCueOffset;
    const totalCues = runtime.cues?.length ?? job.totalCues;
    return {
      ...job,
      phase: "error",
      retryMessage: null,
      errorMessage: error instanceof Error ? error.message : String(error),
      quotaError: quotaDetailsFromRelayError(
        error,
        committedCueOffset,
        totalCues,
      ),
    };
  });
}

async function reopenStaleSessionAndContinue(runtime: BgRuntime): Promise<void> {
  try {
    const staleSession = runtime.session;
    runtime.session = null;
    await staleSession?.close().catch(() => {});
    if (runtime.controller.signal.aborted || runtime.disposition !== "background") return;

    const stored = await openStoredAnalysisSession(runtime.videoId, {
      style: runtime.style,
    });
    if (!stored) throw new Error("找不到 transcript.srt — 无法恢复解析进度");
    const { cues, session } = stored;
    if (runtime.controller.signal.aborted || runtime.disposition !== "background") {
      await session.close().catch(() => {});
      return;
    }

    runtime.cues = cues;
    runtime.session = session;
    runtime.needsSessionReload = false;
    publishAnalysis(runtime, session.analysis, "analyzing");
    await driveAnalysis(runtime);
  } catch (error) {
    failRuntime(runtime, error);
  }
}

/** Retry a failed background stage while preserving its lease/checkpoint. */
export function resumeBackgroundAnalysis(videoId: string): void {
  const runtime = runtimes.get(videoId);
  const job = useBgAnalyses.getState().jobs[videoId];
  if (!runtime || job?.phase !== "error") return;

  runtime.controller = new AbortController();
  runtime.disposition = "background";
  updateJob(videoId, (current) => ({
    ...current,
    phase: runtime.session ? "analyzing" : "transcribing",
    errorMessage: null,
    quotaError: null,
    retryMessage: null,
  }));
  runtime.runner = runtime.needsSessionReload || (runtime.mode === "analysis" && !runtime.session)
    ? reopenStaleSessionAndContinue(runtime)
    : runtime.session
      ? driveAnalysis(runtime)
      : driveRetranscribeThenAnalyze(runtime);
}

/** Cancel background work, then close its lease after the current task exits. */
export async function cancelBackground(videoId: string): Promise<void> {
  const runtime = runtimes.get(videoId);
  if (!runtime) {
    removeJob(videoId);
    return;
  }
  runtime.disposition = "cancel";
  runtime.controller.abort();
  if (runtime.mode === "retranscribe" && !runtime.session) {
    await invoke("cancel_import", { videoId }).catch(() => {});
  }
  await runtime.runner.catch(() => {});
  await runtime.session?.close().catch(() => {});
  if (runtimes.get(videoId) === runtime) runtimes.delete(videoId);
  removeJob(videoId);
}

/** Reverse handoff: abort only the uncommitted batch and return the same lease. */
export async function takeOverBackground(videoId: string): Promise<BackgroundTakeover | null> {
  const runtime = runtimes.get(videoId);
  if (!runtime) return null;
  const failedJob = useBgAnalyses.getState().jobs[videoId];
  const errorMessage = failedJob?.errorMessage ?? null;
  const quotaError = failedJob?.quotaError ?? null;
  runtime.disposition = "takeover";
  runtime.controller.abort();
  if (runtime.mode === "retranscribe" && !runtime.session) {
    await invoke("cancel_import", { videoId }).catch(() => {});
  }
  await runtime.runner.catch(() => {});
  if (runtimes.get(videoId) === runtime) runtimes.delete(videoId);
  removeJob(videoId);
  if (!runtime.session || !runtime.cues) return null;
  return {
    session: runtime.session,
    cues: runtime.cues,
    analysis: runtime.session.analysis,
    errorMessage,
    quotaError,
  };
}

function updateJob(videoId: string, update: (job: BgAnalysisJob) => BgAnalysisJob): void {
  useBgAnalyses.setState((state) => {
    const job = state.jobs[videoId];
    if (!job) return state;
    return { jobs: { ...state.jobs, [videoId]: update(job) } };
  });
}

function removeJob(videoId: string): void {
  useBgAnalyses.setState((state) => {
    if (!state.jobs[videoId]) return state;
    const jobs = { ...state.jobs };
    delete jobs[videoId];
    return { jobs };
  });
}
