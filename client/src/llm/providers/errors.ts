type ErrorOptions = { cause?: unknown };

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
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

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

/** Returns true only for provider errors where a repeated request can succeed. */
export function isRetryableProviderFailure(error: unknown): boolean {
  if (error instanceof ProviderTransportError) return true;
  if (!(error instanceof ProviderHttpError)) return false;

  // Managed relay quota/license rejections require user action rather than a
  // retry. Other relay 429s (for example rate limiting) remain transient.
  if ((error as { upsell?: unknown }).upsell === true) return false;

  return error.status === 408 || error.status === 429 || error.status >= 500;
}
