import { fetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import type { LibraryEntry } from "../types/library";
import type { TranslationStyle } from "../types/settings";
import type {
  CheckpointedAnalysis,
  KeyPhrase,
  SrtCue,
  Subtitle,
} from "./types";
import type { PersistedAnalysisSession } from "./analysisSession";
import type { AnalysisPreview } from "./analyze";
import { abortableDelay } from "./retry";
import { API_BASE } from "../lib/apiBase";

const BASE_URL = `${API_BASE}/library/mobile-analysis`;
const POLL_MS = 2_000;
const QUEUE_RETRY_MS = 4_000;
const QUEUE_RETRY_ATTEMPTS = 15;
const POLL_RETRY_MS = 1_000;
const POLL_RETRY_ATTEMPTS = 4;
const CREATE_RETRY_MS = 1_000;
const CREATE_RETRY_ATTEMPTS = 4;
const MANAGED_BATCH_SIZE = 50;

interface ManagedJob {
  jobId: string;
  status:
    | "queued"
    | "running"
    | "paused_quota"
    | "completed"
    | "failed"
    | "cancelled";
  completedCues: number;
  totalCues: number;
  errorCode: string | null;
}

interface ManagedResults {
  status: ManagedJob["status"];
  nextBatchCursor: number;
  batches: Array<{ batchIndex: number; subtitles: Subtitle[] }>;
  keyPhrases?: KeyPhrase[];
  errorCode: string | null;
}

export function requiresExternalQuotaRecovery(
  status: ManagedJob["status"],
): boolean {
  return status === "paused_quota";
}

export class ManagedRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly diagnosticCode = "",
  ) {
    super(
      `托管解析失败：${code}${diagnosticCode ? `（${diagnosticCode}）` : ""}`,
    );
    this.name = "ManagedRequestError";
  }
}

export interface ManagedAnalysisOptions {
  entry: LibraryEntry;
  cues: readonly SrtCue[];
  style: TranslationStyle;
  session: PersistedAnalysisSession;
  signal?: AbortSignal;
  onCommitted?: (analysis: CheckpointedAnalysis) => void;
  onPreview?: (
    committed: CheckpointedAnalysis,
    preview: AnalysisPreview | null,
  ) => void;
}

function asSrt(cues: readonly SrtCue[]): string {
  return cues
    .map((cue, index) => {
      const stamp = (seconds: number) => {
        const ms = Math.max(0, Math.round(seconds * 1000));
        const h = Math.floor(ms / 3_600_000);
        const m = Math.floor((ms % 3_600_000) / 60_000);
        const s = Math.floor((ms % 60_000) / 1000);
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
      };
      return `${index + 1}\n${stamp(cue.time)} --> ${stamp(cue.endTime)}\n${cue.text}\n`;
    })
    .join("\n");
}

function youtubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const id =
      parsed.hostname === "youtu.be"
        ? parsed.pathname.slice(1).split("/")[0]
        : parsed.hostname.endsWith("youtube.com")
          ? parsed.searchParams.get("v")
          : null;
    return id && /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function authHeader(): Promise<string> {
  const session = await invoke<string | null>("get_session_token").catch(
    () => null,
  );
  if (session) return `Bearer ${session}`;
  const trial = await invoke<{ trialToken?: string } | null>(
    "trial_read_state",
  ).catch(() => null);
  return `Bearer ${trial?.trialToken ?? ""}`;
}

async function request<T>(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      authorization: await authHeader(),
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal,
  });
  const body = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* preserve the HTTP status below */
  }
  if (!response.ok) {
    const code =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${response.status}`;
    const diagnosticCode =
      parsed && typeof parsed === "object" && "diagnosticCode" in parsed
        ? String((parsed as { diagnosticCode: unknown }).diagnosticCode)
        : "";
    throw new ManagedRequestError(response.status, code, diagnosticCode);
  }
  return parsed as T;
}

export function isRetryableManagedError(error: unknown): boolean {
  if (error instanceof ManagedRequestError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("error sending request") ||
    message.includes("network error") ||
    message.includes("failed to fetch") ||
    message.includes("connection reset") ||
    message.includes("connection closed")
  );
}

export function isManagedErrorCode(error: unknown, code: string): boolean {
  return error instanceof ManagedRequestError && error.code === code;
}

async function pollRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request<T>(path, { method: "GET" }, signal);
    } catch (error) {
      if (
        !isRetryableManagedError(error) ||
        attempt >= POLL_RETRY_ATTEMPTS - 1
      ) {
        throw error;
      }
      await abortableDelay(POLL_RETRY_MS, signal);
    }
  }
}

export type ManagedEventEnvelope = {
  eventId?: number;
  eventType?: string;
  batchIndex?: number | null;
  attempt?: number | null;
  payload?: unknown;
};

export type ManagedPreviewState = {
  batchIndex: number;
  attempt: number;
  lastEventId: number;
  subtitles: Map<number, Subtitle>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSubtitle(value: unknown): Subtitle | null {
  if (
    !isRecord(value) ||
    typeof value.index !== "number" ||
    typeof value.time !== "number" ||
    typeof value.endTime !== "number" ||
    typeof value.text !== "string" ||
    typeof value.translation !== "string" ||
    typeof value.isKeyPoint !== "boolean" ||
    !Array.isArray(value.highlightWords) ||
    !isRecord(value.keyNotes) ||
    !isRecord(value.highlightTranslations)
  )
    return null;
  return {
    time: value.time,
    endTime: value.endTime,
    text: value.text,
    translation: value.translation,
    isKeyPoint: value.isKeyPoint,
    highlightWords: value.highlightWords.filter(
      (item): item is string => typeof item === "string",
    ),
    keyNotes: Object.fromEntries(
      Object.entries(value.keyNotes).filter(
        ([, item]) => typeof item === "string",
      ),
    ) as Record<string, string>,
    highlightTranslations: Object.fromEntries(
      Object.entries(value.highlightTranslations).filter(
        ([, item]) => typeof item === "string",
      ),
    ) as Record<string, string>,
  };
}

function eventPreview(
  state: ManagedPreviewState | null,
  committed: CheckpointedAnalysis,
  totalCues: number,
): AnalysisPreview | null {
  if (!state || state.subtitles.size === 0) return null;
  const entries = [...state.subtitles.entries()]
    .filter(([cueOffset]) => cueOffset >= committed.checkpoint.nextCueOffset)
    .sort(([left], [right]) => left - right)
    .map(([cueOffset, subtitle]) => ({ cueOffset, subtitle }));
  if (entries.length === 0) return null;
  return {
    startCueOffset: state.batchIndex * MANAGED_BATCH_SIZE,
    endCueOffset: Math.min(
      totalCues,
      (state.batchIndex + 1) * MANAGED_BATCH_SIZE,
    ),
    entries,
    subtitles: entries.map((entry) => entry.subtitle),
  };
}

export function applyManagedPreviewEvent(
  state: ManagedPreviewState | null,
  envelope: ManagedEventEnvelope,
  committed: CheckpointedAnalysis,
  totalCues: number,
  submittedCueIndexes: readonly number[],
): {
  state: ManagedPreviewState | null;
  preview: AnalysisPreview | null;
  changed: boolean;
} {
  const batchIndex = envelope.batchIndex;
  const attempt = envelope.attempt;
  if (
    !Number.isInteger(batchIndex) ||
    !Number.isInteger(attempt) ||
    typeof batchIndex !== "number" ||
    typeof attempt !== "number" ||
    batchIndex < 0 ||
    attempt < 0
  ) {
    return {
      state,
      preview: eventPreview(state, committed, totalCues),
      changed: false,
    };
  }

  const activeBatchIndex = Math.floor(
    committed.checkpoint.nextCueOffset / MANAGED_BATCH_SIZE,
  );
  if (
    committed.checkpoint.nextCueOffset >= totalCues ||
    batchIndex !== activeBatchIndex
  ) {
    return {
      state,
      preview: eventPreview(state, committed, totalCues),
      changed: false,
    };
  }

  const eventId =
    Number.isInteger(envelope.eventId) && (envelope.eventId ?? -1) >= 0
      ? (envelope.eventId as number)
      : -1;
  if (
    state &&
    (batchIndex < state.batchIndex ||
      (batchIndex === state.batchIndex && attempt < state.attempt) ||
      (batchIndex === state.batchIndex &&
        attempt === state.attempt &&
        eventId >= 0 &&
        state.lastEventId >= 0 &&
        eventId <= state.lastEventId))
  ) {
    return {
      state,
      preview: eventPreview(state, committed, totalCues),
      changed: false,
    };
  }

  if (envelope.eventType === "batch_reset") {
    return {
      state: {
        batchIndex,
        attempt,
        lastEventId: eventId >= 0 ? eventId : (state?.lastEventId ?? -1),
        subtitles: new Map(),
      },
      preview: null,
      changed: true,
    };
  }
  if (envelope.eventType !== "cue") {
    return {
      state,
      preview: eventPreview(state, committed, totalCues),
      changed: false,
    };
  }

  const subtitle = asSubtitle(envelope.payload);
  const cueIndex =
    isRecord(envelope.payload) && Number.isInteger(envelope.payload.index)
      ? (envelope.payload.index as number)
      : -1;
  const batchStart = batchIndex * MANAGED_BATCH_SIZE;
  const batchEnd = Math.min(totalCues, batchStart + MANAGED_BATCH_SIZE);
  if (
    !subtitle ||
    cueIndex < batchStart ||
    cueIndex >= batchEnd ||
    cueIndex < committed.checkpoint.nextCueOffset ||
    !submittedCueIndexes.includes(cueIndex)
  ) {
    return {
      state,
      preview: eventPreview(state, committed, totalCues),
      changed: false,
    };
  }

  const nextState: ManagedPreviewState =
    !state || batchIndex !== state.batchIndex || attempt > state.attempt
      ? { batchIndex, attempt, lastEventId: eventId, subtitles: new Map() }
      : {
          ...state,
          lastEventId: eventId >= 0 ? eventId : state.lastEventId,
          subtitles: new Map(state.subtitles),
        };
  nextState.subtitles.set(cueIndex, subtitle);
  return {
    state: nextState,
    preview: eventPreview(nextState, committed, totalCues),
    changed: true,
  };
}

async function consumeManagedEvents(
  jobId: string,
  submittedCues: readonly { index: number }[],
  committed: () => CheckpointedAnalysis,
  totalCues: number,
  signal: AbortSignal,
  onPreview: (
    committed: CheckpointedAnalysis,
    preview: AnalysisPreview | null,
  ) => void,
): Promise<void> {
  const response = await fetch(
    `${BASE_URL}/jobs/${encodeURIComponent(jobId)}/events`,
    {
      headers: {
        authorization: await authHeader(),
        accept: "text/event-stream",
      },
      signal,
    },
  );
  if (!response.ok || !response.body)
    throw new Error(`managed event stream HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let eventData = "";
  let previewState: ManagedPreviewState | null = null;
  const dispatch = () => {
    let envelope: ManagedEventEnvelope | null = null;
    try {
      envelope = JSON.parse(eventData) as ManagedEventEnvelope;
    } catch {
      envelope = null;
    }
    if (envelope) {
      const committedSnapshot = committed();
      const result = applyManagedPreviewEvent(
        previewState,
        { ...envelope, eventType: eventName },
        committedSnapshot,
        totalCues,
        submittedCues.map((cue) => cue.index),
      );
      previewState = result.state;
      if (result.changed) onPreview(committedSnapshot, result.preview);
    }
    eventName = "message";
    eventData = "";
  };

  const consumeLine = (line: string) => {
    if (line === "") {
      if (eventData) dispatch();
      return;
    }
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:"))
      eventData += `${eventData ? "\n" : ""}${line.slice(5).replace(/^ /, "")}`;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.search(/[\r\n]/);
      while (newline >= 0) {
        const delimiter = buffer[newline];
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (delimiter === "\r" && buffer.startsWith("\n"))
          buffer = buffer.slice(1);
        newline = buffer.search(/[\r\n]/);
      }
    }
    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);
    if (eventData) dispatch();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function mergeManagedSubtitleBatch(
  current: CheckpointedAnalysis,
  batchIndex: number,
  subtitles: Subtitle[],
  keyPhrases: KeyPhrase[] | undefined,
  totalCues: number,
): CheckpointedAnalysis {
  const nextOffset = Math.min(totalCues, (batchIndex + 1) * MANAGED_BATCH_SIZE);
  return {
    subtitles: [...current.subtitles, ...subtitles],
    keyPhrases: keyPhrases ?? current.keyPhrases,
    checkpoint: {
      ...current.checkpoint,
      nextCueOffset: nextOffset,
      phase: nextOffset >= totalCues ? "summary" : "cues",
      revision: current.checkpoint.revision + 1,
    },
  };
}

export function mergeManagedSummary(
  current: CheckpointedAnalysis,
  keyPhrases: KeyPhrase[],
): CheckpointedAnalysis {
  return {
    ...current,
    keyPhrases,
    checkpoint: {
      ...current.checkpoint,
      revision: current.checkpoint.revision + 1,
    },
  };
}

function isManagedNotFoundError(error: unknown): boolean {
  return isManagedErrorCode(error, "not_found");
}

function isManagedQueueLimitError(error: unknown): boolean {
  return isManagedErrorCode(error, "queue_limit");
}

export function managedCursorForCheckpoint(
  nextCueOffset: number,
  totalCues: number,
): number | null {
  if (
    !Number.isInteger(nextCueOffset) ||
    nextCueOffset < 0 ||
    nextCueOffset > totalCues
  )
    return null;
  if (nextCueOffset === 0) return -1;
  if (nextCueOffset !== totalCues && nextCueOffset % MANAGED_BATCH_SIZE !== 0)
    return null;
  return Math.ceil(nextCueOffset / MANAGED_BATCH_SIZE) - 1;
}

export function canFinalizeManagedCompletion(
  nextCueOffset: number,
  totalCues: number,
  summaryReceived: boolean,
): boolean {
  return nextCueOffset >= totalCues && summaryReceived;
}

interface ManagedJobPayloadOptions {
  videoId: string;
  transcriptGeneration: string;
  youtubeId: string;
  sourceUrl: string;
  title: string;
  durationSec: number;
  cues: readonly SrtCue[];
}

export function buildManagedJobPayload(options: ManagedJobPayloadOptions) {
  return {
    idempotencyKey: `desktop:${options.videoId}:${options.transcriptGeneration}`,
    youtubeId: options.youtubeId,
    sourceUrl: options.sourceUrl,
    title: options.title,
    durationSec: options.durationSec,
    cues: options.cues,
    transcriptSrt: asSrt(options.cues),
    persistLibraryEntry: false,
  };
}

export async function executeManagedAnalysis(
  options: ManagedAnalysisOptions,
): Promise<CheckpointedAnalysis> {
  // Imported SRT files may use one-based, sparse, or repeated cue numbers.
  // Managed jobs identify results by array position, so normalize only the
  // submitted identity while preserving text and timing verbatim.
  const submittedCues = options.cues.map((cue, index) => ({ ...cue, index }));
  const cueDurationSec = options.cues.reduce(
    (maximum, cue) =>
      Number.isFinite(cue.endTime) ? Math.max(maximum, cue.endTime) : maximum,
    0,
  );
  const mediaDurationSec = options.entry.durationSec;
  const durationSec = Math.ceil(Math.max(mediaDurationSec, cueDurationSec));
  if (
    !Number.isFinite(mediaDurationSec) ||
    mediaDurationSec <= 0 ||
    durationSec <= 0
  ) {
    throw new Error("无法确认视频时长，暂时不能提交托管解析");
  }
  const sourceUrl =
    options.entry.source.type === "url" ? options.entry.source.url : "";
  const id = youtubeId(sourceUrl) ?? "";
  let current = options.session.analysis;
  const initialCursor = managedCursorForCheckpoint(
    current.checkpoint.nextCueOffset,
    options.cues.length,
  );
  if (initialCursor === null) {
    throw new Error("当前本地解析断点与托管批次不兼容，请选择重新解析");
  }

  // The relay can briefly reject new work while all worker slots are busy.
  // Reuse the same idempotency key on retry so a delayed response or a server
  // race cannot create duplicate managed jobs.
  const jobPayload = buildManagedJobPayload({
    videoId: options.entry.id,
    transcriptGeneration: options.session.transcriptGeneration,
    youtubeId: id,
    sourceUrl,
    title: options.entry.title,
    durationSec,
    cues: submittedCues,
  });
  let job: ManagedJob;
  for (let attempt = 0; ; attempt += 1) {
    try {
      job = await request<ManagedJob>(
        "/jobs",
        {
          method: "POST",
          body: JSON.stringify(jobPayload),
        },
        options.signal,
      );
      break;
    } catch (error) {
      const retryable =
        isManagedQueueLimitError(error) || isRetryableManagedError(error);
      const maxAttempts = isManagedQueueLimitError(error)
        ? QUEUE_RETRY_ATTEMPTS
        : CREATE_RETRY_ATTEMPTS;
      const delayMs = isManagedQueueLimitError(error)
        ? QUEUE_RETRY_MS
        : CREATE_RETRY_MS;
      if (!retryable || attempt >= maxAttempts - 1) {
        throw error;
      }
      await abortableDelay(delayMs, options.signal);
    }
  }

  let cursor = initialCursor;
  let active = job;
  let resumeCount = 0;
  let summaryReceived = false;
  const eventController = new AbortController();
  const stopEvents = () => eventController.abort();
  const forwardPreview = options.onPreview;
  if (forwardPreview) {
    if (options.signal) {
      if (options.signal.aborted) eventController.abort();
      else options.signal.addEventListener("abort", stopEvents, { once: true });
    }
    void consumeManagedEvents(
      active.jobId,
      submittedCues,
      () => current,
      options.cues.length,
      eventController.signal,
      forwardPreview,
    ).catch(() => undefined);
  }
  try {
    while (true) {
      if (options.signal?.aborted)
        throw new DOMException("aborted", "AbortError");
      let page: ManagedResults;
      try {
        page = await pollRequest<ManagedResults>(
          `/jobs/${encodeURIComponent(active.jobId)}/results?afterBatch=${cursor}`,
          options.signal,
        );
      } catch (error) {
        // Older servers returned not_found after finalizing a desktop-only job.
        // Only finalize when this run has already observed both all cue batches
        // and an explicit (possibly empty) summary payload.
        if (
          isManagedNotFoundError(error) &&
          canFinalizeManagedCompletion(
            current.checkpoint.nextCueOffset,
            options.cues.length,
            summaryReceived,
          )
        ) {
          return options.session.save({
            ...current,
            checkpoint: {
              ...current.checkpoint,
              phase: "complete",
              nextCueOffset: options.cues.length,
              revision: current.checkpoint.revision + 1,
            },
          });
        }
        throw error;
      }
      if (!summaryReceived && page.keyPhrases !== undefined) {
        current = await options.session.save(
          mergeManagedSummary(current, page.keyPhrases),
        );
        options.onCommitted?.(current);
        summaryReceived = true;
      }
      for (const batch of page.batches) {
        const expectedStart = current.checkpoint.nextCueOffset;
        const submittedStart = batch.batchIndex * MANAGED_BATCH_SIZE;
        const submittedEnd = Math.min(
          options.cues.length,
          submittedStart + MANAGED_BATCH_SIZE,
        );
        if (submittedEnd <= expectedStart) {
          cursor = batch.batchIndex;
          continue;
        }
        if (submittedStart !== expectedStart) {
          throw new Error("托管解析任务与本地进度不一致，请从头重新解析");
        }
        current = await options.session.save(
          mergeManagedSubtitleBatch(
            current,
            batch.batchIndex,
            batch.subtitles,
            page.keyPhrases,
            options.cues.length,
          ),
        );
        options.onCommitted?.(current);
        options.onPreview?.(current, null);
        cursor = batch.batchIndex;
      }
      // A completed results page is authoritative for desktop-only jobs. They
      // intentionally have no cloud Library result_entry_id, so waiting for a
      // second /jobs/:id status read can leave the UI spinning after every cue
      // has already been durably saved locally.
      if (
        page.status === "completed" &&
        canFinalizeManagedCompletion(
          current.checkpoint.nextCueOffset,
          options.cues.length,
          summaryReceived,
        )
      ) {
        return options.session.save({
          ...current,
          keyPhrases: page.keyPhrases ?? current.keyPhrases,
          checkpoint: {
            ...current.checkpoint,
            phase: "complete",
            nextCueOffset: options.cues.length,
            revision: current.checkpoint.revision + 1,
          },
        });
      }
      try {
        active = await pollRequest<ManagedJob>(
          `/jobs/${encodeURIComponent(active.jobId)}`,
          options.signal,
        );
      } catch (error) {
        // The same legacy race can affect the status endpoint. Do not infer a
        // complete summary from cue progress alone.
        if (
          isManagedNotFoundError(error) &&
          canFinalizeManagedCompletion(
            current.checkpoint.nextCueOffset,
            options.cues.length,
            summaryReceived,
          )
        ) {
          return options.session.save({
            ...current,
            checkpoint: {
              ...current.checkpoint,
              phase: "complete",
              nextCueOffset: options.cues.length,
              revision: current.checkpoint.revision + 1,
            },
          });
        }
        throw error;
      }
      if (
        active.status === "failed" ||
        active.status === "cancelled"
      ) {
        if (
          active.status === "failed" &&
          [
            "upstream_unavailable",
            "invalid_analysis_cue",
            "invalid_sse",
          ].includes(active.errorCode ?? "") &&
          resumeCount < 2
        ) {
          resumeCount += 1;
          active = await request<ManagedJob>(
            `/jobs/${encodeURIComponent(active.jobId)}/resume`,
            { method: "POST", body: "{}" },
            options.signal,
          );
          continue;
        }
        throw new Error(`托管解析未完成：${active.errorCode ?? active.status}`);
      }
      if (requiresExternalQuotaRecovery(active.status)) {
        // Capacity has not changed merely because polling observed a pause.
        // Leave the exact server job dormant; quotaRecovery resumes it only
        // after a wallet/subscription refresh proves capacity increased.
        throw new Error("托管解析未完成：paused_quota");
      }
      if (
        active.status === "completed" &&
        canFinalizeManagedCompletion(
          current.checkpoint.nextCueOffset,
          options.cues.length,
          summaryReceived,
        )
      ) {
        const completed: CheckpointedAnalysis = {
          ...current,
          keyPhrases: page.keyPhrases ?? current.keyPhrases,
          checkpoint: {
            ...current.checkpoint,
            phase: "complete",
            nextCueOffset: options.cues.length,
            revision: current.checkpoint.revision + 1,
          },
        };
        return options.session.save(completed);
      }
      await abortableDelay(POLL_MS, options.signal);
    }
  } finally {
    stopEvents();
    options.signal?.removeEventListener("abort", stopEvents);
  }
}
