// src/agent/tools/open_video.ts
//
// LOW-risk navigation tool: open a video in the Player page. Optional
// `atSec` jumps to a specific time via the ?t= query param the Player
// already parses. Routing is delegated to the nav.ts bridge so this
// module never needs React Router internals.

import type { ToolDef } from "../types";
import { navigate } from "../nav";

export interface OpenVideoArgs {
  videoId: string;
  atSec?: number;
}

export interface OpenVideoResult {
  ok: true;
  navigatedTo: string;
}

export const openVideoTool: ToolDef<OpenVideoArgs, OpenVideoResult> = {
  id: "open_video",
  description:
    "Open a video in the Player page by id. Optionally jump to a specific time (atSec).",
  parameters: {
    type: "object",
    properties: {
      videoId: { type: "string" },
      atSec: { type: "number", nullable: true, minimum: 0 },
    },
    required: ["videoId"],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: () => true,
  runningLabel: "正在打开视频…",
  doneLabel: (r) => `已打开 ${r.navigatedTo}`,
  async execute({ videoId, atSec }) {
    const target =
      atSec != null && atSec > 0
        ? `/player/${videoId}?t=${Math.floor(atSec)}`
        : `/player/${videoId}`;
    navigate(target);
    return { ok: true, navigatedTo: target };
  },
};
