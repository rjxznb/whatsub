// src/agent/tools/corpus_phrase_detail.ts
//
// LOW-risk discovery tool: fetch curator meaning + usage note + tags + the
// public/personal contribution counts for a single phrase. Thin wrapper
// over the existing `corpus_phrase_detail` Tauri command (which hardcodes
// withScope=true server-side; the JS layer doesn't need to pass it).

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";

export interface CorpusPhraseDetailArgs {
  phrase: string;
}

export interface CorpusPhraseDetailResult {
  phrase: string;
  meaningZh?: string;
  usageNote?: string;
  tags: string[];
  publicContributions: number;
  personalContributions: number;
}

interface RawPhraseDetail {
  phrase?: {
    phraseRaw?: string;
    phraseNormalized?: string;
    meaningZh?: string;
    usageNote?: string;
    tags?: unknown;
  } | null;
  publicContributions?: unknown[];
  personalContributions?: unknown[];
}

function normalizeTags(t: unknown): string[] {
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  if (t && typeof t === "object" && "list" in t) {
    const list = (t as { list?: unknown }).list;
    if (Array.isArray(list)) return list.filter((x): x is string => typeof x === "string");
  }
  return [];
}

export const corpusPhraseDetailTool: ToolDef<
  CorpusPhraseDetailArgs,
  CorpusPhraseDetailResult
> = {
  id: "corpus_phrase_detail",
  description:
    "Look up the curator-authored Chinese meaning, usage note, tags, and contribution counts for a single English phrase from the corpus.",
  parameters: {
    type: "object",
    properties: {
      phrase: { type: "string" },
    },
    required: ["phrase"],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: () => true,
  runningLabel: "正在查询短语详情…",
  doneLabel: (r) => `已查询 "${r.phrase}" 详情`,
  async execute(args) {
    const resp = await invoke<RawPhraseDetail>("corpus_phrase_detail", {
      phrase: args.phrase,
    });
    const p = resp.phrase ?? null;
    return {
      phrase: p?.phraseRaw ?? p?.phraseNormalized ?? args.phrase,
      meaningZh: p?.meaningZh ?? undefined,
      usageNote: p?.usageNote ?? undefined,
      tags: normalizeTags(p?.tags),
      publicContributions: resp.publicContributions?.length ?? 0,
      personalContributions: resp.personalContributions?.length ?? 0,
    };
  },
};
