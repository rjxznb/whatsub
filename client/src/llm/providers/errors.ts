type ErrorOptions = { cause?: unknown };

export class ProviderHttpError extends Error {
  readonly cause?: unknown;

  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs: number | null,
    options?: ErrorOptions,
  ) {
    super(message);
    this.cause = options?.cause;
    this.name = "ProviderHttpError";
  }
}

export class ProviderTransportError extends Error {
  readonly cause?: unknown;

  constructor(
    message: string,
    readonly stage: "send" | "read",
    options?: ErrorOptions,
  ) {
    super(message);
    this.cause = options?.cause;
    this.name = "ProviderTransportError";
  }
}

export class ProviderProtocolError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: ErrorOptions) {
    super(message);
    this.cause = options?.cause;
    this.name = "ProviderProtocolError";
  }
}

export async function providerHttpErrorFromResponse(
  providerName: string,
  response: Response,
): Promise<ProviderHttpError> {
  let body = "";
  let cause: unknown;
  try {
    body = await response.text();
  } catch (error) {
    if (isAbortError(error)) throw error;
    cause = error;
  }
  return new ProviderHttpError(
    `${providerName} ${response.status}: ${body}`,
    response.status,
    body,
    parseRetryAfter(response.headers.get("retry-after")),
    { cause },
  );
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

export const MANAGED_RELAY_ADMISSION_CODES = new Set([
  "llm_owner_busy",
  "llm_queue_full",
  "llm_queue_timeout",
  "llm_overloaded",
]);

const PERMANENT_QUOTA_CODES = new Set([
  "arrearage",
  "balance_not_enough",
  "billing_hard_limit_reached",
  "insufficient_balance",
  "insufficient_quota",
  "quota_exceeded",
]);

/** Returns true only for provider errors where a repeated request can succeed. */
export function isRetryableProviderFailure(error: unknown): boolean {
  if (error instanceof ProviderTransportError) return true;
  if (!(error instanceof ProviderHttpError)) return false;

  const relayCode = (error as { code?: unknown }).code;
  if (typeof relayCode === "string" && MANAGED_RELAY_ADMISSION_CODES.has(relayCode)) {
    return false;
  }

  // Managed relay quota/license rejections require user action rather than a
  // retry. Other relay 429s (for example rate limiting) remain transient.
  if ((error as { upsell?: unknown }).upsell === true) return false;
  if (error.status === 429 && hasPermanentQuotaSignal(error.body)) return false;

  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function hasPermanentQuotaSignal(body: string): boolean {
  const normalizedCodes: string[] = [];
  try {
    const parsed = JSON.parse(body) as {
      code?: unknown;
      type?: unknown;
      error?: unknown;
    };
    appendCode(normalizedCodes, parsed.code);
    appendCode(normalizedCodes, parsed.type);
    if (typeof parsed.error === "string") {
      appendCode(normalizedCodes, parsed.error);
    } else if (parsed.error && typeof parsed.error === "object") {
      const nested = parsed.error as { code?: unknown; type?: unknown };
      appendCode(normalizedCodes, nested.code);
      appendCode(normalizedCodes, nested.type);
    }
  } catch {
    // Some providers return a plain-text billing rejection.
  }
  if (normalizedCodes.some((code) => PERMANENT_QUOTA_CODES.has(code))) return true;

  const text = body.toLowerCase();
  return text.includes("insufficient balance")
    || text.includes("account balance is insufficient")
    || text.includes("余额不足");
}

function appendCode(target: string[], value: unknown): void {
  if (typeof value !== "string") return;
  target.push(value.trim().toLowerCase().replace(/[\s-]+/g, "_"));
}
