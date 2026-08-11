import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderHttpError,
  ProviderProtocolError,
  ProviderTransportError,
  isRetryableProviderFailure,
} from "./providers/errors";
import { retryOperation } from "./retry";
import { RelayError } from "./providers/relayErrors";

const policy = { maxAttempts: 4, backoffMs: [500, 1500, 3500] };

describe("retryOperation", () => {
  afterEach(() => vi.useRealTimers());

  it("retries a transient transport failure through the fourth attempt with exact delays", async () => {
    const error = new ProviderTransportError("offline", "send");
    const operation = vi.fn<(attempt: number) => Promise<never>>(async () => { throw error; });
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => undefined);

    await expect(retryOperation(operation, { policy, isRetryable: isRetryableProviderFailure, sleep }))
      .rejects.toBe(error);

    expect(operation).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1500, 3500]);
  });

  it("returns the successful third attempt after two transient failures", async () => {
    const error = new ProviderTransportError("offline", "read");
    const operation = vi.fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce("complete");
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => undefined);

    await expect(retryOperation(operation, { policy, isRetryable: isRetryableProviderFailure, sleep }))
      .resolves.toBe("complete");

    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1500]);
  });

  it("uses the longer Retry-After delay for transient HTTP 429 failures", async () => {
    const error = new ProviderHttpError("rate limited", 429, "", 9_000);
    const operation = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce("complete");
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => undefined);

    await expect(retryOperation(operation, { policy, isRetryable: isRetryableProviderFailure, sleep }))
      .resolves.toBe("complete");

    expect(sleep).toHaveBeenCalledWith(9_000, undefined);
  });

  it("does not retry authentication, relay quota, or protocol failures", async () => {
    const failures = [
      new ProviderHttpError("unauthorized", 401, "", null),
      new RelayError({ code: "quota_exceeded", message: "quota", upsell: true }, 429),
      new ProviderProtocolError("malformed response"),
    ];

    for (const error of failures) {
      const operation = vi.fn<(attempt: number) => Promise<never>>(async () => { throw error; });
      const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => undefined);
      await expect(retryOperation(operation, { policy, isRetryable: isRetryableProviderFailure, sleep }))
        .rejects.toBe(error);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it.each([
    "llm_owner_busy",
    "llm_queue_full",
    "llm_queue_timeout",
    "llm_overloaded",
  ])("does not start another 30-second wait for admission failure %s", async (code) => {
    const error = new RelayError({ code, message: code, upsell: false }, 429, "", 3_000);
    const operation = vi.fn<(attempt: number) => Promise<never>>(async () => { throw error; });
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => undefined);

    await expect(retryOperation(operation, { policy, isRetryable: isRetryableProviderFailure, sleep }))
      .rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("aborts a retry backoff without another attempt or a lingering timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const error = new ProviderTransportError("offline", "send");
    const operation = vi.fn<(attempt: number) => Promise<never>>(async () => { throw error; });

    const result = retryOperation(operation, {
      policy,
      isRetryable: isRetryableProviderFailure,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
