import type { LlmProvider } from "../types/settings";

/** A vendor preset bundles protocol + baseUrl + suggested models so the user
 *  picks "DeepSeek" instead of having to know it's OpenAI-compatible at
 *  https://api.deepseek.com/v1 with model `deepseek-chat`. */
export interface VendorPreset {
  id: string;
  /** Display name shown in the dropdown. */
  name: string;
  /** Internal protocol the request layer uses. */
  protocol: LlmProvider;
  /** Pre-filled base URL for OpenAI-compatible vendors. Empty for native
   *  Claude/Gemini and for the "custom" preset. */
  baseUrl: string;
  /** Suggested models for the datalist. User can type their own. */
  models: string[];
  /** URL where the user goes to obtain an API key, shown as a link below the
   *  API Key field. Empty if not applicable (e.g. Ollama). */
  keyConsoleUrl?: string;
  /** Extra inline note about the vendor (shown below model field). */
  note?: string;
}

export const VENDORS: VendorPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    keyConsoleUrl: "https://platform.deepseek.com/api_keys",
    note: "国内访问稳定，价格极低（约 $0.14 / 百万 token）",
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
    keyConsoleUrl: "https://platform.openai.com/api-keys",
    note: "国内访问需代理",
  },
  {
    id: "kimi",
    name: "Kimi (Moonshot)",
    protocol: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    keyConsoleUrl: "https://platform.moonshot.cn/console/api-keys",
    note: "长上下文（128k）",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    protocol: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4-plus", "glm-4", "glm-4-flash"],
    keyConsoleUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "qwen",
    name: "阿里 Qwen (DashScope)",
    protocol: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-max", "qwen-turbo", "qwen3-coder-plus"],
    keyConsoleUrl: "https://bailian.console.aliyun.com/",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow (硅基流动)",
    protocol: "openai-compatible",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: [
      "deepseek-ai/DeepSeek-V3",
      "Qwen/Qwen2.5-72B-Instruct",
      "01-ai/Yi-1.5-34B-Chat",
    ],
    keyConsoleUrl: "https://cloud.siliconflow.cn/account/ak",
    note: "聚合多家开源模型，可访问 DeepSeek/Qwen/Yi 等",
  },
  {
    id: "ollama",
    name: "Ollama 本地",
    protocol: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    models: ["llama3", "mistral", "qwen2", "gemma2"],
    note: "本地服务无需 API key（留空或填任意字符）。在 ollama.ai 安装 Ollama 后用 `ollama pull <model>` 下载模型。",
  },
  {
    id: "claude",
    name: "Claude (Anthropic 原生)",
    protocol: "claude",
    baseUrl: "",
    models: [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ],
    keyConsoleUrl: "https://console.anthropic.com/settings/keys",
    note: "国内访问需代理",
  },
  {
    id: "gemini",
    name: "Gemini (Google 原生)",
    protocol: "gemini",
    baseUrl: "",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    keyConsoleUrl: "https://aistudio.google.com/apikey",
    note: "国内访问需代理",
  },
  {
    id: "custom",
    name: "自定义 (OpenAI 兼容)",
    protocol: "openai-compatible",
    baseUrl: "",
    models: [],
    note: "用于上面没列出的 OpenAI 兼容服务（如个人代理、其他第三方）",
  },
];

/** Fallback inference for legacy settings without an explicit vendorId. */
export function inferVendorId(
  protocol: LlmProvider,
  baseUrl: string
): string {
  if (protocol === "claude") return "claude";
  if (protocol === "gemini") return "gemini";
  // openai-compatible — match by baseUrl host.
  const url = baseUrl.toLowerCase().trim();
  if (!url) return "deepseek"; // default for first launch
  for (const v of VENDORS) {
    if (v.protocol === "openai-compatible" && v.baseUrl && url === v.baseUrl.toLowerCase()) {
      return v.id;
    }
  }
  // Match by host domain as a softer fallback.
  for (const v of VENDORS) {
    if (v.protocol === "openai-compatible" && v.baseUrl) {
      try {
        const vendorHost = new URL(v.baseUrl).host;
        const userHost = new URL(url).host;
        if (vendorHost === userHost) return v.id;
      } catch {
        /* skip invalid URLs */
      }
    }
  }
  return "custom";
}

export function getVendor(id: string): VendorPreset | undefined {
  return VENDORS.find((v) => v.id === id);
}
