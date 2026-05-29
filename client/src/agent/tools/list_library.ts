// src/agent/tools/list_library.ts
//
// LOW-risk discovery tool: list videos in the user's local library with
// optional filtering. Reads the zustand store directly — no Rust round
// trip — and applies all filters TS-side. Sorted by createdAt desc and
// capped at args.limit (default 20).

import type { ToolDef } from "../types";
import { useLibrary } from "../../store/library";

export interface ListLibraryArgs {
  scene?: string;
  status?: "ready" | "analyzing" | "failed";
  syncedOnly?: boolean;
  limit?: number;
}

export interface ListLibraryVideo {
  id: string;
  title: string;
  scene?: string;
  durationSec?: number;
  syncedAt?: number;
  status?: string;
}

export interface ListLibraryResult {
  videos: ListLibraryVideo[];
  total: number;
  matched: number;
}

const DEFAULT_LIMIT = 20;

export const listLibraryTool: ToolDef<ListLibraryArgs, ListLibraryResult> = {
  id: "list_library",
  description:
    "List videos in the user's local library, optionally filtered by scene, status, or sync state. Sorted newest first.",
  parameters: {
    type: "object",
    properties: {
      scene: { type: "string", nullable: true },
      status: {
        type: "string",
        enum: ["ready", "analyzing", "failed"],
        nullable: true,
      },
      syncedOnly: { type: "boolean", nullable: true },
      limit: { type: "integer", nullable: true, minimum: 1, maximum: 200 },
    },
    required: [],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: () => true,
  runningLabel: "正在查询库...",
  doneLabel: (r) => `库内 ${r.matched} 条匹配`,
  async execute(args) {
    const all = useLibrary.getState().library.videos ?? [];
    const total = all.length;

    let filtered = all;

    if (args.status) {
      filtered = filtered.filter((v) => v.status === args.status);
    }
    if (args.syncedOnly) {
      filtered = filtered.filter((v) => typeof v.syncedAt === "number");
    }
    if (args.scene) {
      // LibraryEntry has no canonical `scene` field today; tolerate a
      // user-attached one (e.g. via analysisStyle / future migration) by
      // probing both fields. Unknown-field filter degrades to "no match"
      // rather than throwing.
      const wantScene = args.scene.toLowerCase();
      filtered = filtered.filter((v) => {
        const probe = (v as unknown as { scene?: string }).scene;
        return typeof probe === "string" && probe.toLowerCase() === wantScene;
      });
    }

    // Sort newest first by createdAt (ISO string; lexicographic order is
    // the same as chronological for ISO 8601).
    filtered = [...filtered].sort((a, b) => {
      const ax = a.createdAt ?? "";
      const bx = b.createdAt ?? "";
      if (ax < bx) return 1;
      if (ax > bx) return -1;
      return 0;
    });

    const matched = filtered.length;
    const limit = args.limit ?? DEFAULT_LIMIT;
    const sliced = filtered.slice(0, limit);

    const videos: ListLibraryVideo[] = sliced.map((v) => ({
      id: v.id,
      title: v.title,
      scene: (v as unknown as { scene?: string }).scene,
      durationSec: v.durationSec,
      syncedAt: v.syncedAt,
      status: v.status,
    }));

    return { videos, total, matched };
  },
};
