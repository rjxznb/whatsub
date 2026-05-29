// src/agent/tools/materialize_from_cloud.ts
//
// MID-risk library write tool: download a cloud-only video to local disk.
// Cloud videos (e.g. imported from iOS) may be captions-only; this command
// downloads the full video file from OSS and stores it locally, reusing the
// cloud's transcript + analysis to avoid re-transcription.

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";

export interface MaterializeFromCloudArgs {
  videoId: string;
}

export interface MaterializeFromCloudResult {
  materialized: boolean;
  videoId: string;
}

export const materializeFromCloudTool: ToolDef<
  MaterializeFromCloudArgs,
  MaterializeFromCloudResult
> = {
  id: "materialize_from_cloud",
  description:
    "Download a video from the cloud to local storage. Cloud-only videos (imported from the iOS app) can be materialized to access the full video file locally without needing a network connection.",
  parameters: {
    type: "object",
    properties: {
      videoId: { type: "string" },
    },
    required: ["videoId"],
    additionalProperties: false,
  } as never,
  riskTier: "MID",
  availableOn: () => true,
  runningLabel: "正在从云端下载…",
  doneLabel: () => "已下载到本地",
  async execute({ videoId }, _ctx) {
    await invoke<void>("library_materialize_from_cloud", {
      id: videoId,
    });

    return {
      materialized: true,
      videoId,
    };
  },
};
