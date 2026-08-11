import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginManagedRelayWait, useManagedQueueStatus } from "./managedQueueStatus";

describe("managed relay queue status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useManagedQueueStatus.setState({ waitingCount: 0 });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shows a slow request only after two seconds and cleans up once", () => {
    const finish = beginManagedRelayWait();

    vi.advanceTimersByTime(1_999);
    expect(useManagedQueueStatus.getState().waitingCount).toBe(0);
    vi.advanceTimersByTime(1);
    expect(useManagedQueueStatus.getState().waitingCount).toBe(1);

    finish();
    finish();
    expect(useManagedQueueStatus.getState().waitingCount).toBe(0);
  });

  it("never flashes for a response that finishes before the delay", () => {
    const finish = beginManagedRelayWait();
    finish();

    vi.advanceTimersByTime(2_000);
    expect(useManagedQueueStatus.getState().waitingCount).toBe(0);
  });

  it("reference-counts concurrent slow requests independently", () => {
    const finishFirst = beginManagedRelayWait();
    const finishSecond = beginManagedRelayWait();

    vi.advanceTimersByTime(2_000);
    expect(useManagedQueueStatus.getState().waitingCount).toBe(2);
    finishFirst();
    expect(useManagedQueueStatus.getState().waitingCount).toBe(1);
    finishSecond();
    expect(useManagedQueueStatus.getState().waitingCount).toBe(0);
  });
});
