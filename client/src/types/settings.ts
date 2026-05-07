export type LlmProvider = "openai-compatible" | "claude" | "gemini";

export type WhisperModelSize = "tiny" | "base" | "small" | "medium" | "large-v3";

/** Translation register applied to per-cue translations + summary phrases.
 *  Selected per-import in ImportModal and stored on the library entry.
 *  Legacy entries without a stored choice fall back to "colloquial". */
export type TranslationStyle =
  | "colloquial"  // 日常聊天 — natural conversational Chinese (default)
  | "playful"     // 俏皮活泼 — vivid, expressive, energetic
  | "cinematic"   // 影视字幕 — short, dramatic, screen-friendly
  | "formal"      // 正式书面 — newspaper / textbook register
  | "literary";   // 文艺抒情 — poetic, refined, elegant

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
  /** Path to a Netscape-format cookies.txt file. When set, yt-dlp uses --cookies <file>
   *  to bypass age/login walls and bot-detection prompts. Empty = no cookies. */
  cookiesFile: string;
  /** Last detected whisper compute backend, persisted across launches.
   *  Format: "Vulkan / NVIDIA GeForce RTX 4090" | "CUDA / ..." | "CPU".
   *  Empty until the first transcribe completes. */
  whisperBackend?: string;
  /** Per-vendor api-key + model stash. Lets DeepSeek / Kimi / 智谱 / Qwen /
   *  MiniMax etc. each remember their own credentials so switching vendors
   *  no longer wipes the previous one's key. The currently-active vendor's
   *  key+model also live in the protocol slots above (openaiCompatible /
   *  claude / gemini) — those remain the runtime source of truth; this map
   *  is the per-vendor archive. Populated lazily; missing entry = no saved
   *  credentials for that vendor (input fields show empty). */
  vendorKeys?: Record<string, { apiKey: string; model: string }>;
}

export const DEFAULT_SETTINGS: Settings = {
  llmProvider: "openai-compatible",
  vendorId: "deepseek",
  openaiCompatible: { baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-chat" },
  claude: { apiKey: "", model: "claude-sonnet-4-6" },
  gemini: { apiKey: "", model: "gemini-2.5-pro" },
  whisperModel: "small",
  libraryDir: "",
  cookiesFile: "",
  whisperBackend: "",
  vendorKeys: {},
};
