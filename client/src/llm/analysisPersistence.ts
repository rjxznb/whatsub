import { invoke } from "@tauri-apps/api/core";

export type SaveAnalysisStatus = "applied" | "alreadyCurrent" | "rejected";

export interface SaveAnalysisOutcome {
  applied: boolean;
  status: SaveAnalysisStatus;
  generation: string | null;
  revision: number | null;
}

interface LoadAnalysisStateOutcome {
  analysis: unknown | null;
  generation: string | null;
}

interface VideoPersistenceState {
  initialized: boolean;
  generation: string | null;
  resetFrom: string | null;
}

const states = new Map<string, VideoPersistenceState>();
const saveTails = new Map<string, Promise<void>>();
const lifecycleVersions = new Map<string, number>();

export class AnalysisSaveConflictError extends Error {
  constructor(
    videoId: string,
    public readonly outcome: SaveAnalysisOutcome | null = null,
  ) {
    super(`analysis save was rejected for ${videoId}`);
    this.name = "AnalysisSaveConflictError";
  }
}

function stateFor(videoId: string): VideoPersistenceState {
  let state = states.get(videoId);
  if (!state) {
    state = {
      initialized: false,
      generation: null,
      resetFrom: null,
    };
    states.set(videoId, state);
  }
  return state;
}

function lifecycleFor(videoId: string): number {
  return lifecycleVersions.get(videoId) ?? 0;
}

function requireCurrentLifecycle(videoId: string, lifecycle: number): void {
  if (lifecycleFor(videoId) !== lifecycle) {
    throw new AnalysisSaveConflictError(videoId);
  }
}

function enqueue<T>(videoId: string, operation: () => Promise<T>): Promise<T> {
  const previous = saveTails.get(videoId) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  saveTails.set(videoId, tail);
  void tail.then(() => {
    if (saveTails.get(videoId) === tail) saveTails.delete(videoId);
  });
  return result;
}

async function initialize(videoId: string, state: VideoPersistenceState): Promise<void> {
  if (state.initialized) return;
  const loaded = await invoke<LoadAnalysisStateOutcome>("load_analysis_state", { videoId });
  state.initialized = true;
  state.generation = loaded.generation;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeJson(record[key])]),
    );
  }
  return value;
}

function analysesAreEquivalent(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(normalizeJson(left)) === JSON.stringify(normalizeJson(right));
  } catch {
    return false;
  }
}

function requireAccepted(videoId: string, outcome: SaveAnalysisOutcome): void {
  if (!outcome.applied || outcome.status === "rejected") {
    throw new AnalysisSaveConflictError(videoId, outcome);
  }
  if (!outcome.generation) {
    throw new Error(`analysis save returned no generation for ${videoId}`);
  }
}

/**
 * Transitional persistence for the pre-Task-5 producers. Calls for one video
 * are serialized so the first response can provide the generation used by all
 * later changed saves. Rejections throw instead of becoming silent IPC success.
 */
export function saveAnalysis(videoId: string, analysis: unknown): Promise<SaveAnalysisOutcome> {
  const lifecycle = lifecycleFor(videoId);
  return enqueue(videoId, async () => {
    requireCurrentLifecycle(videoId, lifecycle);
    const state = stateFor(videoId);
    await initialize(videoId, state);

    const identity = state.resetFrom
      ? { expectedGeneration: state.resetFrom }
      : state.generation
        ? { generation: state.generation }
        : {};
    const outcome = await invoke<SaveAnalysisOutcome>("save_analysis", {
      videoId,
      analysis,
      ...identity,
    });
    if (!outcome.applied || outcome.status === "rejected") {
      const loaded = await invoke<LoadAnalysisStateOutcome>("load_analysis_state", { videoId });
      const canRetryIdempotently =
        state.resetFrom === null &&
        state.generation !== null &&
        loaded.generation !== null &&
        loaded.generation !== state.generation &&
        loaded.analysis !== null &&
        analysesAreEquivalent(loaded.analysis, analysis);
      if (!canRetryIdempotently) {
        throw new AnalysisSaveConflictError(videoId, outcome);
      }

      const retry = await invoke<SaveAnalysisOutcome>("save_analysis", {
        videoId,
        analysis,
        generation: loaded.generation,
      });
      requireAccepted(videoId, retry);
      state.generation = retry.generation;
      state.resetFrom = null;
      return retry;
    }
    requireAccepted(videoId, outcome);

    state.generation = outcome.generation;
    state.resetFrom = null;
    return outcome;
  });
}

/** Delete is the only current UI action that grants the next save reset CAS authority. */
export function deleteAnalysisForReset(videoId: string): Promise<SaveAnalysisOutcome> {
  const lifecycle = lifecycleFor(videoId);
  return enqueue(videoId, async () => {
    requireCurrentLifecycle(videoId, lifecycle);
    const outcome = await invoke<SaveAnalysisOutcome>("delete_analysis", { videoId });
    requireAccepted(videoId, outcome);

    const state = stateFor(videoId);
    state.initialized = true;
    state.generation = null;
    state.resetFrom = outcome.generation;
    return outcome;
  });
}

/**
 * Run a whole-video deletion in the same queue as analysis saves, then retire
 * the cached generation. Saves requested while deletion is in flight retain
 * the old lifecycle and are rejected instead of initializing the reimport.
 */
export function invalidateAnalysisPersistence<T>(
  videoId: string,
  deleteVideo: () => Promise<T>,
): Promise<T> {
  return enqueue(videoId, async () => {
    const result = await deleteVideo();
    states.delete(videoId);
    lifecycleVersions.set(videoId, lifecycleFor(videoId) + 1);
    return result;
  });
}

/** Whole-video deletion boundary used by every frontend `library_delete` path. */
export function deleteVideoAndInvalidateAnalysis(videoId: string): Promise<void> {
  return invalidateAnalysisPersistence(videoId, () =>
    invoke<void>("library_delete", { id: videoId }),
  );
}

/** Original-import cancellation removes the whole working directory in Rust. */
export function cancelImportAndInvalidateAnalysis(videoId: string): Promise<void> {
  return invalidateAnalysisPersistence(videoId, () =>
    invoke<void>("cancel_import", { videoId }),
  );
}
