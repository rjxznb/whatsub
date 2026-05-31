// Pure heuristics, no LLM. Used to show users "this will cost ~X tokens"
// before kicking off any LLM-spending UI. Calibrate by comparing predicted
// vs actual usage in the structured logs after sessions — the spec ships
// initial coefficients and we tune in v1.1.

// ──────────── Lesson ────────────
//
// Per anchor: step 2 (讲解) + step 3 (问题) + step 5 (反馈) ≈ 500 tokens.
// Plus plan call (500) + end summary (500). With error retries, an average
// session sees ~1-2 anchors getting a 2nd round of step 5, so add 10%
// buffer. We do NOT bake retry into the per-anchor base — keeps math
// auditable.

const LESSON_FIXED_OVERHEAD = 1000; // plan + summary
const LESSON_PER_ANCHOR = 500;
const LESSON_RETRY_BUFFER = 1.1;    // 10% over the deterministic base

export function estimateLessonTokens(anchorCount: number): number {
  const base = LESSON_FIXED_OVERHEAD + anchorCount * LESSON_PER_ANCHOR;
  return Math.round(base * LESSON_RETRY_BUFFER);
}

// ──────────── Roleplay ────────────
//
// Scene picker (1000) + ~800 tokens per planned minute (one turn each side,
// ~25 sec/turn) + forensic report (1500). Users always over-estimate how
// long they'll RP for — we cap default plannedMinutes at 5 in the picker.

const RP_SCENE_OVERHEAD = 1000;
const RP_PER_MINUTE = 800;
const RP_REPORT_OVERHEAD = 1500;

export function estimateRoleplayTokens(opts: { plannedMinutes: number }): number {
  return (
    RP_SCENE_OVERHEAD +
    opts.plannedMinutes * RP_PER_MINUTE +
    RP_REPORT_OVERHEAD
  );
}

// ──────────── Remediation ────────────
//
// 2 LLM-generated questions (1000) + per-question grading (500). The 5-8
// question pack is mostly hard-coded so cost is roughly constant.

export function estimateRemediationTokens(): number {
  return 1500;
}

// ──────────── Cost preview ────────────
//
// User-facing pricing — assumes 30/70 input/output split (we generate
// more than we read on tutor calls). Per-vendor rates come from settings,
// defaulting to common public prices. NOT a billing source of truth.

export interface VendorPricing {
  inputPerKTokens: number;  // ¥ per 1000 input tokens
  outputPerKTokens: number; // ¥ per 1000 output tokens
}

export function approxYuan(totalTokens: number, pricing: VendorPricing): number {
  const inputTokens = totalTokens * 0.3;
  const outputTokens = totalTokens * 0.7;
  return (
    (inputTokens / 1000) * pricing.inputPerKTokens +
    (outputTokens / 1000) * pricing.outputPerKTokens
  );
}

/** Default pricing per vendor key. Pulled in by settings UI; missing
 *  vendors fall back to a generic "ask user" state in the dialog. */
export const DEFAULT_VENDOR_PRICING: Record<string, VendorPricing> = {
  deepseek: { inputPerKTokens: 0.001, outputPerKTokens: 0.002 },
  kimi: { inputPerKTokens: 0.012, outputPerKTokens: 0.012 },
  qwen: { inputPerKTokens: 0.0035, outputPerKTokens: 0.014 },
  claude: { inputPerKTokens: 0.022, outputPerKTokens: 0.108 },
  "claude-haiku": { inputPerKTokens: 0.0058, outputPerKTokens: 0.029 },
  gemini: { inputPerKTokens: 0.009, outputPerKTokens: 0.029 },
  "gemini-flash": { inputPerKTokens: 0.00054, outputPerKTokens: 0.00216 },
  openai: { inputPerKTokens: 0.022, outputPerKTokens: 0.072 },
  "openai-mini": { inputPerKTokens: 0.0011, outputPerKTokens: 0.0043 },
};
