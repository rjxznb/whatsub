import { isAllowedLearningPhrase } from "./phraseRules";
import type { KeyPhrase } from "./types";

export function validateSummaryOutput(value: unknown): KeyPhrase[] | null {
  if (!isPlainObject(value)) return null;

  let candidates: unknown[];
  if (Array.isArray(value.p)) {
    candidates = value.p.map((tuple) => Array.isArray(tuple)
      ? { expression: tuple[0], meaningZh: tuple[1], usage: tuple[2] }
      : null);
  } else if (value.type === "summary" && Array.isArray(value.keyPhrases)) {
    candidates = value.keyPhrases;
  } else {
    return null;
  }

  const output: KeyPhrase[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isPlainObject(candidate)) continue;
    const expression = typeof candidate.expression === "string"
      ? candidate.expression.trim()
      : "";
    const meaningZh = typeof candidate.meaningZh === "string"
      ? candidate.meaningZh.trim()
      : "";
    const usage = typeof candidate.usage === "string" ? candidate.usage.trim() : "";
    if (!expression || !meaningZh || !usage) continue;
    if (!isAllowedLearningPhrase(expression)) continue;
    const key = expression.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ expression, meaningZh, usage });
  }
  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
