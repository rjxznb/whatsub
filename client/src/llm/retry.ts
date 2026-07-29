export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: readonly number[];
}

export interface RetryEvent {
  failedAttempt: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  policy: RetryPolicy;
  isRetryable: (error: unknown) => boolean;
  retryAfterMs?: (error: unknown) => number | null;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onRetry?: (event: RetryEvent) => void;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function retryOperation<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  for (let attempt = 1; attempt <= options.policy.maxAttempts; attempt++) {
    if (options.signal?.aborted) throw abortError();
    try {
      return await operation(attempt);
    } catch (error) {
      if (
        options.signal?.aborted ||
        !options.isRetryable(error) ||
        attempt === options.policy.maxAttempts
      ) {
        throw error;
      }
      const base = options.policy.backoffMs[attempt - 1]
        ?? options.policy.backoffMs[options.policy.backoffMs.length - 1]
        ?? 0;
      const delayMs = Math.max(base, options.retryAfterMs?.(error) ?? retryAfterMs(error) ?? 0);
      options.onRetry?.({
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts: options.policy.maxAttempts,
        delayMs,
        error,
      });
      await (options.sleep ?? abortableDelay)(delayMs, options.signal);
    }
  }
  throw new Error("unreachable retry state");
}

function retryAfterMs(error: unknown): number | null {
  return typeof (error as { retryAfterMs?: unknown })?.retryAfterMs === "number"
    ? (error as { retryAfterMs: number }).retryAfterMs
    : null;
}
