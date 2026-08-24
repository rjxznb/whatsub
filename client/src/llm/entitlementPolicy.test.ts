import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../types/settings";
import {
  allowedLlmModes,
  assertLlmProviderAllowed,
  coerceLlmSettings,
  LlmEntitlementError,
} from "./entitlementPolicy";

const settings = (vendorId: string): Settings => ({
  ...DEFAULT_SETTINGS,
  vendorId,
  openaiCompatible: { ...DEFAULT_SETTINGS.openaiCompatible, apiKey: "keep-me" },
});

const entitlement = (tier: "free" | "buyout" | "pro" | "buyout_pro") => ({
  tier,
  managedRelay: tier === "free" || tier === "pro" || tier === "buyout_pro",
  byok: tier === "buyout" || tier === "buyout_pro",
  tokenTopups: tier === "pro" || tier === "buyout_pro",
} as const);

describe("desktop LLM entitlement policy", () => {
  it.each([
    ["free", ["managedRelay"]],
    ["buyout", ["byok"]],
    ["pro", ["managedRelay"]],
    ["buyout_pro", ["managedRelay", "byok"]],
  ] as const)("%s exposes only entitled modes", (tier, expected) => {
    expect(allowedLlmModes(entitlement(tier))).toEqual(expected);
  });

  it("coerces a persisted BYOK setting to managed without deleting its key", () => {
    const result = coerceLlmSettings(settings("deepseek"), entitlement("pro"));
    expect(result.vendorId).toBe("whatsub-managed");
    expect(result.openaiCompatible.apiKey).toBe("keep-me");
  });

  it("blocks a direct provider call for non-BYOK accounts", () => {
    expect(() => assertLlmProviderAllowed(settings("deepseek"), entitlement("free")))
      .toThrowError(LlmEntitlementError);
  });

  it("fails closed for BYOK until server entitlements are known", () => {
    expect(() => assertLlmProviderAllowed(settings("deepseek"), null))
      .toThrowError(LlmEntitlementError);
  });

  it("coerces persisted BYOK to managed while entitlements are unknown", () => {
    const result = coerceLlmSettings(settings("deepseek"), null);
    expect(result.vendorId).toBe("whatsub-managed");
    expect(result.openaiCompatible.apiKey).toBe("keep-me");
  });
});
