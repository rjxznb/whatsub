import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MONTHLY_PRICE_TEXT,
  SUBSCRIPTION_PRICING,
  YEARLY_PRICE_TEXT,
} from "./subscriptionPricing";

function runtimeSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return runtimeSourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("subscription pricing", () => {
  it("exposes the current CNY prices", () => {
    expect(SUBSCRIPTION_PRICING).toEqual({
      currency: "CNY",
      monthly: 38,
      yearly: 348,
    });
    expect(MONTHLY_PRICE_TEXT).toBe("¥38");
    expect(YEARLY_PRICE_TEXT).toBe("¥348");
    expect(MONTHLY_PRICE_TEXT.codePointAt(0)).toBe(0x00a5);
    expect(YEARLY_PRICE_TEXT.codePointAt(0)).toBe(0x00a5);
  });

  it("contains no legacy subscription-price literals in runtime source", () => {
    const root = join(process.cwd(), "src");
    const legacy = ["¥12/月", "¥22", "¥168"];
    const offenders = runtimeSourceFiles(root).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return legacy.filter((value) => text.includes(value)).map((value) => ({
        file: relative(process.cwd(), file),
        value,
      }));
    });
    expect(offenders).toEqual([]);
  });
});
