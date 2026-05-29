// src/agent/tools/translate_phrase.ts
//
// LOW-risk in-video AI tool, available on every page (no Player gate):
// translates a short text snippet to/from Chinese using the user's
// configured LLM. Default direction is English → Chinese; pass
// targetLang: "en" for the reverse.

import type { ToolDef } from "../types";
import { useSettings } from "../../store/settings";
import { getProvider } from "../../llm/providers";

export interface TranslatePhraseArgs {
  text: string;
  targetLang?: "zh" | "en";
}

export interface TranslatePhraseResult {
  translation: string;
}

export const translatePhraseTool: ToolDef<TranslatePhraseArgs, TranslatePhraseResult> = {
  id: "translate_phrase",
  description:
    "Translate a short text snippet between English and Chinese. Default direction is English → Chinese; pass targetLang: 'en' to translate Chinese → English.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1 },
      targetLang: { type: "string", enum: ["zh", "en"], nullable: true },
    },
    required: ["text"],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: () => true,
  runningLabel: "正在翻译…",
  doneLabel: (r) => `已翻译 (${r.translation.length} 字)`,
  async execute(args, ctx) {
    const targetLang = args.targetLang ?? "zh";
    const prompt = `Translate this ${targetLang === "en" ? "Chinese to English" : "English to Chinese"}:\n\n${args.text}\n\nReply with ONLY the translation, no quotes, no prose.`;
    const settings = useSettings.getState().settings;
    const provider = getProvider(settings);
    let full = "";
    for await (const chunk of provider.stream({
      systemPrompt: "",
      userPrompt: prompt,
      signal: ctx.signal,
    })) {
      if (ctx.signal.aborted) break;
      full += chunk;
    }
    return { translation: full.trim() };
  },
};
