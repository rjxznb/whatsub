// src/agent/tools/import_video.ts
//
// MID-risk library write tool: import a video from a URL (fire-and-watch).
// Invokes import_video with background:true, which returns immediately after
// enqueuing the import. The actual yt-dlp download + transcription + LLM
// analysis happens out-of-band; the LLM tells the user "started, watch Library"
// rather than blocking for completion (which could take 5-30 minutes).

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";

export interface ImportVideoArgs {
  url: string;
  quality?: "best" | "720p" | "1080p";
}

export interface ImportVideoResult {
  started: true;
  watchAt: "/library";
  sourceUrl: string;
}

export const importVideoTool: ToolDef<ImportVideoArgs, ImportVideoResult> = {
  id: "import_video",
  description:
    "Import a video from a URL (YouTube, Bilibili, etc.). The import runs in the background; check the Library to see progress. Quality can be 'best', '720p', or '1080p'; defaults to 'best'.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      quality: {
        type: "string",
        enum: ["best", "720p", "1080p"],
        nullable: true,
      },
    },
    required: ["url"],
    additionalProperties: false,
  } as never,
  riskTier: "MID",
  availableOn: () => true,
  runningLabel: "正在启动导入…",
  doneLabel: () => "已启动导入（进度看 Library）",
  async execute({ url, quality }, _ctx) {
    // Fire-and-watch: background:true returns immediately after enqueue.
    // The actual import happens out-of-band; LLM-generated messages tell
    // the user to check the Library.
    await invoke<void>("import_video", {
      sourceKind: "url",
      sourceValue: url,
      quality: quality ?? "best",
      background: true,
    });

    return {
      started: true as const,
      watchAt: "/library" as const,
      sourceUrl: url,
    };
  },
};
