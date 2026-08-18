import type { TranslationStyle } from "../types/settings";
import type { AnalysisInflightEntry } from "./analysisJournal";
import type { Provider } from "./providers/types";
import {
  isAbortError,
  isRetryableProviderFailure,
  ProviderHttpError,
  ProviderProtocolError,
} from "./providers/errors";
import type {
  AnalysisCheckpoint,
  AnalysisResult,
  KeyPhrase,
  SrtCue,
  Subtitle,
} from "./types";
import { validateSummaryOutput } from "./summaryOutput";
import {
  validateAnnotationRepair,
  validateCueOutput,
  type AnnotationRepairSource,
  type SubtitleAnnotationPatch,
} from "./cueOutput";
import { JsonLineParser, type InvalidJsonLine } from "./streamingJson";
import {
  abortableDelay,
  retryOperation,
  type RetryEvent,
  type RetryPolicy,
} from "./retry";
import {
  buildAnnotationRepairPrompt,
  buildContinuationPrompt,
  buildRepairPrompt,
  buildSummaryPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from "./prompts";
import { compactHighlightCapacity, HighlightBudget } from "./phraseRules";

export type AnalysisCommit =
  | {
      kind: "cues";
      startCueOffset: number;
      endCueOffset: number;
      subtitles: Subtitle[];
      checkpoint: AnalysisCheckpoint;
    }
  | {
      kind: "summary";
      keyPhrases: KeyPhrase[];
      checkpoint: AnalysisCheckpoint;
    };

export interface AnalysisPreview {
  startCueOffset: number;
  endCueOffset: number;
  entries: AnalysisInflightEntry[];
  subtitles: Subtitle[];
}

export type AnalysisRetryEvent = RetryEvent & {
  kind: "transport" | "content-repair";
  unresolvedCueIndexes: number[];
};

export interface RunAnalysisOptions {
  provider: Provider;
  cues: readonly SrtCue[];
  previouslyAnalyzed: readonly Subtitle[];
  checkpoint: AnalysisCheckpoint;
  onCommit: (commit: AnalysisCommit) => Promise<void>;
  onPreview?: (preview: AnalysisPreview | null) => void | Promise<void>;
  resumePreview?: AnalysisPreview | null;
  onRetry?: (event: AnalysisRetryEvent) => void;
  batchSize?: number;
  style?: TranslationStyle;
  signal?: AbortSignal;
}

interface LegacyRunAnalysisOptions {
  provider: Provider;
  cues: SrtCue[];
  onCue: (cue: Subtitle) => void;
  onSummary: (summary: Omit<AnalysisResult, "subtitles">) => void;
  previouslyAnalyzed?: Subtitle[];
  batchSize?: number;
  style?: TranslationStyle;
  signal?: AbortSignal;
}

interface RequestedCue {
  cueOffset: number;
  cue: SrtCue;
}

type LegacyCallbackName = "onCue" | "onSummary";

class LegacyCallbackError extends Error {
  readonly cause: unknown;

  constructor(readonly callback: LegacyCallbackName, cause: unknown) {
    super(`Legacy ${callback} callback failed`);
    this.name = "LegacyCallbackError";
    this.cause = cause;
  }
}

class ModelContentError extends ProviderProtocolError {
  constructor(message: string) {
    super(message);
    this.name = "ModelContentError";
  }
}

const ANALYSIS_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  backoffMs: [500, 1500, 3500],
};

export function runAnalysis(opts: RunAnalysisOptions): Promise<AnalysisCheckpoint>;
/** @deprecated Use the checkpoint/onCommit transaction contract. */
export function runAnalysis(opts: LegacyRunAnalysisOptions): Promise<void>;
export async function runAnalysis(
  opts: RunAnalysisOptions | LegacyRunAnalysisOptions,
): Promise<AnalysisCheckpoint | void> {
  if ("onCommit" in opts) return runTransactionalAnalysis(opts);

  const legacyCheckpoint: AnalysisCheckpoint = {
    version: 1,
    transcriptFingerprint: "legacy-runtime",
    nextCueOffset: 0,
    phase: opts.cues.length === 0 ? "complete" : "cues",
    revision: 0,
  };
  let legacyPhase = legacyCheckpoint.phase;
  try {
    await runTransactionalAnalysis({
      provider: opts.provider,
      cues: opts.cues,
      previouslyAnalyzed: opts.previouslyAnalyzed ?? [],
      checkpoint: legacyCheckpoint,
      batchSize: opts.batchSize,
      style: opts.style,
      signal: opts.signal,
      onCommit: async (commit) => {
        legacyPhase = commit.checkpoint.phase;
        if (commit.kind === "cues") {
          for (const cue of commit.subtitles) {
            invokeLegacyCallback("onCue", () => opts.onCue(cue));
          }
        } else {
          invokeLegacyCallback(
            "onSummary",
            () => opts.onSummary({ keyPhrases: commit.keyPhrases }),
          );
        }
      },
    });
  } catch (error) {
    if (error instanceof LegacyCallbackError) throw error;
    if (legacyPhase === "summary" && !isAbortError(error)) return;
    throw error;
  }
}

function invokeLegacyCallback(name: LegacyCallbackName, callback: () => void): void {
  try {
    callback();
  } catch (cause) {
    throw new LegacyCallbackError(name, cause);
  }
}

async function runTransactionalAnalysis(
  opts: RunAnalysisOptions,
): Promise<AnalysisCheckpoint> {
  const batchSize = opts.batchSize ?? 50;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("batchSize must be a positive integer");
  }
  const systemPrompt = buildSystemPrompt(opts.style ?? "colloquial");
  const analyzedCues: Subtitle[] = [...opts.previouslyAnalyzed];
  let currentCheckpoint = opts.checkpoint;
  let pendingResumePreview = opts.resumePreview ?? null;

  try {
    while (
      currentCheckpoint.phase === "cues"
      && currentCheckpoint.nextCueOffset < opts.cues.length
    ) {
      throwIfAborted(opts.signal);
      const startCueOffset = currentCheckpoint.nextCueOffset;
      const endCueOffset = Math.min(startCueOffset + batchSize, opts.cues.length);
      const batch = opts.cues.slice(startCueOffset, endCueOffset);
      try {
        const subtitles = await resolveCueBatch(
          opts,
          systemPrompt,
          batch,
          startCueOffset,
          endCueOffset,
          pendingResumePreview,
        );
        pendingResumePreview = null;

        throwIfAborted(opts.signal);
        const nextCheckpoint: AnalysisCheckpoint = {
          ...currentCheckpoint,
          nextCueOffset: endCueOffset,
          phase: endCueOffset === opts.cues.length ? "summary" : "cues",
          revision: currentCheckpoint.revision + 1,
        };
        await opts.onCommit({
          kind: "cues",
          startCueOffset,
          endCueOffset,
          subtitles,
          checkpoint: nextCheckpoint,
        });
        currentCheckpoint = nextCheckpoint;
        analyzedCues.push(...subtitles);
        await opts.onPreview?.(null);
      } catch (error) {
        await opts.onPreview?.(null);
        throw error;
      }
    }

    if (
      currentCheckpoint.phase === "cues"
      && currentCheckpoint.nextCueOffset === opts.cues.length
      && opts.cues.length > 0
    ) {
      throwIfAborted(opts.signal);
      const nextCheckpoint: AnalysisCheckpoint = {
        ...currentCheckpoint,
        phase: "summary",
        revision: currentCheckpoint.revision + 1,
      };
      await opts.onCommit({
        kind: "cues",
        startCueOffset: currentCheckpoint.nextCueOffset,
        endCueOffset: currentCheckpoint.nextCueOffset,
        subtitles: [],
        checkpoint: nextCheckpoint,
      });
      currentCheckpoint = nextCheckpoint;
    }

    if (currentCheckpoint.phase !== "summary") return currentCheckpoint;

    throwIfAborted(opts.signal);
    const keyPhrases = await withProviderRetry(opts, async () => {
      const parser = new JsonLineParser();
      let attemptKeyPhrases: KeyPhrase[] | null = null;
      let invalidLine: InvalidJsonLine | null = null;
      const handle = (obj: unknown) => {
        const summary = validateSummaryOutput(obj);
        if (summary) attemptKeyPhrases = summary;
      };
      const invalid = (failure: InvalidJsonLine) => { invalidLine = failure; };

      for await (const chunk of opts.provider.stream({
        systemPrompt,
        userPrompt: buildSummaryPrompt(analyzedCues),
        signal: opts.signal,
      })) {
        throwIfAborted(opts.signal);
        parser.feed(chunk, handle, invalid);
      }
      throwIfAborted(opts.signal);
      parser.flush(handle, invalid);
      throwIfAborted(opts.signal);
      if (attemptKeyPhrases === null) {
        logMalformedLine(invalidLine);
        throw new ModelContentError("Provider response did not include a valid summary");
      }
      return attemptKeyPhrases;
    });

    throwIfAborted(opts.signal);
    const completeCheckpoint: AnalysisCheckpoint = {
      ...currentCheckpoint,
      phase: "complete",
      revision: currentCheckpoint.revision + 1,
    };
    await opts.onCommit({
      kind: "summary",
      keyPhrases,
      checkpoint: completeCheckpoint,
    });
    currentCheckpoint = completeCheckpoint;
    return currentCheckpoint;
  } catch (error) {
    if (opts.signal?.aborted && isAbortError(error)) return currentCheckpoint;
    throw error;
  }
}

function withProviderRetry<T>(
  opts: RunAnalysisOptions,
  operation: () => Promise<T>,
): Promise<T> {
  return retryOperation(operation, {
    policy: ANALYSIS_RETRY_POLICY,
    isRetryable: (error) =>
      isRetryableProviderFailure(error) || error instanceof ProviderProtocolError,
    signal: opts.signal,
    onRetry: (event) => opts.onRetry?.({
      ...event,
      kind: event.error instanceof ModelContentError ? "content-repair" : "transport",
      unresolvedCueIndexes: [],
    }),
  });
}

async function resolveCueBatch(
  opts: RunAnalysisOptions,
  systemPrompt: string,
  batch: readonly SrtCue[],
  startCueOffset: number,
  endCueOffset: number,
  resumePreview: AnalysisPreview | null,
): Promise<Subtitle[]> {
  const requestBatch = withUniqueCueIndexes(batch, startCueOffset);
  const resolved = new Map<number, Subtitle>();
  const annotationRepairOffsets = new Set<number>();
  seedResumePreview(
    resumePreview,
    startCueOffset,
    endCueOffset,
    requestBatch,
    resolved,
    annotationRepairOffsets,
  );
  const resumedHighlightCount = [...resolved.values()]
    .filter((subtitle) => subtitle.isKeyPoint).length;
  const highlightBudget = new HighlightBudget(
    compactHighlightCapacity(requestBatch.length),
    resumedHighlightCount,
  );
  const policy = ANALYSIS_RETRY_POLICY;
  let lastInvalid: InvalidJsonLine | null = null;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    throwIfAborted(opts.signal);
    const requestedCues = requestBatch.filter((requested) => !resolved.has(requested.cueOffset));
    if (requestedCues.length === 0) {
      return finalizeResolvedBatch(
        opts,
        systemPrompt,
        requestBatch,
        resolved,
        annotationRepairOffsets,
        highlightBudget,
        startCueOffset,
        endCueOffset,
      );
    }
    const requested = new Map(requestedCues.map((requested) => [
      requested.cue.index,
      requested,
    ]));
    const requestedForValidation = new Map(requestedCues.map((requested) => [
      requested.cue.index,
      requested.cue,
    ]));
    let streamError: unknown = null;

    try {
      const parser = new JsonLineParser();
      let dirty = false;
      const handle = (value: unknown) => {
        const result = validateCueOutput(value, requestedForValidation);
        if (result.status !== "resolved") return;
        const matched = requested.get(result.index);
        if (!matched || resolved.has(matched.cueOffset)) return;
        const subtitle = result.subtitle.isKeyPoint && !highlightBudget.accept()
          ? withoutAnnotation(result.subtitle)
          : result.subtitle;
        resolved.set(matched.cueOffset, subtitle);
        if (result.needsAnnotationRepair) {
          annotationRepairOffsets.add(matched.cueOffset);
        }
        dirty = true;
      };
      const publishResolved = async () => {
        if (!dirty) return;
        dirty = false;
        const entries = orderedResolvedEntries(
          requestBatch,
          resolved,
          annotationRepairOffsets,
        );
        await opts.onPreview?.({
          startCueOffset,
          endCueOffset,
          entries,
          subtitles: entries.map((entry) => entry.subtitle),
        });
      };
      const invalid = (failure: InvalidJsonLine) => { lastInvalid = failure; };
      const promptCues = requestedCues.map((requested) => requested.cue);
      const promptOptions = { maxHighlightedCues: highlightBudget.remaining };
      const userPrompt = attempt === 1
        ? (startCueOffset === 0
          ? buildUserPrompt(promptCues, promptOptions)
          : buildContinuationPrompt(promptCues, promptOptions))
        : buildRepairPrompt(promptCues, promptOptions);

      for await (const chunk of opts.provider.stream({
        systemPrompt,
        userPrompt,
        signal: opts.signal,
      })) {
        throwIfAborted(opts.signal);
        parser.feed(chunk, handle, invalid);
        await publishResolved();
        throwIfAborted(opts.signal);
      }
      throwIfAborted(opts.signal);
      parser.flush(handle, invalid);
      await publishResolved();
      throwIfAborted(opts.signal);
    } catch (error) {
      if (opts.signal?.aborted && isAbortError(error)) throw error;
      streamError = error;
    }

    const unresolvedCueIndexes = requestBatch
      .filter((requested) => !resolved.has(requested.cueOffset))
      .map((requested) => requested.cue.index);
    if (unresolvedCueIndexes.length === 0) {
      return finalizeResolvedBatch(
        opts,
        systemPrompt,
        requestBatch,
        resolved,
        annotationRepairOffsets,
        highlightBudget,
        startCueOffset,
        endCueOffset,
      );
    }

    if (streamError !== null && !isRetryableAnalysisStreamFailure(streamError)) {
      throw streamError;
    }
    if (attempt === policy.maxAttempts) {
      if (streamError !== null) throw streamError;
      logMalformedLine(lastInvalid);
      throw unresolvedCueError(unresolvedCueIndexes);
    }

    const retryError = streamError ?? unresolvedCueError(unresolvedCueIndexes);
    const delayMs = retryDelay(policy, attempt, retryError);
    opts.onRetry?.({
      kind: streamError === null ? "content-repair" : "transport",
      failedAttempt: attempt,
      nextAttempt: attempt + 1,
      maxAttempts: policy.maxAttempts,
      delayMs,
      error: retryError,
      unresolvedCueIndexes,
    });
    await abortableDelay(delayMs, opts.signal);
  }

  throw new Error("unreachable cue repair state");
}

async function finalizeResolvedBatch(
  opts: RunAnalysisOptions,
  systemPrompt: string,
  requestBatch: readonly RequestedCue[],
  resolved: Map<number, Subtitle>,
  annotationRepairOffsets: Set<number>,
  highlightBudget: HighlightBudget,
  startCueOffset: number,
  endCueOffset: number,
): Promise<Subtitle[]> {
  if (annotationRepairOffsets.size > 0) {
    await repairDamagedAnnotations(
      opts,
      systemPrompt,
      requestBatch,
      resolved,
      annotationRepairOffsets,
      highlightBudget,
      startCueOffset,
      endCueOffset,
    );
  }
  return orderedResolvedEntries(requestBatch, resolved).map((entry) => entry.subtitle);
}

async function repairDamagedAnnotations(
  opts: RunAnalysisOptions,
  systemPrompt: string,
  requestBatch: readonly RequestedCue[],
  resolved: Map<number, Subtitle>,
  annotationRepairOffsets: Set<number>,
  highlightBudget: HighlightBudget,
  startCueOffset: number,
  endCueOffset: number,
): Promise<void> {
  const damaged = requestBatch.filter((entry) => annotationRepairOffsets.has(entry.cueOffset));
  const requested = new Map<number, AnnotationRepairSource>();
  for (const entry of damaged) {
    const subtitle = resolved.get(entry.cueOffset);
    if (!subtitle) continue;
    requested.set(entry.cue.index, {
      cue: entry.cue,
      translation: subtitle.translation,
    });
  }
  if (requested.size === 0) return;

  const unresolvedCueIndexes = [...requested.keys()];
  const patches = await retryOperation(async () => {
    const attemptPatches = new Map<number, SubtitleAnnotationPatch>();
    const parser = new JsonLineParser();
    const handle = (value: unknown) => {
      const result = validateAnnotationRepair(value, requested);
      if (result.status === "resolved" && !attemptPatches.has(result.index)) {
        attemptPatches.set(result.index, result.patch);
      }
    };
    const ignoreInvalid = () => {};

    for await (const chunk of opts.provider.stream({
      systemPrompt,
      userPrompt: buildAnnotationRepairPrompt(damaged.flatMap((entry) => {
        const subtitle = resolved.get(entry.cueOffset);
        return subtitle ? [{
          index: entry.cue.index,
          text: entry.cue.text,
          translation: subtitle.translation,
        }] : [];
      }), { maxHighlightedCues: highlightBudget.remaining }),
      signal: opts.signal,
    })) {
      throwIfAborted(opts.signal);
      parser.feed(chunk, handle, ignoreInvalid);
    }
    parser.flush(handle, ignoreInvalid);
    throwIfAborted(opts.signal);
    return attemptPatches;
  }, {
    policy: ANALYSIS_RETRY_POLICY,
    isRetryable: isRetryableProviderFailure,
    signal: opts.signal,
    onRetry: (event) => opts.onRetry?.({
      ...event,
      kind: "transport",
      unresolvedCueIndexes,
    }),
  });

  for (const entry of damaged) {
    const subtitle = resolved.get(entry.cueOffset);
    const patch = patches.get(entry.cue.index);
    if (subtitle && patch) {
      const acceptedPatch = patch.isKeyPoint && !highlightBudget.accept()
        ? emptyAnnotationPatch()
        : patch;
      resolved.set(entry.cueOffset, { ...subtitle, ...acceptedPatch });
    }
    annotationRepairOffsets.delete(entry.cueOffset);
  }

  const entries = orderedResolvedEntries(requestBatch, resolved, annotationRepairOffsets);
  await opts.onPreview?.({
    startCueOffset,
    endCueOffset,
    entries,
    subtitles: entries.map((entry) => entry.subtitle),
  });
}

function emptyAnnotationPatch(): SubtitleAnnotationPatch {
  return {
    isKeyPoint: false,
    highlightWords: [],
    keyNotes: {},
    highlightTranslations: {},
  };
}

function withoutAnnotation(subtitle: Subtitle): Subtitle {
  return { ...subtitle, ...emptyAnnotationPatch() };
}

function withUniqueCueIndexes(
  batch: readonly SrtCue[],
  startCueOffset: number,
): RequestedCue[] {
  const reserved = new Set(batch.map((cue) => cue.index));
  const seen = new Set<number>();
  let next = Math.max(0, ...reserved) + 1;

  return batch.map((cue, offset) => {
    let uniqueCue = cue;
    if (!seen.has(cue.index)) {
      seen.add(cue.index);
    } else {
      while (reserved.has(next) || seen.has(next)) next += 1;
      const unique = next;
      reserved.add(unique);
      seen.add(unique);
      next += 1;
      uniqueCue = { ...cue, index: unique };
    }
    return { cueOffset: startCueOffset + offset, cue: uniqueCue };
  });
}

function orderedResolvedEntries(
  batch: readonly RequestedCue[],
  resolved: ReadonlyMap<number, Subtitle>,
  annotationRepairOffsets: ReadonlySet<number> = new Set(),
): AnalysisInflightEntry[] {
  return batch.flatMap((requested) => {
    const subtitle = resolved.get(requested.cueOffset);
    return subtitle ? [{
      cueOffset: requested.cueOffset,
      subtitle,
      ...(annotationRepairOffsets.has(requested.cueOffset)
        ? { annotationRepair: true as const }
        : {}),
    }] : [];
  });
}

function seedResumePreview(
  preview: AnalysisPreview | null,
  startCueOffset: number,
  endCueOffset: number,
  requestBatch: readonly RequestedCue[],
  resolved: Map<number, Subtitle>,
  annotationRepairOffsets: Set<number>,
): void {
  if (!preview) return;
  if (
    preview.startCueOffset !== startCueOffset
    || preview.endCueOffset !== endCueOffset
  ) {
    throw new TypeError("analysis resume preview does not match the current batch");
  }
  const validOffsets = new Set(requestBatch.map((requested) => requested.cueOffset));
  for (const entry of preview.entries) {
    if (!validOffsets.has(entry.cueOffset) || resolved.has(entry.cueOffset)) {
      throw new TypeError("analysis resume preview contains an invalid cue offset");
    }
    resolved.set(entry.cueOffset, entry.subtitle);
    if (entry.annotationRepair === true) {
      annotationRepairOffsets.add(entry.cueOffset);
    }
  }
}

function isRetryableAnalysisStreamFailure(error: unknown): boolean {
  return isRetryableProviderFailure(error) || error instanceof ProviderProtocolError;
}

function retryDelay(policy: RetryPolicy, attempt: number, error: unknown): number {
  const base = policy.backoffMs[attempt - 1]
    ?? policy.backoffMs[policy.backoffMs.length - 1]
    ?? 0;
  const retryAfter = error instanceof ProviderHttpError ? error.retryAfterMs ?? 0 : 0;
  return Math.max(base, retryAfter);
}

function unresolvedCueError(indexes: readonly number[]): ModelContentError {
  return new ModelContentError(
    `模型返回格式异常，${indexes.length} 条字幕仍未完成（索引：${indexes.join("、")}）`,
  );
}

function logMalformedLine(failure: InvalidJsonLine | null): void {
  if (!failure) return;
  const excerpt = JSON.stringify(redactDiagnosticExcerpt(failure.line.slice(0, 240)));
  console.warn(`Ignored malformed model JSON: ${failure.error.message}; excerpt=${excerpt}`);
}

function redactDiagnosticExcerpt(value: string): string {
  return value
    .replace(/\bsk-[a-z0-9._-]{8,}\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[a-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|token|authorization)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      "$1[REDACTED]",
    );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
}
