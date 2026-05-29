import { describe, it, expect } from "vitest";
import { estimateCost } from "./cost";

describe("estimateCost", () => {
  it("computes deepseek-chat 800 chars and rounds up to ¥0.01", () => {
    // 800 × 0.002 / 1000 = 0.0016 → ceil to 0.01
    expect(estimateCost("deepseek", "deepseek-chat", 800)).toBe(0.01);
  });

  it("rounds tiny totals UP to ¥0.01 minimum", () => {
    // 50 × 0.002 / 1000 = 0.0001 → ceil to 0.01
    expect(estimateCost("deepseek", "deepseek-chat", 50)).toBe(0.01);
  });

  it("scales linearly: 50,000 chars on deepseek-chat ≈ ¥0.10", () => {
    // 50000 × 0.002 / 1000 = 0.10
    expect(estimateCost("deepseek", "deepseek-chat", 50000)).toBe(0.10);
  });

  it("returns null for unknown vendor/model", () => {
    expect(estimateCost("xai", "grok-fake", 1000)).toBeNull();
  });

  it("is case-insensitive on vendor and model name", () => {
    expect(estimateCost("DeepSeek", "DeepSeek-Chat", 1000)).toBe(0.01);
  });

  it("zero chars still rounds up to ¥0.01 (we never advertise free)", () => {
    expect(estimateCost("deepseek", "deepseek-chat", 0)).toBe(0);
  });
});
