import type { TranslationStyle } from "../types/settings";
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
import { validateCueOutput } from "./cueOutput";
import { JsonLineParser, type InvalidJsonLine } from "./streamingJson";
import {
  abortableDelay,
  retryOperation,
  type RetryEvent,
  type RetryPolicy,
} from "./retry";
import {
  buildContinuationPrompt,
  buildRepairPrompt,
  buildSummaryPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from "./prompts";

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
  onPreview?: (preview: AnalysisPreview | null) => void;
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

const DEEPSEEK_ANALYSIS_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  backoffMs: [500, 1500, 3500],
};

const NO_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
  backoffMs: [],
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
        );

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
        opts.onPreview?.(null);
      } catch (error) {
        opts.onPreview?.(null);
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
        const summary = parseSummary(obj);
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
    policy: opts.provider.retryProfile === "deepseek-analysis"
      ? DEEPSEEK_ANALYSIS_RETRY_POLICY
      : NO_RETRY_POLICY,
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
): Promise<Subtitle[]> {
  const requestBatch = withUniqueCueIndexes(batch);
  const resolved = new Map<number, Subtitle>();
  const policy = retryPolicyFor(opts.provider);
  let lastInvalid: InvalidJsonLine | null = null;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    throwIfAborted(opts.signal);
    const requestedCues = requestBatch.filter((cue) => !resolved.has(cue.index));
    if (requestedCues.length === 0) return orderedResolved(requestBatch, resolved);
    const requested = new Map(requestedCues.map((cue) => [cue.index, cue]));
    let streamError: unknown = null;

    try {
      const parser = new JsonLineParser();
      const handle = (value: unknown) => {
        const result = validateCueOutput(value, requested);
        if (result.status !== "resolved" || resolved.has(result.index)) return;
        resolved.set(result.index, result.subtitle);
        opts.onPreview?.({
          startCueOffset,
          endCueOffset,
          subtitles: orderedResolved(requestBatch, resolved),
        });
      };
      const invalid = (failure: InvalidJsonLine) => { lastInvalid = failure; };
      const userPrompt = attempt === 1
        ? (startCueOffset === 0
          ? buildUserPrompt(requestedCues)
          : buildContinuationPrompt(requestedCues))
        : buildRepairPrompt(requestedCues);

      for await (const chunk of opts.provider.stream({
        systemPrompt,
        userPrompt,
        signal: opts.signal,
      })) {
        throwIfAborted(opts.signal);
        parser.feed(chunk, handle, invalid);
      }
      throwIfAborted(opts.signal);
      parser.flush(handle, invalid);
      throwIfAborted(opts.signal);
    } catch (error) {
      if (opts.signal?.aborted && isAbortError(error)) throw error;
      streamError = error;
    }

    const unresolvedCueIndexes = requestBatch
      .filter((cue) => !resolved.has(cue.index))
      .map((cue) => cue.index);
    if (unresolvedCueIndexes.length === 0) return orderedResolved(requestBatch, resolved);

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

function withUniqueCueIndexes(batch: readonly SrtCue[]): SrtCue[] {
  const reserved = new Set(batch.map((cue) => cue.index));
  const seen = new Set<number>();
  let next = Math.max(0, ...reserved) + 1;

  return batch.map((cue) => {
    if (!seen.has(cue.index)) {
      seen.add(cue.index);
      return cue;
    }
    while (reserved.has(next) || seen.has(next)) next += 1;
    const unique = next;
    reserved.add(unique);
    seen.add(unique);
    next += 1;
    return { ...cue, index: unique };
  });
}

function retryPolicyFor(provider: Provider): RetryPolicy {
  return provider.retryProfile === "deepseek-analysis"
    ? DEEPSEEK_ANALYSIS_RETRY_POLICY
    : NO_RETRY_POLICY;
}

function orderedResolved(
  batch: readonly SrtCue[],
  resolved: ReadonlyMap<number, Subtitle>,
): Subtitle[] {
  return batch.flatMap((cue) => {
    const subtitle = resolved.get(cue.index);
    return subtitle ? [subtitle] : [];
  });
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSummary(obj: unknown): KeyPhrase[] | null {
  if (!obj || typeof obj !== "object") return null;
  const output = obj as Record<string, unknown>;
  if (
    output.type !== "summary"
    || !Array.isArray(output.keyPhrases)
    || !output.keyPhrases.every(isKeyPhrase)
  ) {
    return null;
  }
  return output.keyPhrases;
}

function isKeyPhrase(value: unknown): value is KeyPhrase {
  return isPlainObject(value)
    && typeof value.expression === "string"
    && typeof value.meaningZh === "string"
    && typeof value.usage === "string";
}
