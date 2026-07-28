import { describe, expect, it } from "vitest";
import {
  MONTHLY_PRICE_TEXT,
  SUBSCRIPTION_PRICING,
  YEARLY_PRICE_TEXT,
} from "./subscriptionPricing";

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
});
