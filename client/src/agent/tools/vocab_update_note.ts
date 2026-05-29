// src/agent/tools/vocab_update_note.ts
//
// MID-risk write tool: update the note/usage field of a single vocabulary entry.
// Calls invoke("vocab_update_note", { id, note }).

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";

export interface VocabUpdateNoteArgs {
  id: string;
  note: string;
}

export interface VocabUpdateNoteResult {
  updated: boolean;
  id: string;
}

export const vocabUpdateNoteTool: ToolDef<VocabUpdateNoteArgs, VocabUpdateNoteResult> = {
  id: "vocab_update_note",
  description: "Update the note/usage field of a saved vocabulary entry by id.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      note: { type: "string" },
    },
    required: ["id", "note"],
    additionalProperties: false,
  } as never,
  riskTier: "MID",
  availableOn: () => true,
  runningLabel: "正在更新笔记…",
  doneLabel: () => "已更新笔记",
  async execute(args) {
    await invoke("vocab_update_note", { id: args.id, note: args.note });
    return {
      updated: true,
      id: args.id,
    };
  },
};
