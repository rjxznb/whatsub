import { invoke } from "@tauri-apps/api/core";
import type { TranslationStyle } from "../types/settings";
import {
  runAnalysis,
  type AnalysisCommit,
  type AnalysisPreview,
  type AnalysisRetryEvent,
} from "./analyze";
import {
  fingerprintTranscript,
  parsePersistedAnalysis,
  prepareAnalysis,
} from "./analysisCheckpoint";
import {
  journalMatchesSession,
  mergeInflightEntries,
  parseAnalysisInflightJournal,
  type AnalysisInflightJournal,
  type JournalSessionContext,
} from "./analysisJournal";
import { parseSrt } from "./parseSrt";
import type { Provider } from "./providers/types";
import type { CheckpointedAnalysis, SrtCue } from "./types";

interface AnalysisSessionStart {
  lease: string;
  analysis: unknown | null;
  inflight: unknown | null;
}

interface AnalysisTranscriptSessionStart {
  transcript: string;
  transcriptGeneration: string;
  session: AnalysisSessionStart;
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
  readonly inflight: AnalysisInflightJournal | null;
  save(next: CheckpointedAnalysis): Promise<CheckpointedAnalysis>;
  saveInflight(next: AnalysisInflightJournal): Promise<AnalysisInflightJournal>;
  close(): Promise<void>;
}

export interface OpenStoredAnalysisSessionOptions {
  reset?: boolean;
  style: TranslationStyle;
}

export interface StoredAnalysisSession {
  cues: SrtCue[];
  session: PersistedAnalysisSession;
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
  style: TranslationStyle = "colloquial",
): Promise<PersistedAnalysisSession> {
  const release = await acquireLocalSessionSlot(videoId);
  try {
    const transcriptGeneration = await fingerprintTranscript(cues);
    const started = await begin(videoId, false, transcriptGeneration, style);
    let prepared: Awaited<ReturnType<typeof prepareAnalysis>>;
    try {
      prepared = await prepareAnalysis(cues, started.analysis);
    } catch (error) {
      await endIgnoringFailure(videoId, started.lease);
      throw error;
    }

    if (prepared.reason === "fingerprint-mismatch") {
      await end(videoId, started.lease);
      return beginPreparedSession(
        videoId,
        cues,
        await begin(videoId, true, transcriptGeneration, style),
        transcriptGeneration,
        style,
        release,
      );
    }

    return createPreparedSession(
      videoId,
      cues,
      started,
      prepared,
      transcriptGeneration,
      style,
      release,
    );
  } catch (error) {
    release();
    throw error;
  }
}

export async function resetAnalysisSession(
  videoId: string,
  cues: readonly SrtCue[],
  style: TranslationStyle = "colloquial",
): Promise<PersistedAnalysisSession> {
  const release = await acquireLocalSessionSlot(videoId);
  try {
    const transcriptGeneration = await fingerprintTranscript(cues);
    return await beginPreparedSession(
      videoId,
      cues,
      await begin(videoId, true, transcriptGeneration, style),
      transcriptGeneration,
      style,
      release,
    );
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * Read transcript.srt and issue its producer lease in one Rust-side critical
 * section. The lease is also bound to the exact transcript generation, so a
 * later cloud/local transcript replacement makes every old save stale.
 */
export async function openStoredAnalysisSession(
  videoId: string,
  options: OpenStoredAnalysisSessionOptions,
): Promise<StoredAnalysisSession | null> {
  const release = await acquireLocalSessionSlot(videoId);
  try {
    const reset = options.reset ?? false;
    const started = await beginFromTranscript(videoId, reset, null, options.style);
    if (!started) {
      release();
      return null;
    }

    let cues = parseSrt(started.transcript);
    if (reset) {
      const session = await beginPreparedSession(
        videoId,
        cues,
        started.session,
        started.transcriptGeneration,
        options.style,
        release,
      );
      return { cues, session };
    }

    let prepared: Awaited<ReturnType<typeof prepareAnalysis>>;
    try {
      prepared = await prepareAnalysis(cues, started.session.analysis);
    } catch (error) {
      await endIgnoringFailure(videoId, started.session.lease);
      throw error;
    }
    if (prepared.reason !== "fingerprint-mismatch") {
      const session = await createPreparedSession(
        videoId,
        cues,
        started.session,
        prepared,
        started.transcriptGeneration,
        options.style,
        release,
      );
      return { cues, session };
    }

    await end(videoId, started.session.lease);
    const restarted = await beginFromTranscript(
      videoId,
      true,
      started.transcriptGeneration,
      options.style,
    );
    if (!restarted) {
      throw new Error(`transcript disappeared while opening analysis session for ${videoId}`);
    }
    cues = parseSrt(restarted.transcript);
    const session = await beginPreparedSession(
      videoId,
      cues,
      restarted.session,
      restarted.transcriptGeneration,
      options.style,
      release,
    );
    return { cues, session };
  } catch (error) {
    release();
    throw error;
  }
}

async function beginPreparedSession(
  videoId: string,
  cues: readonly SrtCue[],
  started: AnalysisSessionStart,
  transcriptGeneration: string,
  style: TranslationStyle,
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
  return createPreparedSession(
    videoId,
    cues,
    started,
    prepared,
    transcriptGeneration,
    style,
    release,
  );
}

async function createPreparedSession(
  videoId: string,
  cues: readonly SrtCue[],
  started: AnalysisSessionStart,
  prepared: Awaited<ReturnType<typeof prepareAnalysis>>,
  transcriptGeneration: string,
  style: TranslationStyle,
  release: () => void,
): Promise<PersistedAnalysisSession> {
  let inflight: AnalysisInflightJournal | null;
  try {
    inflight = await resolveInflight(
      videoId,
      started.lease,
      started.inflight,
      {
        transcriptGeneration,
        transcriptFingerprint: prepared.analysis.checkpoint.transcriptFingerprint,
        analysisStyle: style,
        baseRevision: prepared.analysis.checkpoint.revision,
        nextCueOffset: prepared.analysis.checkpoint.nextCueOffset,
        cueCount: cues.length,
      },
    );
  } catch (error) {
    await endIgnoringFailure(videoId, started.lease);
    throw error;
  }
  const session = createSession(
    videoId,
    started.lease,
    cues,
    prepared.analysis,
    inflight,
    transcriptGeneration,
    style,
    release,
  );
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
  initialInflight: AnalysisInflightJournal | null,
  transcriptGeneration: string,
  style: TranslationStyle,
  release: () => void,
): PersistedAnalysisSession {
  let current = initial;
  let currentInflight = initialInflight;
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
    get inflight() {
      return currentInflight;
    },
    save(next) {
      if (closed || stale) return Promise.reject(new StaleAnalysisSessionError(videoId));
      const operation = saveTail.then(async () => {
        if (stale) throw new StaleAnalysisSessionError(videoId);
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
        if (
          currentInflight
          && current.checkpoint.nextCueOffset >= currentInflight.endCueOffset
        ) {
          currentInflight = null;
        }
        return current;
      });
      saveTail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    saveInflight(next) {
      if (closed || stale) return Promise.reject(new StaleAnalysisSessionError(videoId));
      const operation = saveTail.then(async () => {
        if (stale) throw new StaleAnalysisSessionError(videoId);
        const validated = validateInflightCandidate(
          next,
          currentInflight,
          current,
          cues.length,
          transcriptGeneration,
          style,
        );
        const outcome = await invoke<SessionSaveOutcome>("save_analysis_inflight", {
          videoId,
          lease,
          journal: validated,
        });
        if (outcome.status === "rejected") {
          stale = true;
          throw new StaleAnalysisSessionError(videoId, outcome);
        }
        currentInflight = validated;
        return currentInflight;
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

async function resolveInflight(
  videoId: string,
  lease: string,
  raw: unknown,
  context: JournalSessionContext,
): Promise<AnalysisInflightJournal | null> {
  const parsed = parseAnalysisInflightJournal(raw);
  if (parsed && journalMatchesSession(parsed, context)) return parsed;

  const journalId = parsed?.journalId
    ?? (isRecord(raw) && typeof raw.journalId === "string" ? raw.journalId : null);
  if (!journalId) return null;
  const outcome = await invoke<SessionSaveOutcome>("discard_analysis_inflight", {
    videoId,
    lease,
    journalId,
  });
  if (outcome.status === "rejected") {
    throw new StaleAnalysisSessionError(videoId, outcome);
  }
  return null;
}

function validateInflightCandidate(
  candidate: AnalysisInflightJournal,
  previous: AnalysisInflightJournal | null,
  analysis: CheckpointedAnalysis,
  cueCount: number,
  transcriptGeneration: string,
  style: TranslationStyle,
): AnalysisInflightJournal {
  const parsed = parseAnalysisInflightJournal(candidate);
  if (!parsed) {
    throw new TypeError("analysis session inflight save requires a valid journal");
  }
  if (!journalMatchesSession(parsed, {
    transcriptGeneration,
    transcriptFingerprint: analysis.checkpoint.transcriptFingerprint,
    analysisStyle: style,
    baseRevision: analysis.checkpoint.revision,
    nextCueOffset: analysis.checkpoint.nextCueOffset,
    cueCount,
  })) {
    throw new TypeError("analysis inflight journal does not match the session");
  }
  if (previous) {
    const merged = mergeInflightEntries(previous, parsed.entries);
    if (JSON.stringify(merged) !== JSON.stringify(parsed)) {
      throw new TypeError("analysis inflight journal is not a monotonic update");
    }
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function begin(
  videoId: string,
  reset: boolean,
  transcriptGeneration: string,
  analysisStyle: TranslationStyle,
): Promise<AnalysisSessionStart> {
  return invoke<AnalysisSessionStart>("begin_analysis_session", {
    videoId,
    reset,
    transcriptGeneration,
    analysisStyle,
  });
}

async function beginFromTranscript(
  videoId: string,
  reset: boolean,
  expectedGeneration: string | null,
  analysisStyle: TranslationStyle,
): Promise<AnalysisTranscriptSessionStart | null> {
  return invoke<AnalysisTranscriptSessionStart | null>(
    "begin_analysis_session_from_transcript",
    { videoId, reset, expectedGeneration, analysisStyle },
  );
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
  onPreview?: (
    committed: CheckpointedAnalysis,
    preview: AnalysisPreview | null,
  ) => void;
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
    onPreview: (preview) => options.onPreview?.(committed, preview),
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
