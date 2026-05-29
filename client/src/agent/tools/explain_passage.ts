// src/agent/tools/explain_passage.ts
//
// LOW-risk Player-only in-video AI tool: streams an LLM-generated Chinese
// explanation of a passage of cues from the current video. Wraps
// buildExplainPrompt + provider.stream into the agent ToolDef interface.
//
// NB: this calls the user's configured LLM via provider.stream — that is
// the SECOND LLM call within a single agent turn (the first being the
// runtime's main reasoning call). Each tool execution still counts
// against the 5-tool ReAct cap per agent turn.

import type { ToolDef } from "../types";
import { useAnalysis } from "../../store/analysis";
import { useSettings } from "../../store/settings";
import { getProvider } from "../../llm/providers";
import { buildExplainPrompt } from "../_promptBuilders";
import type { SrtCue } from "../../llm/types";

export interface ExplainPassageArgs {
  videoId: string;
  cueIdxStart: number;
  cueIdxEnd: number;
}

export interface ExplainPassageResult {
  explanation: string;
}

export const explainPassageTool: ToolDef<ExplainPassageArgs, ExplainPassageResult> = {
  id: "explain_passage",
  description:
    "Generate a Chinese explanation of a passage of subtitle cues (inclusive range) in the active video. Streams the explanation from the user's configured LLM. Only available on the Player page.",
  parameters: {
    type: "object",
    properties: {
      videoId: { type: "string" },
      cueIdxStart: { type: "integer", minimum: 0 },
      cueIdxEnd: { type: "integer", minimum: 0 },
    },
    required: ["videoId", "cueIdxStart", "cueIdxEnd"],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: (page) => page.pathname.startsWith("/player/"),
  runningLabel: "正在解释这一段…",
  doneLabel: (r) => `已生成解释 (${r.explanation.length} 字)`,
  async execute(args, ctx) {
    const subtitles = useAnalysis.getState().subtitles;
    if (
      args.cueIdxStart < 0 ||
      args.cueIdxEnd >= subtitles.length ||
      args.cueIdxStart > args.cueIdxEnd
    ) {
      throw new Error(
        `cue range [${args.cueIdxStart}, ${args.cueIdxEnd}] invalid for ${subtitles.length} subtitles`,
      );
    }
    const cues: SrtCue[] = subtitles
      .slice(args.cueIdxStart, args.cueIdxEnd + 1)
      .map((s, i) => ({
        index: args.cueIdxStart + i,
        time: s.time,
        endTime: s.endTime,
        text: s.text,
      }));
    const prompt = buildExplainPrompt({ cues, analyzedSubtitles: subtitles });
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
    return { explanation: full };
  },
};
