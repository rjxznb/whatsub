export type LlmProvider = "openai-compatible" | "claude" | "gemini";

export type WhisperModelSize = "tiny" | "base" | "small" | "medium" | "large-v3";

/** Translation register applied to per-cue translations + summary phrases.
 *  Selected per-import in ImportModal and stored on the library entry.
 *  Legacy entries without a stored choice fall back to "colloquial". */
export type TranslationStyle =
  | "formal"      // 正式 — newspaper / textbook register (slider: left)
  | "neutral"     // 中性 — between formal and casual (slider: middle)
  | "colloquial"  // 口语 — natural conversational Chinese (slider: right)
  // Legacy styles — no longer reachable from the slider UI, kept so that
  // library entries written by older builds keep their LLM prompt mapping.
  | "playful"
  | "cinematic"
  | "literary";

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

/** One Vulkan compute device as reported by whisper-cli. `discrete` is derived
 *  from the `uma:` flag (integrated GPUs report `uma: 1`). */
export interface WhisperGpu {
  index: number;
  name: string;
  discrete: boolean;
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
  /** How yt-dlp should source YouTube cookies. The legacy default was
   *  always-file (read from `cookiesFile`); now we also support an
   *  in-app login flow that opens a Tauri WebviewWindow, has the user
   *  log into YouTube, and persists the cookies to <app_data>/yt-cookies.txt.
   *
   *  - "none"    no cookies (default; works for most non-flagged videos)
   *  - "in-app"  use cookies extracted from the in-app login window
   *  - "file"    use the user-provided file at `cookiesFile` (legacy) */
  cookieSource?: "none" | "in-app" | "file";
  /** Path to a Netscape-format cookies.txt file. Only consulted when
   *  cookieSource === "file". Empty when not set. */
  cookiesFile: string;
  /** Unix epoch ms of the last successful in-app YouTube login. Drives
   *  the "上次登录: X 天前" status line in Settings. Undefined = never. */
  inAppLoginAt?: number;
  /** Last detected whisper compute backend, persisted across launches.
   *  Format: "Vulkan / NVIDIA GeForce RTX 4090" | "CUDA / ..." | "CPU".
   *  Empty until the first transcribe completes. */
  whisperBackend?: string;
  /** Whether transcription should prefer the discrete GPU on a hybrid laptop.
   *  Default true. When on, the app pins the detected discrete card via
   *  GGML_VK_VISIBLE_DEVICES so whisper.cpp's Vulkan backend doesn't default to
   *  the (slower) integrated GPU at device 0. Turn off to use whisper's default
   *  device selection. */
  preferDiscreteGpu?: boolean;
  /** Vulkan device inventory detected on the last *unfiltered* transcribe run,
   *  persisted so Settings can list the cards and the next run can pin the
   *  discrete one. Populated by the GpuDevices pipeline event. */
  whisperGpus?: WhisperGpu[];
  /** Per-vendor api-key + model stash. Lets DeepSeek / Kimi / 智谱 / Qwen /
   *  MiniMax etc. each remember their own credentials so switching vendors
   *  no longer wipes the previous one's key. The currently-active vendor's
   *  key+model also live in the protocol slots above (openaiCompatible /
   *  claude / gemini) — those remain the runtime source of truth; this map
   *  is the per-vendor archive. Populated lazily; missing entry = no saved
   *  credentials for that vendor (input fields show empty). */
  vendorKeys?: Record<string, { apiKey: string; model: string }>;
  /** Whether the local-HTTP bridge for the browser plugin should bind a
   *  port at app startup. Default true to preserve existing plugin users'
   *  flow. Users without the plugin can flip this off so we don't claim
   *  a port + a thread for nothing. Takes effect on next launch (actix
   *  System spawns once in setup() and runs forever). */
  bridgeEnabled?: boolean;
  /** Caption (CaptionOverlay) font hex color. Default "#FFFFFF". */
  captionFontColor?: string;
  /** Caption font size scale: 0.75 / 1 / 1.25 / 1.5. Default 1. */
  captionFontScale?: number;
  /** Caption text opacity 0–1. Default 1. */
  captionFontOpacity?: number;
  /** Caption background hex color (no alpha). Default "#000000". */
  captionBackgroundColor?: string;
  /** Caption background opacity 0–1. Default 0.7. */
  captionBackgroundOpacity?: number;
  /** Whether the LLM key-phrase highlight spans render inside CaptionOverlay.
   *  When false, English text + Chinese translation render plain. The
   *  right-side SubtitleList is unaffected. Default true. */
  captionHighlightsEnabled?: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  llmProvider: "openai-compatible",
  vendorId: "deepseek",
  openaiCompatible: { baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-v4-flash" },
  claude: { apiKey: "", model: "claude-sonnet-4-6" },
  gemini: { apiKey: "", model: "gemini-2.5-pro" },
  whisperModel: "small",
  libraryDir: "",
  cookieSource: "none",
  cookiesFile: "",
  whisperBackend: "",
  preferDiscreteGpu: true,
  vendorKeys: {},
  bridgeEnabled: true,
  captionFontColor: "#FFFFFF",
  captionFontScale: 1,
  captionFontOpacity: 1,
  captionBackgroundColor: "#000000",
  captionBackgroundOpacity: 0.7,
  captionHighlightsEnabled: true,
};

/** Projection of caption-related Settings fields with defaults applied.
 *  CaptionOverlay + the gear-menu captions submenu both consume this. */
export interface CaptionStyle {
  fontColor: string;
  fontScale: number;
  fontOpacity: number;
  bgColor: string;
  bgOpacity: number;
  highlightsEnabled: boolean;
  offsetX: number;
  offsetY: number;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontColor: "#FFFFFF",
  fontScale: 1,
  fontOpacity: 1,
  bgColor: "#000000",
  bgOpacity: 0.7,
  highlightsEnabled: true,
  offsetX: 0,
  offsetY: 0,
};

export function captionStyleFromSettings(s: Settings): CaptionStyle {
  return {
    fontColor: s.captionFontColor ?? DEFAULT_CAPTION_STYLE.fontColor,
    fontScale: s.captionFontScale ?? DEFAULT_CAPTION_STYLE.fontScale,
    fontOpacity: s.captionFontOpacity ?? DEFAULT_CAPTION_STYLE.fontOpacity,
    bgColor: s.captionBackgroundColor ?? DEFAULT_CAPTION_STYLE.bgColor,
    bgOpacity: s.captionBackgroundOpacity ?? DEFAULT_CAPTION_STYLE.bgOpacity,
    highlightsEnabled:
      s.captionHighlightsEnabled ?? DEFAULT_CAPTION_STYLE.highlightsEnabled,
    // offsetX/Y are NOT persisted in settings — they reset to 0 every time
    // Player mounts. Caller (Player.tsx) overrides them with a per-session
    // useState before passing the style to CaptionOverlay.
    offsetX: 0,
    offsetY: 0,
  };
}
