import { describe, it, expect, vi, afterEach } from "vitest";
import { openPageTool } from "./open_page";
import { setNavigator } from "../nav";

const ctx = { signal: new AbortController().signal };

afterEach(() => {
  setNavigator(null);
});

describe("open_page tool", () => {
  it("riskTier is LOW", () => {
    expect(openPageTool.riskTier).toBe("LOW");
  });

  it("availableOn returns true on any page", () => {
    expect(openPageTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(openPageTool.availableOn({ pathname: "/player/abc" })).toBe(true);
    expect(openPageTool.availableOn({ pathname: "/settings" })).toBe(true);
  });

  it("happy path: navigates to /<page> for each target", async () => {
    const spy = vi.fn();
    setNavigator(spy);
    for (const page of ["library", "vocab", "corpus", "settings"] as const) {
      const r = await openPageTool.execute({ page }, ctx);
      expect(spy).toHaveBeenLastCalledWith(`/${page}`);
      expect(r).toEqual({ ok: true, navigatedTo: `/${page}` });
    }
    expect(spy).toHaveBeenCalledTimes(4);
  });
});
