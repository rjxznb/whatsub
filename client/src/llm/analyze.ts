import type { Provider } from "./providers/types";
import type { Subtitle, SrtCue, AnalysisResult } from "./types";
import { batchSubtitles } from "./batchSubtitles";
import { JsonLineParser } from "./streamingJson";
import { SYSTEM_PROMPT, buildUserPrompt, buildContinuationPrompt } from "./prompts";

export interface RunAnalysisOptions {
  provider: Provider;
  cues: SrtCue[];
  onCue: (cue: Subtitle) => void;
  onSummary: (summary: Omit<AnalysisResult, "subtitles">) => void;
  batchSize?: number;
}

export async function runAnalysis(opts: RunAnalysisOptions): Promise<void> {
  const batchSize = opts.batchSize ?? 50;
  const batches = batchSubtitles(opts.cues, batchSize);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const isLast = i === batches.length - 1;
    const userPrompt =
      i === 0 ? buildUserPrompt(batch) : buildContinuationPrompt(batch, isLast);

    const parser = new JsonLineParser();
    for await (const chunk of opts.provider.stream({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
    })) {
      parser.feed(chunk, (obj) => routeObject(obj, opts));
    }
    parser.flush((obj) => routeObject(obj, opts));
  }
}

function routeObject(obj: unknown, opts: RunAnalysisOptions): void {
  if (!obj || typeof obj !== "object") return;
  const o = obj as Record<string, unknown>;
  if (o.type === "cue") {
    const cue: Subtitle = {
      time: Number(o.time),
      endTime: Number(o.endTime),
      text: String(o.text),
      translation: String(o.translation),
      isKeyPoint: Boolean(o.isKeyPoint),
      highlightWords: Array.isArray(o.highlightWords) ? (o.highlightWords as string[]) : [],
      keyNotes: (o.keyNotes as Record<string, string>) ?? {},
      highlightTranslations: (o.highlightTranslations as Record<string, string>) ?? {},
    };
    opts.onCue(cue);
  } else if (o.type === "summary") {
    const { type: _drop, ...rest } = o;
    opts.onSummary(rest as unknown as Omit<AnalysisResult, "subtitles">);
  }
}
