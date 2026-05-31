// src/agent/tools/query_learner_profile.ts
//
// LOW-risk discussion tool: reads the local learner profile and returns a
// human-readable text summary. Useful for the agent to introspect the user's
// level and weak patterns before planning a lesson or roleplay.

import type { ToolDef } from "../types";
import { loadLearnerProfile } from "../../tutor/learnerProfile";
import { ERROR_PATTERN_LABELS } from "../../tutor/errorPatterns";

export interface QueryLearnerProfileArgs {
  field?: "summary" | "weak" | "recent";
}

export interface QueryLearnerProfileResult {
  text: string;
}

export const queryLearnerProfileTool: ToolDef<QueryLearnerProfileArgs, QueryLearnerProfileResult> = {
  id: "query_learner_profile",
  description:
    "读取本地学习档案（水平估计 / 薄弱 pattern / 最近错误）。讨论模式工具，不触发任何动作。",
  parameters: {
    type: "object",
    properties: {
      field: {
        type: "string",
        nullable: true,
        enum: ["summary", "weak", "recent"],
      },
    },
    required: [],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: () => true,
  runningLabel: "正在读取学习档案…",
  doneLabel: () => "已读取学习档案",
  async execute(args) {
    const p = await loadLearnerProfile();
    const field = args.field ?? "summary";

    if (field === "summary") {
      return {
        text: `CEFR ${p.estimate.cefr ?? "未知"} · 词汇约 ${p.estimate.vocabSize ?? "?"} · 错误事件 ${p.errorEvents.length} 条 · 薄弱 pattern ${p.masteryIndex.weakPatterns.length} 类`,
      };
    }

    if (field === "weak") {
      const top = p.masteryIndex.weakPatterns.slice(0, 5);
      return {
        text:
          top.length === 0
            ? "暂无薄弱 pattern 数据"
            : top
                .map((w) => `${w.pattern} (${ERROR_PATTERN_LABELS[w.pattern]}) ×${w.occurrences}`)
                .join("\n"),
      };
    }

    // field === "recent"
    const recent = p.errorEvents.slice(-10).reverse();
    return {
      text:
        recent.length === 0
          ? "暂无错误事件"
          : recent.map((e) => `[${e.pattern}] ${e.userInput} → ${e.correction}`).join("\n"),
    };
  },
};
