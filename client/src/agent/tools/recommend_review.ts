// src/agent/tools/recommend_review.ts
//
// LOW-risk discovery tool — the heart of the "private tutor" loop. Given the
// learner's weak patterns (or a specific one), it resolves the user's OWN past
// mistakes back to the exact video + subtitle cue where they happened, so the
// agent can say "回去复习《入境面试》2:15 那句 —— 你把 went 说成了 goed".
//
// Anchoring is precise, not heuristic: every ErrorEvent carries source.videoId
// + source.cueIdx; we load that video's analysis.json (load_analysis) and read
// subtitles[cueIdx].time/.text to produce a seekable timestamp. The agent then
// narrates the items and offers to open_video(videoId, atSec).

import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../types";
import { loadLearnerProfile } from "../../tutor/learnerProfile";
import {
  ERROR_PATTERN_LABELS,
  isErrorPattern,
  type ErrorPattern,
} from "../../tutor/errorPatterns";
import { useLibrary } from "../../store/library";
import { formatTime } from "../../utils/time";
import type { AnalysisResult } from "../../llm/types";

export interface RecommendReviewArgs {
  /** A specific weak pattern to review. Omit → use the learner's top weak
   *  patterns automatically. */
  pattern?: string;
  /** Max review items to return (default 5, capped at 10). */
  limit?: number;
}

export interface ReviewItem {
  videoId: string;
  videoTitle: string;
  /** Seconds to seek to (pass as open_video atSec). */
  atSec: number;
  /** Human MM:SS label for narration. */
  timeLabel: string;
  cueIdx: number;
  pattern: ErrorPattern;
  patternLabel: string;
  /** The subtitle sentence at that cue. */
  sentence: string;
  /** What the user said wrong, and the correction. */
  yourMistake: string;
  correction: string;
}

export interface RecommendReviewResult {
  items: ReviewItem[];
  note: string;
}

function videoTitle(id: string): string {
  const v = (useLibrary.getState().library.videos ?? []).find((x) => x.id === id);
  return v?.title ?? id;
}

export const recommendReviewTool: ToolDef<RecommendReviewArgs, RecommendReviewResult> = {
  id: "recommend_review",
  description:
    "根据学生的薄弱 pattern，把他过去真实犯错的位置定位回「具体视频 + 几分几秒的那句字幕」，用于推荐复习。可指定一个 pattern，或留空让工具按 top 薄弱点自动挑。返回每条含 videoId / atSec（秒）/ MM:SS / 原句 / 当时的错误→正确说法。拿到后用 open_video(videoId, atSec) 带用户跳过去。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", nullable: true },
      limit: { type: "number", nullable: true, minimum: 1, maximum: 10 },
    },
    required: [],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: () => true,
  runningLabel: "正在挑选复习片段…",
  doneLabel: (r) => `挑了 ${r.items.length} 处复习点`,
  async execute(args) {
    const limit = Math.min(10, Math.max(1, args.limit ?? 5));
    const profile = await loadLearnerProfile();

    // Resolve the target pattern set.
    const requested =
      args.pattern && isErrorPattern(args.pattern) ? (args.pattern as ErrorPattern) : null;
    const weak = profile.masteryIndex.weakPatterns;
    const targets = new Set<ErrorPattern>(
      requested ? [requested] : weak.map((w) => w.pattern),
    );
    if (targets.size === 0) {
      return {
        items: [],
        note: "学习档案里还没有薄弱点数据 —— 先做一次精讲或角色扮演，我才知道你哪里需要复习。",
      };
    }

    // Candidate errors: unresolved, pattern in scope, with a video+cue anchor.
    // Newest first, de-duplicated by (videoId, cueIdx) so one spot shows once.
    const seen = new Set<string>();
    const candidates = profile.errorEvents
      .filter(
        (e) =>
          !e.resolved &&
          targets.has(e.pattern) &&
          e.source.videoId != null &&
          e.source.cueIdx != null,
      )
      .sort((a, b) => b.ts - a.ts)
      .filter((e) => {
        const k = `${e.source.videoId}#${e.source.cueIdx}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

    if (candidates.length === 0) {
      return {
        items: [],
        note: requested
          ? `「${ERROR_PATTERN_LABELS[requested]}」最近没有未掌握的犯错记录 —— 要么没练到、要么已经专项过了。`
          : "你最近的薄弱点都已经专项过了 👍 想练新内容可以开一节精讲或角色扮演。",
      };
    }

    // Resolve each candidate to a timestamp via its video's analysis. Cache the
    // analysis per video so multiple errors in the same video load once.
    const analysisCache = new Map<string, AnalysisResult | null>();
    const items: ReviewItem[] = [];
    for (const e of candidates) {
      if (items.length >= limit) break;
      const videoId = e.source.videoId as string;
      const cueIdx = e.source.cueIdx as number;
      let analysis = analysisCache.get(videoId);
      if (analysis === undefined) {
        try {
          analysis = await invoke<AnalysisResult | null>("load_analysis", { videoId });
        } catch {
          analysis = null;
        }
        analysisCache.set(videoId, analysis);
      }
      const sub = analysis?.subtitles?.[cueIdx];
      if (!sub) continue; // video deleted / re-transcribed / cue gone → skip
      items.push({
        videoId,
        videoTitle: videoTitle(videoId),
        atSec: sub.time,
        timeLabel: formatTime(sub.time),
        cueIdx,
        pattern: e.pattern,
        patternLabel: ERROR_PATTERN_LABELS[e.pattern],
        sentence: sub.text,
        yourMistake: e.userInput,
        correction: e.correction,
      });
    }

    return {
      items,
      note:
        items.length > 0
          ? `基于你过去的犯错，挑了 ${items.length} 处复习点（按时间从近到远）。`
          : "找到了犯错记录，但对应的视频已删除或重新转写，定位不到原句了。",
    };
  },
};
