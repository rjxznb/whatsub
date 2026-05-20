import { describe, it, expect } from "vitest";
import { overlapRatio, resolveDropMode } from "./overlap";

function rect(left: number, top: number, w: number, h: number): DOMRect {
  return {
    left, top,
    right: left + w, bottom: top + h,
    x: left, y: top,
    width: w, height: h,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("overlapRatio", () => {
  it("returns 0 when no overlap", () => {
    expect(overlapRatio(rect(0, 0, 100, 100), rect(200, 0, 100, 100))).toBe(0);
  });

  it("returns 1 when fully covered", () => {
    expect(overlapRatio(rect(0, 0, 100, 100), rect(0, 0, 100, 100))).toBe(1);
  });

  it("returns 0.25 at 50% x and 50% y partial overlap", () => {
    expect(overlapRatio(rect(0, 0, 100, 100), rect(50, 50, 100, 100))).toBe(0.25);
  });

  it("normalizes by dragged area, not target", () => {
    expect(overlapRatio(rect(0, 0, 50, 50), rect(0, 0, 100, 100))).toBe(1);
  });

  it("returns 0 when drag area is 0", () => {
    expect(overlapRatio(rect(0, 0, 0, 0), rect(0, 0, 100, 100))).toBe(0);
  });
});

describe("resolveDropMode", () => {
  it("any pair with overlap < 0.9 is reorder", () => {
    expect(resolveDropMode("video", "video", 0.89)).toBe("reorder");
    expect(resolveDropMode("video", "folder", 0.5)).toBe("reorder");
    expect(resolveDropMode("folder", "video", 0.95)).toBe("reorder");
    expect(resolveDropMode("folder", "folder", 0.95)).toBe("reorder");
  });

  it("video → video at ≥ 0.9 is merge", () => {
    expect(resolveDropMode("video", "video", 0.9)).toBe("merge");
    expect(resolveDropMode("video", "video", 1.0)).toBe("merge");
  });

  it("video → folder at ≥ 0.9 is add", () => {
    expect(resolveDropMode("video", "folder", 0.9)).toBe("add");
  });

  it("folder source at high overlap falls back to reorder", () => {
    expect(resolveDropMode("folder", "video", 0.95)).toBe("reorder");
    expect(resolveDropMode("folder", "folder", 0.95)).toBe("reorder");
  });
});
