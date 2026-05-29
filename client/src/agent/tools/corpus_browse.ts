// src/agent/tools/corpus_browse.ts
//
// LOW-risk discovery tool: query the corpus (public or mine) for phrases
// optionally filtered by tags or a keyword substring.
//
// scope === "mine" routes to the `corpus_mine` Tauri command; otherwise
// the public `corpus_browse` command is used. Both return shapes are
// normalised into a flat {phrases: [...]} result for the agent.
//
// Keyword filtering is TS-side post-fetch (the Rust commands don't take
// a keyword argument).

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";

export interface CorpusBrowseArgs {
  tags?: string[];
  scope?: "public" | "mine";
  keyword?: string;
}

export interface CorpusBrowsePhrase {
  phrase: string;
  tags: string[];
  instanceCount: number;
}

export interface CorpusBrowseResult {
  phrases: CorpusBrowsePhrase[];
}

/** Normalise a tags blob that may be `{list: [...]}`, bare array, or null. */
function normalizeTags(t: unknown): string[] {
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  if (t && typeof t === "object" && "list" in t) {
    const list = (t as { list?: unknown }).list;
    if (Array.isArray(list)) return list.filter((x): x is string => typeof x === "string");
  }
  return [];
}

interface RawBrowseItem {
  phraseRaw?: string;
  phraseNormalized?: string;
  tags?: unknown;
  contributionCount?: number;
}

interface RawBrowseResp {
  items?: RawBrowseItem[];
  total?: number;
}

interface RawMineItem {
  phraseRaw?: string;
  phraseNormalized?: string;
  tags?: unknown;
}

interface RawMineResp {
  items?: RawMineItem[];
  total?: number;
}

export const corpusBrowseTool: ToolDef<CorpusBrowseArgs, CorpusBrowseResult> = {
  id: "corpus_browse",
  description:
    "Browse the corpus (public or personal) for phrases. Optionally filter by tags or a keyword substring. Returns up to ~50 phrases with tag + instance count metadata.",
  parameters: {
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: { type: "string" },
        nullable: true,
      },
      scope: {
        type: "string",
        enum: ["public", "mine"],
        nullable: true,
      },
      keyword: { type: "string", nullable: true },
    },
    required: [],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: () => true,
  runningLabel: "正在查询语料库…",
  doneLabel: (r) => `已查询语料库 (${r.phrases.length} 条)`,
  async execute(args) {
    const scope = args.scope ?? "public";
    const tags = args.tags?.length ? args.tags : undefined;

    let phrases: CorpusBrowsePhrase[] = [];

    if (scope === "mine") {
      const resp = await invoke<RawMineResp>("corpus_mine", {
        tags: tags ?? null,
        page: null,
        pageSize: null,
      });
      const items = resp.items ?? [];
      // mine items are per-contribution; group by normalised phrase for the count.
      const counts = new Map<string, { phrase: string; tags: string[]; count: number }>();
      for (const it of items) {
        const key = (it.phraseNormalized ?? it.phraseRaw ?? "").toLowerCase();
        if (!key) continue;
        const cur = counts.get(key);
        if (cur) {
          cur.count += 1;
        } else {
          counts.set(key, {
            phrase: it.phraseRaw ?? it.phraseNormalized ?? key,
            tags: normalizeTags(it.tags),
            count: 1,
          });
        }
      }
      phrases = Array.from(counts.values()).map((v) => ({
        phrase: v.phrase,
        tags: v.tags,
        instanceCount: v.count,
      }));
    } else {
      const resp = await invoke<RawBrowseResp>("corpus_browse", {
        scene: null,
        tags: tags ?? null,
        page: null,
        pageSize: null,
      });
      const items = resp.items ?? [];
      phrases = items.map((it) => ({
        phrase: it.phraseRaw ?? it.phraseNormalized ?? "",
        tags: normalizeTags(it.tags),
        instanceCount: it.contributionCount ?? 0,
      }));
    }

    if (args.keyword && args.keyword.trim()) {
      const kw = args.keyword.toLowerCase();
      phrases = phrases.filter((p) => p.phrase.toLowerCase().includes(kw));
    }

    return { phrases };
  },
};
