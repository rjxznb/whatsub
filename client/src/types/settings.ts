import type { Scene, Country } from "../llm/types";

export type LlmProvider = "openai-compatible" | "claude" | "gemini";

export type WhisperModelSize = "tiny" | "base" | "small" | "medium" | "large-v3";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ClaudeConfig {
  apiKey: string;
  model: string;
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
}

export interface Settings {
  llmProvider: LlmProvider;
  openaiCompatible: OpenAICompatibleConfig;
  claude: ClaudeConfig;
  gemini: GeminiConfig;
  whisperModel: WhisperModelSize;
  defaultScene: Scene;
  defaultCountry: Country;
}

export const DEFAULT_SETTINGS: Settings = {
  llmProvider: "openai-compatible",
  openaiCompatible: { baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-chat" },
  claude: { apiKey: "", model: "claude-sonnet-4-6" },
  gemini: { apiKey: "", model: "gemini-2.5-pro" },
  whisperModel: "small",
  defaultScene: "social",
  defaultCountry: "US",
};
