// src/agent/tools/read_video_analysis.ts
//
// LOW-risk discovery tool: read a library video's analyzed content (subtitle
// full text + key phrases) so the agent can summarize it, answer questions, or
// quiz on it. This is what makes "@video → 总结/出题" work — list_library only
// returns metadata, not the transcript.

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";
import type { AnalysisResult } from "../../llm/types";
import { useLibrary } from "../../store/library";

const FULLTEXT_CAP = 6000; // chars — bound the result so it doesn't blow context

export interface ReadVideoAnalysisArgs {
  videoId: string;
}

export interface ReadVideoAnalysisResult {
  found: boolean;
  videoId: string;
  title?: string;
  durationSec?: number;
  cueCount?: number;
  /** Joined subtitle text, capped at ~6000 chars. */
  fullTextExcerpt?: string;
  truncated?: boolean;
  keyPhrases?: Array<{ expression: string; meaningZh: string }>;
}

export const readVideoAnalysisTool: ToolDef<
  ReadVideoAnalysisArgs,
  ReadVideoAnalysisResult
> = {
  id: "read_video_analysis",
  description:
    "读取库中某个视频的已分析内容（字幕全文 + 重点短语），用于总结、答疑、出题。需要 videoId（从 list_library 或用户的 @引用里拿）。只读，不下载。",
  parameters: {
    type: "object",
    properties: {
      videoId: { type: "string", minLength: 1 },
    },
    required: ["videoId"],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: () => true,
  runningLabel: "正在读取视频内容…",
  doneLabel: (r) => (r.found ? `已读取《${r.title ?? r.videoId}》` : "未找到该视频的分析"),
  async execute({ videoId }) {
    const entry = (useLibrary.getState().library.videos ?? []).find((v) => v.id === videoId);

    let analysis: AnalysisResult | null = null;
    try {
      analysis = await invoke<AnalysisResult | null>("load_analysis", { videoId });
    } catch {
      analysis = null;
    }

    if (!analysis) {
      return { found: false, videoId, title: entry?.title };
    }

    const subs = analysis.subtitles ?? [];
    const joined = subs.map((s) => s.text).join(" ");
    const excerpt = joined.slice(0, FULLTEXT_CAP);

    return {
      found: true,
      videoId,
      title: entry?.title,
      durationSec: entry?.durationSec,
      cueCount: subs.length,
      fullTextExcerpt: excerpt,
      truncated: joined.length > FULLTEXT_CAP,
      keyPhrases: (analysis.keyPhrases ?? [])
        .slice(0, 30)
        .map((k) => ({ expression: k.expression, meaningZh: k.meaningZh })),
    };
  },
};
