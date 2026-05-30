// src/agent/tools/youtube_search.ts
//
// LOW-risk discovery tool: search YouTube for videos by topic via the
// Rust `youtube_search` command (which shells out to yt-dlp's
// `ytsearchN:` mode — no YouTube Data API quota consumed). Optional
// TS-side duration filter post-fetch lets the agent narrow down
// candidate clips without having to re-issue a different search.
//
// This tool only RETURNS metadata; to actually fetch a hit, the agent
// must follow up with `import_video` on the returned `url`.

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";

export interface YouTubeSearchArgs {
  query: string;
  limit?: number;
  minDurationSec?: number;
  maxDurationSec?: number;
}

export interface YouTubeSearchHit {
  id: string;
  title: string;
  channel?: string | null;
  durationSec?: number | null;
  viewCount?: number | null;
  url: string;
}

export interface YouTubeSearchResult {
  hits: YouTubeSearchHit[];
  query: string;
}

export const youtubeSearchTool: ToolDef<YouTubeSearchArgs, YouTubeSearchResult> = {
  id: "youtube_search",
  description:
    "Search YouTube for videos matching a query. Returns up to 10 (or `limit`) hits with title, URL, channel, duration. Does NOT download. To actually import a hit, call import_video with the returned URL.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 20, nullable: true },
      minDurationSec: { type: "integer", minimum: 0, nullable: true },
      maxDurationSec: { type: "integer", minimum: 0, nullable: true },
    },
    required: ["query"],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: () => true,
  runningLabel: "正在 YouTube 搜索…",
  doneLabel: (r) => `找到 ${r.hits.length} 个 YouTube 视频`,
  async execute(args) {
    const hits = await invoke<YouTubeSearchHit[]>("youtube_search", {
      query: args.query,
      limit: args.limit ?? 10,
    });
    // TS-side duration filter — Rust returns the full set so the agent
    // can also rerun the same yt-dlp shell-out without re-paying its
    // network cost when the duration window changes.
    const filtered = hits.filter((h) => {
      const d = h.durationSec ?? 0;
      if (args.minDurationSec != null && d < args.minDurationSec) return false;
      if (args.maxDurationSec != null && d > args.maxDurationSec) return false;
      return true;
    });
    return { hits: filtered, query: args.query };
  },
};
