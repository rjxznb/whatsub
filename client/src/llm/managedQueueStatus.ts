import { create } from "zustand";

export interface ManagedQueueState {
  waitingCount: number;
}

export const useManagedQueueStatus = create<ManagedQueueState>(() => ({
  waitingCount: 0,
}));

/**
 * Starts a delayed, reference-counted queue indicator for one managed relay
 * request. Fast requests never become visible; the returned cleanup is safe to
 * call from multiple completion/error paths.
 */
export function beginManagedRelayWait(delayMs = 2_000): () => void {
  let finished = false;
  let visible = false;
  const timer = setTimeout(() => {
    if (finished) return;
    visible = true;
    useManagedQueueStatus.setState((state) => ({
      waitingCount: state.waitingCount + 1,
    }));
  }, delayMs);

  return () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (!visible) return;
    useManagedQueueStatus.setState((state) => ({
      waitingCount: Math.max(0, state.waitingCount - 1),
    }));
  };
}
