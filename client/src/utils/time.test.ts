import { describe, it, expect } from "vitest";
import { formatTime } from "./time";

describe("formatTime", () => {
  it("formats seconds to mm:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(5)).toBe("0:05");
    expect(formatTime(65)).toBe("1:05");
    expect(formatTime(125.7)).toBe("2:05");
  });

  it("includes hours when >=3600", () => {
    expect(formatTime(3661)).toBe("1:01:01");
  });
});
