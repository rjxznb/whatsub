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
  return enqueue(videoId, async () => {
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
    requireAccepted(videoId, outcome);

    state.generation = outcome.generation;
    state.resetFrom = null;
    return outcome;
  });
}

/** Delete is the only current UI action that grants the next save reset CAS authority. */
export function deleteAnalysisForReset(videoId: string): Promise<SaveAnalysisOutcome> {
  return enqueue(videoId, async () => {
    const outcome = await invoke<SaveAnalysisOutcome>("delete_analysis", { videoId });
    requireAccepted(videoId, outcome);

    const state = stateFor(videoId);
    state.initialized = true;
    state.generation = null;
    state.resetFrom = outcome.generation;
    return outcome;
  });
}
