import type { Provider } from "./providers/types";
import type { Subtitle, SrtCue, AnalysisResult } from "./types";
import type { TranslationStyle } from "../types/settings";
import { batchSubtitles } from "./batchSubtitles";
import { JsonLineParser } from "./streamingJson";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildContinuationPrompt,
  buildSummaryPrompt,
} from "./prompts";

export interface RunAnalysisOptions {
  provider: Provider;
  cues: SrtCue[];
  onCue: (cue: Subtitle) => void;
  onSummary: (summary: Omit<AnalysisResult, "subtitles">) => void;
  /**
   * Cues already analyzed in a previous session (resume case). They are NOT
   * re-sent for cue analysis, but ARE included in the global summary call so
   * keyPhrases reflect the FULL transcript, not just this run's slice.
   */
  previouslyAnalyzed?: Subtitle[];
  batchSize?: number;
  /**
   * Translation register applied across both phases. Defaults to "colloquial"
   * if not provided so existing call sites without a style stay consistent
   * with the pre-multi-style behavior.
   */
  style?: TranslationStyle;
  /**
   * AbortSignal for user-initiated stop. Threads through to the provider's
   * fetch call so the in-flight HTTP body reader unblocks promptly.
   * runAnalysis returns early (without throwing) when aborted.
   */
  signal?: AbortSignal;
}

export async function runAnalysis(opts: RunAnalysisOptions): Promise<void> {
  const batchSize = opts.batchSize ?? 50;
  const batches = batchSubtitles(opts.cues, batchSize);
  const systemPrompt = buildSystemPrompt(opts.style ?? "colloquial");
  // Collect every analyzed cue so the final summary call sees the WHOLE
  // transcript (resumed sessions seed this from previouslyAnalyzed).
  const analyzedCues: Subtitle[] = [...(opts.previouslyAnalyzed ?? [])];

  // ── Phase 1: per-cue analysis, batch by batch (no summary asked) ──
  for (let i = 0; i < batches.length; i++) {
    if (opts.signal?.aborted) return;

    const batch = batches[i];
    const userPrompt = i === 0 ? buildUserPrompt(batch) : buildContinuationPrompt(batch);

    // Index → original cue lookup so parseCue can fill text/time/endTime
    // from the input cue when the LLM omits or mangles those fields in
    // its echo. We treat the cues we sent to the LLM as the authoritative
    // source for those — there's no point trusting a re-typing of input.
    const byIndex = new Map<number, SrtCue>(batch.map((c) => [c.index, c]));
    // Fallback positional iterator for models that don't echo `index` either
    // (rare, but seen). LLM is supposed to emit cues in batch order.
    let positionalIter = 0;

    const parser = new JsonLineParser();
    const handle = (obj: unknown) => {
      const original = resolveOriginal(obj, byIndex, batch, positionalIter);
      if (original) positionalIter = batch.indexOf(original) + 1;
      const cue = parseCue(obj, original);
      if (!cue) return;
      analyzedCues.push(cue);
      opts.onCue(cue);
    };
    for await (const chunk of opts.provider.stream({
      systemPrompt,
      userPrompt,
      signal: opts.signal,
    })) {
      if (opts.signal?.aborted) return;
      parser.feed(chunk, handle);
    }
    parser.flush(handle);
  }

  if (opts.signal?.aborted) return;
  if (analyzedCues.length === 0) return;

  // ── Phase 2: single global summary call across the whole transcript ──
  // Wrapped in try/catch — losing the summary should NOT mark the run as failed
  // because all cue analyses are already saved.
  try {
    const parser = new JsonLineParser();
    const handle = (obj: unknown) => {
      const summary = parseSummary(obj);
      if (summary) opts.onSummary(summary);
    };
    for await (const chunk of opts.provider.stream({
      systemPrompt,
      userPrompt: buildSummaryPrompt(analyzedCues),
      signal: opts.signal,
    })) {
      if (opts.signal?.aborted) return;
      parser.feed(chunk, handle);
    }
    parser.flush(handle);
  } catch (e) {
    if (opts.signal?.aborted) return;
    // Cues are intact; only the summary failed. Surface a console warning so
    // the dev sees it, but don't propagate — the caller's catch path would
    // otherwise mark the entire video status=failed.
    console.warn("global summary call failed; keyPhrases will be empty", e);
  }
}

/**
 * Match the LLM's emitted cue object back to the original SrtCue we sent
 * in this batch. Tries `index` echo first, falls back to positional
 * (LLM is asked for one line per cue in order). Used so parseCue can pull
 * authoritative text/time/endTime from the input rather than trusting
 * the LLM to echo them — some models silently drop those fields, which
 * earlier caused `text` to render as the literal string "undefined".
 */
function resolveOriginal(
  obj: unknown,
  byIndex: Map<number, SrtCue>,
  batch: SrtCue[],
  positional: number,
): SrtCue | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  const idx = Number(o.index);
  if (Number.isFinite(idx) && byIndex.has(idx)) return byIndex.get(idx);
  // No usable index → use positional fallback (cues stream in order).
  if (positional < batch.length) return batch[positional];
  return undefined;
}

function parseCue(obj: unknown, original: SrtCue | undefined): Subtitle | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== "cue") return null;

  // text/time/endTime come from the input (we already know them); the LLM's
  // echo is only used as a last-resort fallback if for some reason we
  // can't resolve the original cue. Without this fallback, models that
  // skip the echo to save tokens caused every cue to render text =
  // "undefined" (String(undefined)).
  const text = original?.text ?? String(o.text ?? "");
  const time = original?.time ?? Number(o.time);
  const endTime = original?.endTime ?? Number(o.endTime);

  return {
    time,
    endTime,
    text,
    translation: String(o.translation ?? ""),
    isKeyPoint: Boolean(o.isKeyPoint),
    highlightWords: Array.isArray(o.highlightWords) ? (o.highlightWords as string[]) : [],
    // Reject anything that isn't a plain {phrase: note} object — some models
    // occasionally collapse the per-phrase dict into one big summary string,
    // which then makes `keyNotes[word]` undefined and the tooltip silently
    // disappear. Falling back to {} keeps highlights interactive even when
    // the model fumbles the schema (the tooltip just won't render).
    keyNotes: isPlainObject(o.keyNotes) ? (o.keyNotes as Record<string, string>) : {},
    highlightTranslations: isPlainObject(o.highlightTranslations)
      ? (o.highlightTranslations as Record<string, string>)
      : {},
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseSummary(obj: unknown): Omit<AnalysisResult, "subtitles"> | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== "summary") return null;
  const { type: _drop, ...rest } = o;
  return rest as unknown as Omit<AnalysisResult, "subtitles">;
}
