// src/agent/tools/open_page.ts
//
// LOW-risk navigation tool: jump to a top-level app page (Library /
// Vocab / Corpus / Settings). Routes via the nav.ts bridge so this
// module doesn't need React Router.

import type { ToolDef } from "../types";
import { navigate } from "../nav";

export type OpenPageTarget = "library" | "vocab" | "corpus" | "settings";

export interface OpenPageArgs {
  page: OpenPageTarget;
}

export interface OpenPageResult {
  ok: true;
  navigatedTo: string;
}

export const openPageTool: ToolDef<OpenPageArgs, OpenPageResult> = {
  id: "open_page",
  description:
    "Navigate to a top-level page in the app: library, vocab, corpus, or settings.",
  parameters: {
    type: "object",
    properties: {
      page: {
        type: "string",
        enum: ["library", "vocab", "corpus", "settings"],
      },
    },
    required: ["page"],
    additionalProperties: false,
  } as never,
  riskTier: "LOW",
  availableOn: () => true,
  runningLabel: "正在跳转…",
  doneLabel: (r) => `已跳转到 ${r.navigatedTo}`,
  async execute({ page }) {
    const target = `/${page}`;
    navigate(target);
    return { ok: true, navigatedTo: target };
  },
};
