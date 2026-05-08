import type { Provider } from "./providers/types";
import { buildLookupPrompt } from "./prompts";

export interface LookupResult {
  meaningZh: string;
  usage: string;
}

const SYSTEM = "You are a precise English-to-Chinese vocabulary helper. Output only the requested JSON object.";

export async function lookupExpression(
  expression: string,
  cueText: string,
  provider: Provider,
  signal?: AbortSignal,
): Promise<LookupResult> {
  let buffer = "";
  for await (const chunk of provider.stream({
    systemPrompt: SYSTEM,
    userPrompt: buildLookupPrompt(expression, cueText),
    signal,
  })) {
    buffer += chunk;
  }
  const json = extractJsonObject(buffer);
  const parsed = JSON.parse(json) as Partial<LookupResult>;
  return {
    meaningZh: String(parsed.meaningZh ?? "").trim(),
    usage: String(parsed.usage ?? "").trim(),
  };
}

/**
 * Tolerant extractor: strips ```json``` / ``` fences and any prose before the
 * first `{` or after the last `}`. LLMs occasionally wrap output despite the
 * "no fences, no prose" instruction in the prompt.
 */
export function extractJsonObject(raw: string): string {
  let s = raw.trim();
  // Strip fenced code block, both ```json and bare ```
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const m = s.match(fence);
  if (m) s = m[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return s;
  return s.slice(first, last + 1);
}
