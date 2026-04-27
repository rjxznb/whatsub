import type { Settings } from "../../types/settings";
import type { Provider } from "./types";
import { createOpenAICompatibleProvider } from "./openaiCompatible";
import { createClaudeProvider } from "./claude";
import { createGeminiProvider } from "./gemini";

export function getProvider(settings: Settings): Provider {
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
