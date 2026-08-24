import type { Settings } from "../types/settings";
import type { LlmEntitlements } from "../store/auth";

export type LlmMode = "managedRelay" | "byok";

export class LlmEntitlementError extends Error {
  readonly code = "byok_not_entitled";
  constructor() {
    super("当前账号没有使用自己的 API Key 的权限");
    this.name = "LlmEntitlementError";
  }
}

export function allowedLlmModes(entitlements: LlmEntitlements | null | undefined): LlmMode[] {
  if (!entitlements) return ["managedRelay"];
  const modes: LlmMode[] = [];
  if (entitlements.managedRelay) modes.push("managedRelay");
  if (entitlements.byok) modes.push("byok");
  return modes;
}

export function isManagedSettings(settings: Pick<Settings, "vendorId">): boolean {
  return settings.vendorId === "whatsub-managed";
}

export function assertLlmProviderAllowed(
  settings: Pick<Settings, "vendorId">,
  entitlements: LlmEntitlements | null | undefined,
): void {
  const requested: LlmMode = isManagedSettings(settings) ? "managedRelay" : "byok";
  if (!allowedLlmModes(entitlements).includes(requested)) throw new LlmEntitlementError();
}

export function coerceLlmSettings(settings: Settings, entitlements: LlmEntitlements | null | undefined): Settings {
  const allowed = allowedLlmModes(entitlements);
  if (allowed.length === 0 || allowed.includes(isManagedSettings(settings) ? "managedRelay" : "byok")) return settings;
  if (allowed.includes("managedRelay")) {
    return { ...settings, vendorId: "whatsub-managed", llmProvider: "openai-compatible" };
  }
  // Buyout-only accounts cannot use the managed relay. Preserve all saved
  // credentials while selecting the normal BYOK vendor path.
  return { ...settings, vendorId: settings.vendorId === "whatsub-managed" ? "deepseek" : settings.vendorId, llmProvider: "openai-compatible" };
}
