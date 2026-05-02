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
  /** Vendor preset id (e.g. "deepseek", "openai", "claude", "kimi", "custom").
   *  Drives the UI dropdown and auto-fills protocol + baseUrl. Optional for
   *  backward compat with old settings.json files written before this field
   *  existed — those get inferred from llmProvider + openaiCompatible.baseUrl. */
  vendorId?: string;
  openaiCompatible: OpenAICompatibleConfig;
  claude: ClaudeConfig;
  gemini: GeminiConfig;
  whisperModel: WhisperModelSize;
  /** Custom directory for video + analysis files. Empty string = use default (%APPDATA%/whatsub/library). */
  libraryDir: string;
  /** Custom directory for Whisper model files. Empty string = use default (%APPDATA%/whatsub/models). */
  modelsDir: string;
  /** Path to a Netscape-format cookies.txt file. When set, yt-dlp uses --cookies <file>
   *  to bypass age/login walls and bot-detection prompts. Empty = no cookies. */
  cookiesFile: string;
  /** Last detected whisper compute backend, persisted across launches.
   *  Format: "Vulkan / NVIDIA GeForce RTX 4090" | "CUDA / ..." | "CPU".
   *  Empty until the first transcribe completes. */
  whisperBackend?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  llmProvider: "openai-compatible",
  vendorId: "deepseek",
  openaiCompatible: { baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-chat" },
  claude: { apiKey: "", model: "claude-sonnet-4-6" },
  gemini: { apiKey: "", model: "gemini-2.5-pro" },
  whisperModel: "small",
  libraryDir: "",
  modelsDir: "",
  cookiesFile: "",
  whisperBackend: "",
};
