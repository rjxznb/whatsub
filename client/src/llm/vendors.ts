import type { LlmProvider } from "../types/settings";

/** A vendor preset bundles protocol + baseUrl + suggested models so the user
 *  picks "DeepSeek" instead of having to know it's OpenAI-compatible at
 *  https://api.deepseek.com/v1 with model `deepseek-v4-flash`. */
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
    // deepseek-chat / deepseek-reasoner are deprecated (retired 2026-07-24) →
    // V4: deepseek-v4-flash (general chat) + deepseek-v4-pro.
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    keyConsoleUrl: "https://platform.deepseek.com/api_keys",
    note: "国内直连，速度快，一个月差不多两块钱 💰",
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
    keyConsoleUrl: "https://platform.openai.com/api-keys",
    note: "需要科学上网，效果稳定，一个视频几毛到一块多",
  },
  {
    id: "kimi",
    name: "Kimi (Moonshot)",
    protocol: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    keyConsoleUrl: "https://platform.moonshot.cn/console/api-keys",
    note: "国内直连，价格友好，长视频也能一口气读完",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    protocol: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4-plus", "glm-4", "glm-4-flash"],
    keyConsoleUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    note: "清华系出品，国内直连，flash 模型有免费额度可以白嫖 🎁",
  },
  {
    id: "qwen",
    name: "阿里 Qwen (DashScope)",
    protocol: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-max", "qwen-turbo", "qwen3-coder-plus"],
    keyConsoleUrl: "https://bailian.console.aliyun.com/",
    note: "阿里出品，国内直连，turbo 版本几分钱一个视频",
  },
  {
    id: "minimax",
    name: "MiniMax",
    protocol: "openai-compatible",
    baseUrl: "https://api.minimaxi.com/v1",
    models: ["MiniMax-M2", "MiniMax-Text-01", "abab6.5s-chat"],
    keyConsoleUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    note: "国内直连，海螺 AI 同款厂商，文本模型免费额度比较大",
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
    note: "国内中转站，一把钥匙能用 DeepSeek / Qwen / Yi 等好几家",
  },
  {
    id: "ollama",
    name: "Ollama 本地",
    protocol: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    models: ["llama3", "mistral", "qwen2", "gemma2"],
    note: "完全在你电脑上跑，不联网不花钱，需要先在 ollama.ai 装好 Ollama 并 pull 一个模型",
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
    note: "需要科学上网，翻译质量顶级，但价格偏高（一个视频几块到十几块）",
  },
  {
    id: "gemini",
    name: "Gemini (Google 原生)",
    protocol: "gemini",
    baseUrl: "",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    keyConsoleUrl: "https://aistudio.google.com/apikey",
    note: "需要科学上网，flash 版本有不少免费额度，pro 版本更聪明",
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
