// src/agent/tools/retranscribe_video.ts
//
// HIGH-risk library write tool: re-transcribe a video (fire-and-watch).
// Kicks off the Rust pipeline (extract audio → whisper re-transcription)
// without awaiting completion. The actual re-transcription happens out-of-band;
// progress is visible in the Library's background-task widget. Returns immediately
// with a "watch Library" message.

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";
import { useSettings } from "../../store/settings";

export interface RetranscribeVideoArgs {
  videoId: string;
}

export interface RetranscribeVideoResult {
  started: true;
  watchAt: "/library";
  videoId: string;
}

export const retranscribeVideoTool: ToolDef<
  RetranscribeVideoArgs,
  RetranscribeVideoResult
> = {
  id: "retranscribe_video",
  description:
    "Re-transcribe a video using the current whisper model. The re-transcription runs in the background; check the Library to see progress.",
  parameters: {
    type: "object",
    properties: {
      videoId: { type: "string" },
    },
    required: ["videoId"],
    additionalProperties: false,
  } as never,
  riskTier: "HIGH",
  availableOn: () => true,
  runningLabel: "正在启动重新解析…",
  doneLabel: () => "已启动重新解析（进度看 Library）",
  async execute({ videoId }, _ctx) {
    // Fire-and-forget: kick off the retranscribe pipeline without awaiting.
    // The Rust command runs to completion regardless; progress events emit to
    // the Library's background-task widget via pipeline-event emitter.
    const settings = useSettings.getState().settings;

    invoke<void>("retranscribe_video", {
      videoId,
      whisperModel: settings.whisperModel,
      background: true,
    }).catch((e) =>
      console.warn("[retranscribe_video] background invoke error:", e)
    );

    return {
      started: true as const,
      watchAt: "/library" as const,
      videoId,
    };
  },
};
