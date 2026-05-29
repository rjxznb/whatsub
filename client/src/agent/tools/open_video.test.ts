import { describe, it, expect, vi, afterEach } from "vitest";
import { openVideoTool } from "./open_video";
import { setNavigator } from "../nav";

const ctx = { signal: new AbortController().signal };

afterEach(() => {
  setNavigator(null);
});

describe("open_video tool", () => {
  it("riskTier is LOW", () => {
    expect(openVideoTool.riskTier).toBe("LOW");
  });

  it("availableOn returns true on any page", () => {
    expect(openVideoTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(openVideoTool.availableOn({ pathname: "/player/abc" })).toBe(true);
  });

  it("happy path: navigates to /player/:id and returns navigatedTo", async () => {
    const spy = vi.fn();
    setNavigator(spy);
    const r = await openVideoTool.execute({ videoId: "vid_abc" }, ctx);
    expect(spy).toHaveBeenCalledWith("/player/vid_abc");
    expect(r).toEqual({ ok: true, navigatedTo: "/player/vid_abc" });
  });

  it("appends ?t= when atSec > 0 (floored)", async () => {
    const spy = vi.fn();
    setNavigator(spy);
    const r = await openVideoTool.execute({ videoId: "vid_abc", atSec: 42.9 }, ctx);
    expect(spy).toHaveBeenCalledWith("/player/vid_abc?t=42");
    expect(r.navigatedTo).toBe("/player/vid_abc?t=42");
  });

  it("ignores atSec when 0 or missing", async () => {
    const spy = vi.fn();
    setNavigator(spy);
    await openVideoTool.execute({ videoId: "vid_abc", atSec: 0 }, ctx);
    expect(spy).toHaveBeenCalledWith("/player/vid_abc");
  });
});
