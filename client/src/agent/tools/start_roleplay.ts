// src/agent/tools/start_roleplay.ts
//
// HIGH-risk tutor tool: derives 1-3 roleplay scenarios from the current video's
// analysis + learner profile (LLM call), then shows the picker overlay.

import type { ToolDef } from "../types";
import { deriveScenarios } from "../../tutor/roleplaySceneLLM";
import { getCachedScenarios, setCachedScenarios } from "../../tutor/roleplayScenarioCache";
import { loadLearnerProfile } from "../../tutor/learnerProfile";
import { useAnalysis } from "../../store/analysis";
import { useSettings } from "../../store/settings";
import { useTutorRuntime } from "../../store/tutorRuntime";

export interface StartRoleplayArgs {
  sourceVideoId?: string;
  scenarioHint?: string;
}

export interface StartRoleplayResult {
  count: number;
}

export const startRoleplayTool: ToolDef<StartRoleplayArgs, StartRoleplayResult> = {
  id: "start_roleplay",
  description:
    "启动角色扮演 — agent 会从当前视频推导 1-3 个场景候选，由用户挑一个开始对话练习。",
  parameters: {
    type: "object",
    properties: {
      sourceVideoId: { type: "string", nullable: true },
      scenarioHint: { type: "string", nullable: true },
    },
    required: [],
    additionalProperties: false,
  } as never,
  riskTier: "HIGH",
  availableOn: () => true,
  runningLabel: "正在生成角色扮演场景…",
  doneLabel: (r) => `推荐了 ${r.count} 个场景`,
  async execute(args, ctx) {
    const sourceVideoId = args.sourceVideoId ?? null;

    // Reuse this session's already-generated batch for this video if present —
    // closing + reopening the picker should NOT re-derive a fresh batch.
    const cached = getCachedScenarios(sourceVideoId);
    if (cached) {
      useTutorRuntime.getState().setMode({
        kind: "roleplay-picker",
        scenarios: cached,
        sourceVideoId,
        loading: false,
      });
      return { count: cached.length };
    }

    // Show loading state immediately
    useTutorRuntime.getState().setMode({
      kind: "roleplay-picker",
      scenarios: [],
      sourceVideoId,
      loading: true,
    });
    const settings = useSettings.getState().settings;
    const analysis = useAnalysis.getState().subtitles;
    const profile = await loadLearnerProfile();
    const scenarios = await deriveScenarios({
      settings,
      analysis,
      profile,
      sourceVideoId,
      signal: ctx.signal,
    });
    setCachedScenarios(sourceVideoId, scenarios);
    useTutorRuntime.getState().setMode({
      kind: "roleplay-picker",
      scenarios,
      sourceVideoId,
      loading: false,
    });
    return { count: scenarios.length };
  },
};
