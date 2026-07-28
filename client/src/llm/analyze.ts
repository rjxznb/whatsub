import type { TranslationStyle } from "../types/settings";
import type { Provider } from "./providers/types";
import {
  isAbortError,
  isRetryableProviderFailure,
  ProviderProtocolError,
} from "./providers/errors";
import type {
  AnalysisCheckpoint,
  AnalysisResult,
  KeyPhrase,
  SrtCue,
  Subtitle,
} from "./types";
import { JsonLineParser } from "./streamingJson";
import { retryOperation, type RetryEvent, type RetryPolicy } from "./retry";
import {
  buildContinuationPrompt,
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

export type AnalysisRetryEvent = RetryEvent;

export interface RunAnalysisOptions {
  provider: Provider;
  cues: readonly SrtCue[];
  previouslyAnalyzed: readonly Subtitle[];
  checkpoint: AnalysisCheckpoint;
  onCommit: (commit: AnalysisCommit) => Promise<void>;
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
      const userPrompt = startCueOffset === 0
        ? buildUserPrompt(batch)
        : buildContinuationPrompt(batch);

      const subtitles = await withProviderRetry(opts, async () => {
        const parser = new JsonLineParser();
        const attemptSubtitles: Subtitle[] = [];
        const byIndex = new Map<number, SrtCue>(batch.map((cue) => [cue.index, cue]));
        let positionalIter = 0;
        const handle = (obj: unknown) => {
          const original = resolveOriginal(obj, byIndex, batch, positionalIter);
          if (original) positionalIter = batch.indexOf(original) + 1;
          const cue = parseCue(obj, original);
          if (cue) attemptSubtitles.push(cue);
        };
        const invalid = (line: string) => {
          throw new ProviderProtocolError(`Malformed JSON line from provider: ${line}`);
        };

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
        return attemptSubtitles;
      });

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
      const handle = (obj: unknown) => {
        const summary = parseSummary(obj);
        if (summary) attemptKeyPhrases = summary;
      };
      const invalid = (line: string) => {
        throw new ProviderProtocolError(`Malformed JSON line from provider: ${line}`);
      };

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
        throw new ProviderProtocolError("Provider response did not include a valid summary");
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
    isRetryable: isRetryableProviderFailure,
    signal: opts.signal,
    onRetry: opts.onRetry,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
}

/**
 * Match a model cue back to its authoritative source cue. Index is preferred;
 * positional matching preserves compatibility with models that omit indexes.
 */
function resolveOriginal(
  obj: unknown,
  byIndex: Map<number, SrtCue>,
  batch: readonly SrtCue[],
  positional: number,
): SrtCue | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const output = obj as Record<string, unknown>;
  const index = Number(output.index);
  if (Number.isFinite(index) && byIndex.has(index)) return byIndex.get(index);
  if (positional < batch.length) return batch[positional];
  return undefined;
}

function parseCue(obj: unknown, original: SrtCue | undefined): Subtitle | null {
  if (!obj || typeof obj !== "object") return null;
  const output = obj as Record<string, unknown>;
  if (output.type !== "cue") return null;

  return {
    time: original?.time ?? Number(output.time),
    endTime: original?.endTime ?? Number(output.endTime),
    text: original?.text ?? String(output.text ?? ""),
    translation: String(output.translation ?? ""),
    isKeyPoint: Boolean(output.isKeyPoint),
    highlightWords: Array.isArray(output.highlightWords)
      ? (output.highlightWords as string[])
      : [],
    keyNotes: isPlainObject(output.keyNotes)
      ? (output.keyNotes as Record<string, string>)
      : {},
    highlightTranslations: isPlainObject(output.highlightTranslations)
      ? (output.highlightTranslations as Record<string, string>)
      : {},
  };
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
