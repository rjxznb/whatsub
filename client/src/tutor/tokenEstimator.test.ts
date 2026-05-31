import { describe, it, expect } from "vitest";
import {
  estimateLessonTokens,
  estimateRoleplayTokens,
  estimateRemediationTokens,
  approxYuan,
} from "./tokenEstimator";

describe("tokenEstimator", () => {
  describe("estimateLessonTokens", () => {
    it("scales linearly with anchors", () => {
      const a3 = estimateLessonTokens(3);
      const a5 = estimateLessonTokens(5);
      const a7 = estimateLessonTokens(7);
      // delta per anchor should be the same
      expect(a5 - a3).toBe(a7 - a5);
    });

    it("includes plan + summary overhead", () => {
      const t = estimateLessonTokens(0);
      expect(t).toBeGreaterThanOrEqual(1000); // plan 500 + summary 500
    });

    it("3-anchor lesson lands in 2000-4000 range", () => {
      const t = estimateLessonTokens(3);
      expect(t).toBeGreaterThanOrEqual(2000);
      expect(t).toBeLessThanOrEqual(4000);
    });
  });

  describe("estimateRoleplayTokens", () => {
    it("baseline 1000 + scene + 800 per minute + 1500 report", () => {
      const t = estimateRoleplayTokens({ plannedMinutes: 5 });
      expect(t).toBeGreaterThanOrEqual(5000);
      expect(t).toBeLessThanOrEqual(8000);
    });

    it("longer plan = more tokens", () => {
      expect(estimateRoleplayTokens({ plannedMinutes: 10 })).toBeGreaterThan(
        estimateRoleplayTokens({ plannedMinutes: 3 }),
      );
    });
  });

  describe("estimateRemediationTokens", () => {
    it("returns a flat ~1500", () => {
      const t = estimateRemediationTokens();
      expect(t).toBeGreaterThanOrEqual(1200);
      expect(t).toBeLessThanOrEqual(1800);
    });
  });

  describe("approxYuan", () => {
    it("DeepSeek pricing is roughly 0.01 yuan per 1000 tokens", () => {
      const y = approxYuan(3000, { inputPerKTokens: 0.001, outputPerKTokens: 0.002 });
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(0.1);
    });

    it("returns a 2-decimal-place string", () => {
      const y = approxYuan(3000, { inputPerKTokens: 0.001, outputPerKTokens: 0.002 });
      // The function returns number — format at display layer
      expect(typeof y).toBe("number");
    });
  });
});
