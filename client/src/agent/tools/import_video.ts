// src/agent/tools/import_video.ts
//
// MID-risk library write tool: import a video from a URL (fire-and-watch).
// Invokes import_video with background:true, which returns immediately after
// enqueuing the import. The actual yt-dlp download + transcription + LLM
// analysis happens out-of-band; the LLM tells the user "started, watch Library"
// rather than blocking for completion (which could take 5-30 minutes).

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";
import { useSettings } from "../../store/settings";

export interface ImportVideoArgs {
  url: string;
  /** "low" / "standard" (720p) / "high" / "best" — see Rust ImportRequest.quality. */
  quality?: "low" | "standard" | "high" | "best";
}

export interface ImportVideoResult {
  started: true;
  watchAt: "/library";
  sourceUrl: string;
}

export const importVideoTool: ToolDef<ImportVideoArgs, ImportVideoResult> = {
  id: "import_video",
  description:
    "Import a video from a URL (YouTube, Bilibili, etc.). The import runs in the background — returns immediately; check the Library to see progress. Quality is one of low/standard/high/best (standard=720p is the default; best lets yt-dlp pick the highest quality available, can be very large).",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      quality: {
        type: "string",
        enum: ["low", "standard", "high", "best"],
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
    const settings = useSettings.getState().settings;

    // The Rust command signature is `import_video(app, state, req: ImportRequest)`
    // so the JS-side invoke MUST wrap args in a `req` key (matching the Rust
    // parameter name). Tauri converts JS camelCase to Rust snake_case via
    // serde rename_all = "camelCase" on the request struct.
    //
    // Fire-and-watch: background:true returns immediately after enqueue.
    // The actual yt-dlp + Whisper + LLM work happens out-of-band; the LLM
    // tells the user to check the Library for progress rather than awaiting.
    await invoke<unknown>("import_video", {
      req: {
        sourceKind: "url",
        sourceValue: url,
        whisperModel: settings.whisperModel,
        quality: quality ?? "standard",
        background: true,
      },
    });

    return {
      started: true as const,
      watchAt: "/library" as const,
      sourceUrl: url,
    };
  },
};
