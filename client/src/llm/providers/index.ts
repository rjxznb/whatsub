import type { Settings } from "../../types/settings";
import type { Provider } from "./types";
import { createOpenAICompatibleProvider } from "./openaiCompatible";
import { createClaudeProvider } from "./claude";
import { createGeminiProvider } from "./gemini";
import { assertLlmProviderAllowed } from "../entitlementPolicy";
import { useAuth, type LlmEntitlements } from "../../store/auth";

export function getProvider(settings: Settings, entitlements?: LlmEntitlements | null): Provider {
  assertLlmProviderAllowed(settings, entitlements === undefined ? useAuth.getState().llmEntitlements : entitlements);
  switch (settings.llmProvider) {
    case "openai-compatible":
      return createOpenAICompatibleProvider(settings);
    case "claude":
      return createClaudeProvider(settings);
    case "gemini":
      return createGeminiProvider(settings);
  }
}

export type { Provider } from "./types";
