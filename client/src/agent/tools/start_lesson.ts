// src/agent/tools/start_lesson.ts
//
// HIGH-risk Player-only tutor tool: generates a lesson plan (LLM call) from
// the current video's analysis + learner profile, then pushes lesson-preclass
// mode into the tutorRuntime store so the overlay can show the pre-class screen.

import type { ToolDef } from "../types";
import { planLesson } from "../../tutor/lessonPlanLLM";
import { loadLearnerProfile } from "../../tutor/learnerProfile";
import { useAnalysis } from "../../store/analysis";
import { useSettings } from "../../store/settings";
import { useTutorRuntime } from "../../store/tutorRuntime";

export interface StartLessonArgs {
  videoId: string;
}

export interface StartLessonResult {
  overview: string;
  anchorCount: number;
  estimateTokens: number;
}

export const startLessonTool: ToolDef<StartLessonArgs, StartLessonResult> = {
  id: "start_lesson",
  description:
    "启动精讲模式 — agent 会先生成教学计划 + 显示 token 估算屏，由用户确认开始。只能在视频播放页调用。",
  parameters: {
    type: "object",
    properties: {
      videoId: { type: "string" },
    },
    required: ["videoId"],
    additionalProperties: false,
  } as never,
  riskTier: "HIGH",
  availableOn: (page) => page.pathname.startsWith("/player/"),
  runningLabel: "正在生成教学计划…",
  doneLabel: (r) => `已准备精讲：${r.overview}（${r.anchorCount} 个教学点）`,
  async execute(args, ctx) {
    const settings = useSettings.getState().settings;
    const analysis = useAnalysis.getState().subtitles;
    const profile = await loadLearnerProfile();
    const plan = await planLesson({
      videoId: args.videoId,
      analysis,
      profile,
      settings,
      signal: ctx.signal,
    });
    if (!plan) {
      throw new Error("无法生成教学计划（LLM 返回无效 JSON），请稍后重试。");
    }
    useTutorRuntime.getState().setMode({
      kind: "lesson-preclass",
      videoId: args.videoId,
      plan,
    });
    return {
      overview: plan.overview,
      anchorCount: plan.anchors.length,
      estimateTokens: plan.estimateTokens,
    };
  },
};
