// src/agent/tools/delete_video.ts
//
// HIGH-risk library write tool: delete a video from the library.
// Optionally also deletes from the cloud. Invokes library_delete and
// optionally library_unsync_from_cloud (if alsoCloud is true).

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";

export interface DeleteVideoArgs {
  videoId: string;
  alsoCloud?: boolean;
}

export interface DeleteVideoResult {
  deletedLocal: boolean;
  deletedCloud: boolean;
}

export const deleteVideoTool: ToolDef<DeleteVideoArgs, DeleteVideoResult> = {
  id: "delete_video",
  description:
    "Delete a video from the library. Optionally also delete from the cloud (iOS app). If cloud deletion fails, the local deletion still proceeds.",
  parameters: {
    type: "object",
    properties: {
      videoId: { type: "string" },
      alsoCloud: { type: "boolean", nullable: true },
    },
    required: ["videoId"],
    additionalProperties: false,
  } as never,
  riskTier: "HIGH",
  availableOn: () => true,
  runningLabel: "正在删除视频…",
  doneLabel: (r) =>
    r.deletedCloud ? "已删除本地与云端视频" : "已删除本地视频",
  async execute({ videoId, alsoCloud }, _ctx) {
    // If alsoCloud is true, attempt unsync first. If it fails, log and continue
    // with local delete only — the local source is always the master copy.
    if (alsoCloud) {
      try {
        await invoke<void>("library_unsync_from_cloud", { id: videoId });
      } catch (e) {
        console.warn(
          "[delete_video] cloud unsync failed, continuing with local delete:",
          e
        );
      }
    }

    await invoke<void>("library_delete", { id: videoId });

    return {
      deletedLocal: true,
      deletedCloud: !!alsoCloud,
    };
  },
};
