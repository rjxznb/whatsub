// src/agent/tools/generate_quiz.ts
//
// LOW-risk Player-only in-video AI tool: streams an LLM-generated quiz
// (5 multiple-choice questions, JSON Lines, one per line) covering a
// passage of cues in the active video.
//
// NB: this calls the user's configured LLM via provider.stream — that is
// the SECOND LLM call within a single agent turn. Counted against the
// 5-tool ReAct cap per agent turn.

import type { ToolDef } from "../types";
import { useAnalysis } from "../../store/analysis";
import { useSettings } from "../../store/settings";
import { getProvider } from "../../llm/providers";
import { buildQuizPrompt } from "../_promptBuilders";
import type { SrtCue } from "../../llm/types";

export interface GenerateQuizArgs {
  videoId: string;
  cueIdxStart: number;
  cueIdxEnd: number;
}

export interface GenerateQuizResult {
  quizJsonl: string;
}

export const generateQuizTool: ToolDef<GenerateQuizArgs, GenerateQuizResult> = {
  id: "generate_quiz",
  description:
    "Generate a 5-question multiple-choice quiz (2 vocab, 2 comprehension, 1 grammar) about a passage of subtitle cues in the active video. Returns JSON Lines — one question per line. Only available on the Player page.",
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
  runningLabel: "正在出题…",
  doneLabel: (r) =>
    `已生成 ${r.quizJsonl.split("\n").filter((l) => l.trim()).length} 道题`,
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
    const prompt = buildQuizPrompt({ cues, analyzedSubtitles: subtitles });
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
    return { quizJsonl: full };
  },
};
