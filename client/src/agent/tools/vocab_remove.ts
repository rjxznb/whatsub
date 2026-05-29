// src/agent/tools/vocab_remove.ts
//
// MID-risk write tool: remove a single vocabulary entry by id.
// Calls invoke("vocab_remove", { id }).

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";

export interface VocabRemoveArgs {
  id: string;
}

export interface VocabRemoveResult {
  removed: boolean;
  id: string;
}

export const vocabRemoveTool: ToolDef<VocabRemoveArgs, VocabRemoveResult> = {
  id: "vocab_remove",
  description: "Remove a vocabulary entry by id from the user's saved vocabulary.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
    additionalProperties: false,
  } as never,
  riskTier: "MID",
  availableOn: () => true,
  runningLabel: "正在删除生词…",
  doneLabel: () => "已删除生词",
  async execute(args) {
    await invoke("vocab_remove", { id: args.id });
    return {
      removed: true,
      id: args.id,
    };
  },
};
