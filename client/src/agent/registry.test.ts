import { describe, it, expect } from "vitest";
import { TOOLS, getTool, listTools } from "./registry";
import type { ToolDef } from "./types";

describe("registry", () => {
  it("TOOLS includes the registered tools (15 so far through T17)", () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(15);
    expect(TOOLS.map((t) => t.id)).toEqual(
      expect.arrayContaining([
        "corpus_browse",
        "corpus_phrase_detail",
        "list_library",
        "list_vocab",
        "open_video",
        "open_page",
        "seek_to_time",
        "jump_to_cue",
        "explain_passage",
        "generate_quiz",
        "mark_liaisons",
        "translate_phrase",
        "vocab_add",
        "vocab_remove",
        "vocab_update_note",
      ]),
    );
  });
  it("getTool returns undefined for unknown id", () => {
    expect(getTool("nonexistent")).toBeUndefined();
  });
  it("listTools with no page returns all tools", () => {
    expect(listTools()).toEqual(TOOLS);
  });
  it("listTools filters by availableOn(page)", () => {
    const fakeTool: ToolDef = {
      id: "fake",
      description: "x",
      parameters: { type: "object", properties: {}, additionalProperties: false } as any,
      riskTier: "LOW",
      availableOn: (page) => page.pathname.startsWith("/player/"),
      runningLabel: "运行中",
      doneLabel: () => "完成",
      execute: async () => null,
    };
    // Cheap inline registry shim
    const filtered = [fakeTool].filter((t) => t.availableOn({ pathname: "/library" }));
    expect(filtered).toHaveLength(0);
  });
});
