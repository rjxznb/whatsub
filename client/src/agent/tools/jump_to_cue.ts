// src/agent/tools/jump_to_cue.ts
//
// LOW-risk Player-only navigation tool: jump the active video to the Nth
// subtitle cue. Looks up the cue's start time from useAnalysis.subtitles
// and routes through the Player's registered seekHandler. Throws on
// out-of-range cueIdx or when no Player is mounted.

import type { ToolDef } from "../types";
import { usePlayerState } from "../../store/playerState";
import { useAnalysis } from "../../store/analysis";

export interface JumpToCueArgs {
  cueIdx: number;
}

export interface JumpToCueResult {
  ok: true;
  cueIdx: number;
  sec: number;
}

export const jumpToCueTool: ToolDef<JumpToCueArgs, JumpToCueResult> = {
  id: "jump_to_cue",
  description:
    "Jump the active video to the start time of the Nth subtitle cue (0-indexed). Only available on the Player page.",
  parameters: {
    type: "object",
    properties: {
      cueIdx: { type: "integer", minimum: 0 },
    },
    required: ["cueIdx"],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: (page) => page.pathname.startsWith("/player/"),
  runningLabel: "正在跳到指定句…",
  doneLabel: (r) => `已跳到第 ${r.cueIdx + 1} 句`,
  async execute({ cueIdx }) {
    const handler = usePlayerState.getState().seekHandler;
    if (!handler) throw new Error("not on player page");
    const subs = useAnalysis.getState().subtitles;
    if (cueIdx < 0 || cueIdx >= subs.length) {
      throw new Error(
        `cueIdx ${cueIdx} out of range (0..${subs.length - 1})`,
      );
    }
    const time = subs[cueIdx].time;
    handler(time);
    return { ok: true, cueIdx, sec: time };
  },
};
