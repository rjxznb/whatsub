import type { ForensicReport, ObservedError, RoleplayTurn, RoleplayScenario } from "./types";
import { coerceErrorPattern } from "./errorPatterns";
import { extractJsonObject } from "./lessonPlanLLM";
import { getProvider } from "../llm/providers";
import type { Settings } from "../types/settings";

function concatSse(raw: string): string {
  let out = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const body = line.slice(5).trim();
    if (!body || body === "[DONE]") continue;
    try {
      const obj = JSON.parse(body);
      const t =
        obj?.choices?.[0]?.delta?.content ??
        obj?.delta?.text ??
        obj?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof t === "string") out += t;
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/**
 * Parse a (potentially SSE-framed) report response into a ForensicReport.
 * Synchronous — no I/O. Call sites may still `await` it harmlessly.
 * Returns null when there is no valid JSON object or totalUserTurns is not numeric.
 */
export function parseReportFromStream(rawStream: string): ForensicReport | null {
  const text = concatSse(rawStream);
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== "object") return null;
  const raw = obj as Record<string, unknown>;
  if (typeof raw.totalUserTurns !== "number") return null;
  return {
    totalUserTurns: raw.totalUserTurns,
    naturalCount: typeof raw.naturalCount === "number" ? raw.naturalCount : 0,
    chinglishExamples: Array.isArray(raw.chinglishExamples)
      ? raw.chinglishExamples
          .map((e: unknown) => {
            const r = e as Record<string, unknown>;
            if (typeof r.original !== "string" || typeof r.better !== "string") return null;
            return { original: r.original, better: r.better };
          })
          .filter((e): e is { original: string; better: string } => e !== null)
      : [],
    patternHits: Array.isArray(raw.patternHits)
      ? raw.patternHits
          .map((p: unknown) => {
            const r = p as Record<string, unknown>;
            if (typeof r.count !== "number") return null;
            return {
              pattern: coerceErrorPattern(typeof r.pattern === "string" ? r.pattern : null),
              count: r.count,
              example: typeof r.example === "string" ? r.example : "",
              monthCount: typeof r.monthCount === "number" ? r.monthCount : undefined,
            };
          })
          .filter((p): p is NonNullable<typeof p> => p !== null)
      : [],
    registerNotes: Array.isArray(raw.registerNotes)
      ? raw.registerNotes.filter((n) => typeof n === "string") as string[]
      : [],
    fallback: false,
  };
}

/**
 * Build a minimal report from buffered observations when the LLM
 * returns malformed JSON. Spec §降级路径. Pure, no LLM.
 */
export function fallbackReport(
  totalUserTurns: number,
  observations: ObservedError[],
): ForensicReport {
  const byPattern = new Map<string, { count: number; example: string }>();
  for (const o of observations) {
    const slot = byPattern.get(o.pattern) ?? { count: 0, example: o.userText };
    slot.count += 1;
    byPattern.set(o.pattern, slot);
  }
  return {
    totalUserTurns,
    naturalCount: Math.max(0, totalUserTurns - observations.length),
    chinglishExamples: observations
      .filter((o) => o.pattern.startsWith("chinglish"))
      .slice(0, 4)
      .map((o) => ({ original: o.userText, better: o.correction })),
    patternHits: Array.from(byPattern.entries())
      .map(([pattern, { count, example }]) => ({
        pattern: coerceErrorPattern(pattern),
        count,
        example,
      }))
      .sort((a, b) => b.count - a.count),
    registerNotes: [],
    fallback: true,
  };
}

const REPORT_SYSTEM = `You are reviewing a completed roleplay session for a Chinese English learner. Given the full turn history and the buffered observations, output JSON only:
{
  "totalUserTurns": number,
  "naturalCount": number,
  "chinglishExamples": [{"original": "...", "better": "..."}],
  "patternHits": [{"pattern": "...", "count": number, "example": "..."}],
  "registerNotes": ["..."]
}
Group observations by pattern. Reorder pattern hits by frequency.

Controlled patterns: past_tense_irregular, past_tense_regular, third_person_singular, article_missing, article_wrong, preposition_wrong, subject_verb_agreement, present_perfect_vs_past, modal_verb_wrong, conditional_form, chinglish_directness, chinglish_word_order, false_friend, register_too_formal, register_too_casual, word_choice_unnatural, other.`;

export async function generateReport(args: {
  settings: Settings;
  scenario: RoleplayScenario;
  turns: RoleplayTurn[];
  observations: ObservedError[];
  signal?: AbortSignal;
}): Promise<ForensicReport> {
  const totalUserTurns = args.turns.filter((t) => t.role === "user").length;
  try {
    const provider = getProvider(args.settings);
    let raw = "";
    for await (const chunk of provider.stream({
      systemPrompt: REPORT_SYSTEM,
      userPrompt: JSON.stringify({
        scenario: args.scenario,
        turns: args.turns,
        observations: args.observations,
      }),
      signal: args.signal,
    })) {
      raw += chunk;
    }
    const wrapped = `data: ${JSON.stringify({ choices: [{ delta: { content: raw } }] })}\n\ndata: [DONE]\n`;
    const parsed = parseReportFromStream(wrapped);
    if (parsed) return parsed;
  } catch (e) {
    console.warn("[tutor] report LLM call failed, falling back", e);
  }
  return fallbackReport(totalUserTurns, args.observations);
}
