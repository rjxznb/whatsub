// src/agent/tools/sync_to_cloud.ts
//
// MID-risk library write tool: sync a video to the cloud (whatsub.eversay.cc).
// Invokes library_sync_to_cloud which uploads captions + optionally a transcoded
// video. Returns sync status and whether the video was uploaded.

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";

export interface SyncToCloudArgs {
  videoId: string;
}

export interface SyncToCloudResult {
  synced: boolean;
  videoUploaded: boolean;
  videoUrl?: string;
}

interface SyncOkResponse {
  ok: boolean;
  syncedAt: number;
  videoUploaded: boolean;
}

export const syncToCloudTool: ToolDef<SyncToCloudArgs, SyncToCloudResult> = {
  id: "sync_to_cloud",
  description:
    "Synchronize a video to the cloud (whatsub.eversay.cc) so it can be viewed on the iOS app. Uploads captions and optionally a transcoded video.",
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
  runningLabel: "正在同步到云端…",
  doneLabel: (r) =>
    r.videoUploaded ? "已同步视频到云端" : "已同步字幕到云端（视频未上传）",
  async execute({ videoId }, _ctx) {
    const response = await invoke<SyncOkResponse>("library_sync_to_cloud", {
      id: videoId,
    });

    return {
      synced: true,
      videoUploaded: response.videoUploaded,
      videoUrl: response.videoUploaded ? videoId : undefined,
    };
  },
};
