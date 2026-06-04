/**
 * whatSub managed-LLM relay error mapping.
 *
 * The relay (`whatsub.eversay.cc/api/llm`) rejects requests with a structured
 * JSON body: `{ error: "<code>", message: "<friendly zh>" , … }`. Without this
 * mapping the generic openai-compatible path surfaces the raw
 * `API 429: {"error":"quota_exceeded",…}` string — useless at the exact moment
 * a user hits a quota wall (spec §3.4: that's the hottest conversion moment).
 *
 * This turns a relay rejection into a clean, actionable message plus an
 * `upsell` flag (true = "the fix is upgrade / switch key", not "retry"), so the
 * analysis + agent surfaces can show the right copy (and, later, a 升级 CTA).
 *
 * 2026-06-04 (managed-LLM relay phase 4 — friendly errors).
 */

export interface RelayErrorInfo {
  /** Machine code from the relay (`quota_exceeded`, `license_blocked`, …). */
  code: string;
  /** Friendly, user-facing Chinese message. */
  message: string;
  /** True when the right user action is to upgrade / switch key (not retry). */
  upsell: boolean;
}

/** Fallback copy when the relay didn't send a `message` (older server, or a
 *  proxy-level error with only a code). Keyed by the relay's `error` code. */
const FALLBACK: Record<string, string> = {
  auth_required: "whatSub 托管会话已过期，请到「我的」重新登录后再试。",
  license_blocked:
    "你购买的是买断版（BYOK），whatSub 托管 LLM 仅限订阅 Pro。请在设置里改用自己的 API key，或升级 Pro。",
  quota_exceeded: "本月 whatSub 托管额度已用完，下月 1 日重置，或升级配额。",
  trial_used_up: "免费试用额度已用完。升级 Pro 继续使用，或在设置里改用自己的 API key。",
  free_used_up: "免费体验额度已用完。升级 Pro 解锁完整额度，或改用自己的 API key。",
  input_too_large: "本次输入过长，超出 whatSub 托管单次上限。",
  rate_limited: "请求过于频繁，请稍后再试。",
  service_unavailable: "whatSub 托管暂不可用，请稍后再试或改用自己的 API key。",
};

/** Codes where retrying won't help — the user must upgrade or switch provider. */
const UPSELL_CODES = new Set([
  "license_blocked",
  "quota_exceeded",
  "trial_used_up",
  "free_used_up",
]);

/** Parse a relay error response body into friendly info. Returns null when the
 *  body doesn't look like a structured relay error (no `error` code) — so the
 *  caller keeps its generic handling for non-relay openai-compatible vendors
 *  and for plain proxy failures. */
export function parseRelayError(
  _status: number,
  bodyText: string,
): RelayErrorInfo | null {
  let code = "";
  let message = "";
  try {
    const obj = JSON.parse(bodyText) as { error?: unknown; message?: unknown };
    if (typeof obj.error === "string") code = obj.error;
    if (typeof obj.message === "string") message = obj.message;
  } catch {
    // Non-JSON body (HTML 502 page, empty, etc.) — not a structured relay error.
  }
  if (!code) return null;
  return {
    code,
    message: message || FALLBACK[code] || `whatSub 托管出错（${code}）`,
    upsell: UPSELL_CODES.has(code),
  };
}

/** Thrown by the openai-compatible provider's `stream()` when the whatSub
 *  relay rejects a request. `message` is already user-friendly, so callers
 *  that read `e.message` surface the right copy with no extra mapping. */
export class RelayError extends Error {
  readonly code: string;
  readonly status: number;
  readonly upsell: boolean;
  constructor(info: RelayErrorInfo, status: number) {
    super(info.message);
    this.name = "RelayError";
    this.code = info.code;
    this.status = status;
    this.upsell = info.upsell;
  }
}
