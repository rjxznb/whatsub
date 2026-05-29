/**
 * Per-1000-character cost estimates in CNY for the LLM providers we support.
 *
 * Derived from each vendor's public per-1k-token pricing assuming
 * ≈ 1 token per 1.5 Chinese characters or ≈ 0.75 English words, blended
 * input + output (rough average — actual cost varies with the I/O ratio).
 *
 * Conservative: numbers are rounded UP so the user-facing estimate is a
 * safe upper bound. Better to look 1 cent expensive than understate.
 *
 * Vendor + model strings are case-folded before lookup, so config can use
 * either casing.
 */
export const TUTOR_PRICING_CNY_PER_1K_CHARS: Record<string, number> = {
  "deepseek/deepseek-chat":     0.002,
  "deepseek/deepseek-reasoner": 0.004,
  "claude/claude-3-5-sonnet":   0.05,
  "claude/claude-3-5-haiku":    0.012,
  "openai/gpt-4o":              0.04,
  "openai/gpt-4o-mini":         0.003,
  "gemini/gemini-2-flash":      0.005,
};

/**
 * Estimate the cost in CNY for an LLM call of `chars` characters
 * (prompt + expected response).
 *
 * Returns `null` if we don't know the model — caller should hide the ¥
 * figure in that case (still show the char estimate).
 *
 * The returned number is rounded UP to the nearest cent (¥0.01).
 * Special case: exactly 0 chars returns 0, not 0.01.
 */
export function estimateCost(
  vendor: string,
  model: string,
  chars: number,
): number | null {
  const key = `${vendor.toLowerCase()}/${model.toLowerCase()}`;
  const rate = TUTOR_PRICING_CNY_PER_1K_CHARS[key];
  if (rate == null) return null;
  const raw = (chars / 1000) * rate;
  return Math.ceil(raw * 100) / 100;
}
