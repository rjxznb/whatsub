// src/agent/tools/start_remediation.ts
//
// MID-risk tutor tool: launches a 3-minute targeted drill session for a
// specific error pattern the user keeps making. Validates that the pattern
// exists in the controlled vocabulary AND has a question bank before launching.

import type { ToolDef } from "../types";
import { useTutorRuntime } from "../../store/tutorRuntime";
import { isErrorPattern, ERROR_PATTERNS, type ErrorPattern } from "../../tutor/errorPatterns";
import { isAvailablePattern } from "../../tutor/remediationQuestions";

export interface StartRemediationArgs {
  pattern: string;
}

export interface StartRemediationResult {
  launched: boolean;
  pattern: string;
}

export const startRemediationTool: ToolDef<StartRemediationArgs, StartRemediationResult> = {
  id: "start_remediation",
  description: "启动 3 分钟专项练习，针对用户反复出错的某个语法/表达 pattern。",
  parameters: {
    type: "object",
    properties: { pattern: { type: "string" } },
    required: ["pattern"],
    additionalProperties: false,
  } as never,
  riskTier: "MID",
  availableOn: () => true,
  runningLabel: "正在开始专项练习…",
  doneLabel: (r) => `已开始专项：${r.pattern}`,
  async execute(args) {
    if (!isErrorPattern(args.pattern)) {
      throw new Error(
        `未知错误类别: ${args.pattern}（可选: ${ERROR_PATTERNS.join(", ")}）`,
      );
    }
    if (!isAvailablePattern(args.pattern as ErrorPattern)) {
      throw new Error("该 pattern 暂无题库（v1 仅 5 个高频 pattern 有题）");
    }
    useTutorRuntime.getState().setMode({
      kind: "remediation",
      pattern: args.pattern as ErrorPattern,
      candidateErrorIds: [],
    });
    return { launched: true, pattern: args.pattern };
  },
};
