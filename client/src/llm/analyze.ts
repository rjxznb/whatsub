import type { Provider } from "./providers/types";
import type { Subtitle, SrtCue, AnalysisResult } from "./types";
import { batchSubtitles } from "./batchSubtitles";
import { JsonLineParser } from "./streamingJson";
import {
  SYSTEM_PROMPT,
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
   * AbortSignal for user-initiated stop. Threads through to the provider's
   * fetch call so the in-flight HTTP body reader unblocks promptly.
   * runAnalysis returns early (without throwing) when aborted.
   */
  signal?: AbortSignal;
}

export async function runAnalysis(opts: RunAnalysisOptions): Promise<void> {
  const batchSize = opts.batchSize ?? 50;
  const batches = batchSubtitles(opts.cues, batchSize);
  // Collect every analyzed cue so the final summary call sees the WHOLE
  // transcript (resumed sessions seed this from previouslyAnalyzed).
  const analyzedCues: Subtitle[] = [...(opts.previouslyAnalyzed ?? [])];

  // ── Phase 1: per-cue analysis, batch by batch (no summary asked) ──
  for (let i = 0; i < batches.length; i++) {
    if (opts.signal?.aborted) return;

    const batch = batches[i];
    const userPrompt = i === 0 ? buildUserPrompt(batch) : buildContinuationPrompt(batch);

    const parser = new JsonLineParser();
    const handle = (obj: unknown) => {
      const cue = parseCue(obj);
      if (!cue) return;
      analyzedCues.push(cue);
      opts.onCue(cue);
    };
    for await (const chunk of opts.provider.stream({
      systemPrompt: SYSTEM_PROMPT,
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
      systemPrompt: SYSTEM_PROMPT,
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

function parseCue(obj: unknown): Subtitle | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== "cue") return null;
  return {
    time: Number(o.time),
    endTime: Number(o.endTime),
    text: String(o.text),
    translation: String(o.translation),
    isKeyPoint: Boolean(o.isKeyPoint),
    highlightWords: Array.isArray(o.highlightWords) ? (o.highlightWords as string[]) : [],
    keyNotes: (o.keyNotes as Record<string, string>) ?? {},
    highlightTranslations: (o.highlightTranslations as Record<string, string>) ?? {},
  };
}

function parseSummary(obj: unknown): Omit<AnalysisResult, "subtitles"> | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== "summary") return null;
  const { type: _drop, ...rest } = o;
  return rest as unknown as Omit<AnalysisResult, "subtitles">;
}
