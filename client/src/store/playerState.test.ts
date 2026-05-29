import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePlayerState } from "./playerState";

beforeEach(() => {
  usePlayerState.getState().clear();
});

describe("usePlayerState", () => {
  it("starts all-null", () => {
    expect(usePlayerState.getState()).toMatchObject({
      videoId: null,
      currentIdx: null,
      currentTime: null,
      videoTitle: null,
    });
  });
  it("setActive populates videoId + title", () => {
    usePlayerState.getState().setActive({ videoId: "v1", videoTitle: "T" });
    expect(usePlayerState.getState().videoId).toBe("v1");
    expect(usePlayerState.getState().videoTitle).toBe("T");
  });
  it("setCue updates idx + time", () => {
    usePlayerState.getState().setActive({ videoId: "v1", videoTitle: "T" });
    usePlayerState.getState().setCue({ currentIdx: 5, currentTime: 12.3 });
    expect(usePlayerState.getState().currentIdx).toBe(5);
    expect(usePlayerState.getState().currentTime).toBe(12.3);
  });
  it("clear resets all", () => {
    usePlayerState.getState().setActive({ videoId: "v1", videoTitle: "T" });
    usePlayerState.getState().setCue({ currentIdx: 5, currentTime: 12.3 });
    usePlayerState.getState().clear();
    expect(usePlayerState.getState().videoId).toBeNull();
  });
  it("setSeekHandler stores the fn; null clears it", () => {
    const fn = vi.fn();
    usePlayerState.getState().setSeekHandler(fn);
    expect(usePlayerState.getState().seekHandler).toBe(fn);
    usePlayerState.getState().setSeekHandler(null);
    expect(usePlayerState.getState().seekHandler).toBeNull();
  });
  it("clear also nulls seekHandler", () => {
    usePlayerState.getState().setSeekHandler(vi.fn());
    usePlayerState.getState().clear();
    expect(usePlayerState.getState().seekHandler).toBeNull();
  });
});
