// src/agent/tools/list_vocab.ts
//
// LOW-risk discovery tool: list the user's saved vocabulary entries.
// Reads the zustand store directly — no Rust round trip. Optional videoId
// filter narrows to a single video; results sorted by addedAt desc and
// capped at args.limit (default 20).

import type { ToolDef } from "../types";
import { useVocabulary } from "../../store/vocab";

export interface ListVocabArgs {
  videoId?: string;
  limit?: number;
}

export interface ListVocabEntry {
  id: string;
  expression: string;
  meaningZh?: string;
  videoId?: string;
  time?: number;
}

export interface ListVocabResult {
  entries: ListVocabEntry[];
  total: number;
  matched: number;
}

const DEFAULT_LIMIT = 20;

export const listVocabTool: ToolDef<ListVocabArgs, ListVocabResult> = {
  id: "list_vocab",
  description:
    "List the user's saved vocabulary entries, optionally filtered by source videoId. Sorted newest first.",
  parameters: {
    type: "object",
    properties: {
      videoId: { type: "string", nullable: true },
      limit: { type: "integer", nullable: true, minimum: 1, maximum: 200 },
    },
    required: [],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: () => true,
  runningLabel: "正在查询生词本...",
  doneLabel: (r) => `生词本 ${r.matched} 条匹配`,
  async execute(args) {
    const all = useVocabulary.getState().entries ?? [];
    const total = all.length;

    let filtered = all;
    if (args.videoId) {
      filtered = filtered.filter((e) => e.videoId === args.videoId);
    }

    filtered = [...filtered].sort((a, b) => {
      const ax = a.addedAt ?? "";
      const bx = b.addedAt ?? "";
      if (ax < bx) return 1;
      if (ax > bx) return -1;
      return 0;
    });

    const matched = filtered.length;
    const limit = args.limit ?? DEFAULT_LIMIT;
    const sliced = filtered.slice(0, limit);

    const entries: ListVocabEntry[] = sliced.map((e) => ({
      id: e.id,
      expression: e.expression,
      meaningZh: e.meaningZh || undefined,
      videoId: e.videoId || undefined,
      time: e.cueTime,
    }));

    return { entries, total, matched };
  },
};
