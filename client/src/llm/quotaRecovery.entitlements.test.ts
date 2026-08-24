import { describe, expect, it } from "vitest";
import { quotaRecoveryActions } from "./quotaRecovery";

const details = { used: 1, limit: 1, periodResetAt: Date.now() + 1_000, committedCueOffset: 4, totalCues: 10 };
const entitlement = (tier: "free" | "buyout" | "pro" | "buyout_pro") => ({
  tier,
  managedRelay: tier !== "buyout",
  byok: tier === "buyout" || tier === "buyout_pro",
  tokenTopups: tier === "pro" || tier === "buyout_pro",
} as const);

describe("quota recovery entitlement actions", () => {
  it("offers only subscription for free accounts", () => {
    expect(quotaRecoveryActions(details, entitlement("free")).map((item) => item.kind)).toEqual(["subscribe"]);
  });
  it("offers topup and wait for Pro", () => {
    expect(quotaRecoveryActions(details, entitlement("pro")).map((item) => item.kind)).toEqual(["topup", "wait"]);
  });
  it("offers both topup and BYOK for buyout plus Pro", () => {
    expect(quotaRecoveryActions(details, entitlement("buyout_pro")).map((item) => item.kind)).toEqual(["topup", "byok", "wait"]);
  });
});
