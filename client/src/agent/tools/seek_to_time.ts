// src/agent/tools/seek_to_time.ts
//
// LOW-risk Player-only navigation tool: seek the active video to a
// specific time (in seconds). Routes through usePlayerState.seekHandler
// which Player.tsx registers on mount; throws if no Player is mounted.

import type { ToolDef } from "../types";
import { usePlayerState } from "../../store/playerState";

export interface SeekToTimeArgs {
  sec: number;
}

export interface SeekToTimeResult {
  ok: true;
  sec: number;
}

export const seekToTimeTool: ToolDef<SeekToTimeArgs, SeekToTimeResult> = {
  id: "seek_to_time",
  description:
    "Seek the active video to a specific time in seconds. Only available on the Player page.",
  parameters: {
    type: "object",
    properties: {
      sec: { type: "number", minimum: 0 },
    },
    required: ["sec"],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: (page) => page.pathname.startsWith("/player/"),
  runningLabel: "正在跳到指定时间…",
  doneLabel: (r) => `已跳到 ${r.sec.toFixed(1)} 秒`,
  async execute({ sec }) {
    const handler = usePlayerState.getState().seekHandler;
    if (!handler) throw new Error("not on player page");
    const clamped = Math.max(0, sec);
    handler(clamped);
    return { ok: true, sec: clamped };
  },
};
