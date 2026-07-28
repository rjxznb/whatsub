import { invoke } from "@tauri-apps/api/core";
import type { TranslationStyle } from "../types/settings";
import {
  runAnalysis,
  type AnalysisCommit,
  type AnalysisRetryEvent,
} from "./analyze";
import { parsePersistedAnalysis, prepareAnalysis } from "./analysisCheckpoint";
import type { Provider } from "./providers/types";
import type { CheckpointedAnalysis, SrtCue } from "./types";

interface AnalysisSessionStart {
  lease: string;
  analysis: unknown | null;
}

type SessionSaveStatus = "applied" | "alreadyCurrent" | "rejected";

interface SessionSaveOutcome {
  status: SessionSaveStatus;
  revision: number | null;
}

interface LocalSessionSlot {
  released: Promise<void>;
  release: () => void;
}

const localSessionSlots = new Map<string, LocalSessionSlot>();

export interface PersistedAnalysisSession {
  readonly videoId: string;
  readonly lease: string;
  readonly analysis: CheckpointedAnalysis;
  save(next: CheckpointedAnalysis): Promise<CheckpointedAnalysis>;
  close(): Promise<void>;
}

export class StaleAnalysisSessionError extends Error {
  constructor(
    videoId: string,
    public readonly outcome: SessionSaveOutcome | null = null,
  ) {
    super(`analysis session is stale for ${videoId}`);
    this.name = "StaleAnalysisSessionError";
  }
}

export async function openAnalysisSession(
  videoId: string,
  cues: readonly SrtCue[],
): Promise<PersistedAnalysisSession> {
  const release = await acquireLocalSessionSlot(videoId);
  try {
    const started = await begin(videoId, false);
    let prepared: Awaited<ReturnType<typeof prepareAnalysis>>;
    try {
      prepared = await prepareAnalysis(cues, started.analysis);
    } catch (error) {
      await endIgnoringFailure(videoId, started.lease);
      throw error;
    }

    if (prepared.reason === "fingerprint-mismatch") {
      await end(videoId, started.lease);
      return beginPreparedSession(videoId, cues, await begin(videoId, true), release);
    }

    return createPreparedSession(videoId, cues, started, prepared, release);
  } catch (error) {
    release();
    throw error;
  }
}

export async function resetAnalysisSession(
  videoId: string,
  cues: readonly SrtCue[],
): Promise<PersistedAnalysisSession> {
  const release = await acquireLocalSessionSlot(videoId);
  try {
    return await beginPreparedSession(videoId, cues, await begin(videoId, true), release);
  } catch (error) {
    release();
    throw error;
  }
}

async function beginPreparedSession(
  videoId: string,
  cues: readonly SrtCue[],
  started: AnalysisSessionStart,
  release: () => void,
): Promise<PersistedAnalysisSession> {
  let prepared: Awaited<ReturnType<typeof prepareAnalysis>>;
  try {
    prepared = await prepareAnalysis(cues, started.analysis);
  } catch (error) {
    await endIgnoringFailure(videoId, started.lease);
    throw error;
  }
  if (prepared.reason === "fingerprint-mismatch") {
    await end(videoId, started.lease);
    throw new Error(`reset analysis session retained a mismatched snapshot for ${videoId}`);
  }
  return createPreparedSession(videoId, cues, started, prepared, release);
}

async function createPreparedSession(
  videoId: string,
  cues: readonly SrtCue[],
  started: AnalysisSessionStart,
  prepared: Awaited<ReturnType<typeof prepareAnalysis>>,
  release: () => void,
): Promise<PersistedAnalysisSession> {
  const session = createSession(videoId, started.lease, cues, prepared.analysis, release);
  try {
    if (prepared.needsSave) await session.save(prepared.analysis);
    return session;
  } catch (error) {
    try {
      await session.close();
    } catch {
      // Preserve the save/validation error that prevented the session opening.
    }
    throw error;
  }
}

function createSession(
  videoId: string,
  lease: string,
  cues: readonly SrtCue[],
  initial: CheckpointedAnalysis,
  release: () => void,
): PersistedAnalysisSession {
  let current = initial;
  let stale = false;
  let closed = false;
  let saveTail = Promise.resolve();
  let closePromise: Promise<void> | undefined;

  const session: PersistedAnalysisSession = {
    videoId,
    lease,
    get analysis() {
      return current;
    },
    save(next) {
      const operation = saveTail.then(async () => {
        if (closed || stale) throw new StaleAnalysisSessionError(videoId);
        const validated = await validateCandidate(cues, next);
        const outcome = await invoke<SessionSaveOutcome>("save_analysis_session", {
          videoId,
          lease,
          analysis: validated,
        });
        if (outcome.status === "rejected") {
          stale = true;
          throw new StaleAnalysisSessionError(videoId, outcome);
        }
        current = validated;
        return current;
      });
      saveTail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    close() {
      closed = true;
      closePromise ??= saveTail
        .then(() => end(videoId, lease))
        .finally(release);
      return closePromise;
    },
  };
  return session;
}

async function validateCandidate(
  cues: readonly SrtCue[],
  candidate: CheckpointedAnalysis,
): Promise<CheckpointedAnalysis> {
  const parsed = parsePersistedAnalysis(candidate);
  if (!parsed?.checkpoint) {
    throw new TypeError("analysis session save requires a valid checkpointed analysis");
  }
  const prepared = await prepareAnalysis(cues, parsed);
  if (prepared.reason !== "resume") {
    throw new TypeError("analysis checkpoint does not match the session transcript");
  }
  return parsed as CheckpointedAnalysis;
}

async function begin(videoId: string, reset: boolean): Promise<AnalysisSessionStart> {
  return invoke<AnalysisSessionStart>("begin_analysis_session", { videoId, reset });
}

async function end(videoId: string, lease: string): Promise<void> {
  await invoke<void>("end_analysis_session", { videoId, lease });
}

async function endIgnoringFailure(videoId: string, lease: string): Promise<void> {
  try {
    await end(videoId, lease);
  } catch {
    // The original preparation error is more actionable to the caller.
  }
}

async function acquireLocalSessionSlot(videoId: string): Promise<() => void> {
  const previous = localSessionSlots.get(videoId)?.released ?? Promise.resolve();
  let resolveRelease!: () => void;
  let didRelease = false;
  const slot: LocalSessionSlot = {
    released: new Promise<void>((resolve) => {
      resolveRelease = resolve;
    }),
    release: () => {
      if (didRelease) return;
      didRelease = true;
      resolveRelease();
      if (localSessionSlots.get(videoId) === slot) localSessionSlots.delete(videoId);
    },
  };
  localSessionSlots.set(videoId, slot);
  await previous;
  return slot.release;
}

export async function executeAnalysisSession(options: {
  session: PersistedAnalysisSession;
  provider: Provider;
  cues: readonly SrtCue[];
  style: TranslationStyle;
  signal?: AbortSignal;
  onCommitted?: (analysis: CheckpointedAnalysis, commit: AnalysisCommit) => void;
  onRetry?: (event: AnalysisRetryEvent) => void;
}): Promise<CheckpointedAnalysis> {
  let committed = options.session.analysis;
  await runAnalysis({
    provider: options.provider,
    cues: options.cues,
    previouslyAnalyzed: committed.subtitles,
    checkpoint: committed.checkpoint,
    style: options.style,
    signal: options.signal,
    onRetry: options.onRetry,
    onCommit: async (commit) => {
      const candidate = applyCommit(committed, commit);
      committed = await options.session.save(candidate);
      options.onCommitted?.(committed, commit);
    },
  });
  return committed;
}

function applyCommit(
  current: CheckpointedAnalysis,
  commit: AnalysisCommit,
): CheckpointedAnalysis {
  if (commit.kind === "cues") {
    return {
      subtitles: [...current.subtitles, ...commit.subtitles],
      keyPhrases: current.keyPhrases,
      checkpoint: commit.checkpoint,
    };
  }
  return {
    subtitles: current.subtitles,
    keyPhrases: commit.keyPhrases,
    checkpoint: commit.checkpoint,
  };
}
