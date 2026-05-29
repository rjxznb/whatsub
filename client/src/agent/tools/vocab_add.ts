// src/agent/tools/vocab_add.ts
//
// MID-risk (dynamic) write tool: add one or more entries to the vocabulary.
// Uses getRisk(args) to determine risk: 1-2 entries → LOW (auto-execute +
// post-action Toast in T24 UI), ≥3 entries → MID (inline confirm card).
// Each entry is added via invoke("vocab_add", VocabEntry).

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";

export interface VocabAddEntry {
  expression: string;
  meaningZh?: string;
  videoId?: string;
  time?: number;
}

export interface VocabAddArgs {
  entries: VocabAddEntry[];
}

export interface VocabAddResult {
  added: number;
  ids: string[];
}

function generateId(): string {
  return `vocab_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export const vocabAddTool: ToolDef<VocabAddArgs, VocabAddResult> = {
  id: "vocab_add",
  description:
    "Add one or more entries to the user's vocabulary. Each entry is added as a saved word with optional meaning and source video/time.",
  parameters: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            expression: { type: "string" },
            meaningZh: { type: "string", nullable: true },
            videoId: { type: "string", nullable: true },
            time: { type: "number", nullable: true, minimum: 0 },
          },
          required: ["expression"],
          additionalProperties: false,
        },
        minItems: 1,
        maxItems: 50,
      },
    },
    required: ["entries"],
    additionalProperties: false,
  } as never,
  riskTier: "MID",
  getRisk: (args) => (args.entries.length >= 3 ? "MID" : "LOW"),
  availableOn: () => true,
  runningLabel: "正在添加生词…",
  doneLabel: (r) => `已添加 ${r.added} 条生词`,
  async execute(args) {
    const ids: string[] = [];

    for (const entry of args.entries) {
      const id = generateId();
      ids.push(id);

      await invoke("vocab_add", {
        id,
        expression: entry.expression,
        meaning_zh: entry.meaningZh ?? "",
        usage: "",
        video_id: entry.videoId ?? "",
        video_title: "",
        added_at: new Date().toISOString(),
      });
    }

    return {
      added: ids.length,
      ids,
    };
  },
};
