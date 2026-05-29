import { describe, it, expect, vi, beforeEach } from "vitest";
import { seekToTimeTool } from "./seek_to_time";
import { usePlayerState } from "../../store/playerState";

const ctx = { signal: new AbortController().signal };

beforeEach(() => {
  usePlayerState.getState().clear();
});

describe("seek_to_time tool", () => {
  it("riskTier is LOW", () => {
    expect(seekToTimeTool.riskTier).toBe("LOW");
  });

  it("availableOn is true on /player/* and false elsewhere", () => {
    expect(seekToTimeTool.availableOn({ pathname: "/player/abc" })).toBe(true);
    expect(seekToTimeTool.availableOn({ pathname: "/library" })).toBe(false);
    expect(seekToTimeTool.availableOn({ pathname: "/" })).toBe(false);
  });

  it("happy path: calls registered seekHandler and returns sec", async () => {
    const handler = vi.fn();
    usePlayerState.getState().setSeekHandler(handler);
    const r = await seekToTimeTool.execute({ sec: 12.5 }, ctx);
    expect(handler).toHaveBeenCalledWith(12.5);
    expect(r).toEqual({ ok: true, sec: 12.5 });
  });

  it("clamps negative sec to 0", async () => {
    const handler = vi.fn();
    usePlayerState.getState().setSeekHandler(handler);
    const r = await seekToTimeTool.execute({ sec: -5 }, ctx);
    expect(handler).toHaveBeenCalledWith(0);
    expect(r.sec).toBe(0);
  });

  it("throws 'not on player page' when seekHandler is null", async () => {
    await expect(seekToTimeTool.execute({ sec: 1 }, ctx)).rejects.toThrow(
      "not on player page",
    );
  });
});
