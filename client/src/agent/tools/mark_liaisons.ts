// src/agent/tools/mark_liaisons.ts
//
// LOW-risk Player-only in-video AI tool: streams an LLM-generated JSON
// array of connected-speech / liaison points in a single cue. The LLM
// emits a JSON array; this tool parses + coerces it into a typed list
// of LiaisonRange entries. Malformed JSON or out-of-shape entries
// degrade to an empty array rather than throwing — the caller renders
// "no notable liaisons" rather than failing the whole agent turn.

import type { ToolDef } from "../types";
import { useAnalysis } from "../../store/analysis";
import { useSettings } from "../../store/settings";
import { getProvider } from "../../llm/providers";
import { buildLiaisonPrompt } from "../_promptBuilders";
import type { SrtCue } from "../../llm/types";

export interface MarkLiaisonsArgs {
  videoId: string;
  cueIdx: number;
}

export interface LiaisonRange {
  cueIdx: number;
  wordStart: string;
  wordEnd: string;
  pronunciation: string;
  why: string;
}

export interface MarkLiaisonsResult {
  liaisons: LiaisonRange[];
}

function isLiaisonRange(x: unknown): x is LiaisonRange {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.cueIdx === "number" &&
    typeof o.wordStart === "string" &&
    typeof o.wordEnd === "string" &&
    typeof o.pronunciation === "string" &&
    typeof o.why === "string"
  );
}

export const markLiaisonsTool: ToolDef<MarkLiaisonsArgs, MarkLiaisonsResult> = {
  id: "mark_liaisons",
  description:
    "Identify connected-speech / liaison points in a single subtitle cue of the active video. Returns a JSON array of liaisons (may be empty if there are no notable ones). Only available on the Player page.",
  parameters: {
    type: "object",
    properties: {
      videoId: { type: "string" },
      cueIdx: { type: "integer", minimum: 0 },
    },
    required: ["videoId", "cueIdx"],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: (page) => page.pathname.startsWith("/player/"),
  runningLabel: "正在标连读…",
  doneLabel: (r) => `已标连读 (${r.liaisons.length} 处)`,
  async execute(args, ctx) {
    const subtitles = useAnalysis.getState().subtitles;
    if (args.cueIdx < 0 || args.cueIdx >= subtitles.length) {
      throw new Error(
        `cueIdx ${args.cueIdx} out of range (0..${subtitles.length - 1})`,
      );
    }
    const s = subtitles[args.cueIdx];
    const cues: SrtCue[] = [
      { index: args.cueIdx, time: s.time, endTime: s.endTime, text: s.text },
    ];
    const prompt = buildLiaisonPrompt(
      { cues, analyzedSubtitles: subtitles },
      args.cueIdx,
    );
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(full);
    } catch {
      return { liaisons: [] };
    }
    if (!Array.isArray(parsed)) return { liaisons: [] };
    return { liaisons: parsed.filter(isLiaisonRange) };
  },
};
