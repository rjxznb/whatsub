// src/agent/tools/unsync_from_cloud.ts
//
// HIGH-risk library write tool: remove a video from the cloud (whatsub.eversay.cc).
// The local copy is retained (local is the master). Invokes library_unsync_from_cloud,
// which also deletes the OSS video object.

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";

export interface UnsyncFromCloudArgs {
  videoId: string;
}

export interface UnsyncFromCloudResult {
  unsynced: true;
  videoId: string;
}

export const unsyncFromCloudTool: ToolDef<
  UnsyncFromCloudArgs,
  UnsyncFromCloudResult
> = {
  id: "unsync_from_cloud",
  description:
    "Remove a video from the cloud (iOS app). The local copy is retained. Also deletes the video object from OSS storage.",
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
  runningLabel: "正在从云端下架…",
  doneLabel: () => "已从云端下架",
  async execute({ videoId }, _ctx) {
    await invoke<void>("library_unsync_from_cloud", { id: videoId });

    return {
      unsynced: true as const,
      videoId,
    };
  },
};
