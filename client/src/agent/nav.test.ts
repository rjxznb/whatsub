import { describe, it, expect, vi, afterEach } from "vitest";
import { setNavigator, navigate } from "./nav";

afterEach(() => {
  setNavigator(null);
  vi.restoreAllMocks();
});

describe("agent/nav", () => {
  it("navigate calls the registered fn when set", () => {
    const spy = vi.fn();
    setNavigator(spy);
    navigate("/library");
    expect(spy).toHaveBeenCalledWith("/library");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("navigate warns and does not throw when no fn is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => navigate("/library")).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe("/library");
  });
});
