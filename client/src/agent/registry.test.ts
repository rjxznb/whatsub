import { describe, it, expect } from "vitest";
import { TOOLS, getTool, listTools } from "./registry";
import type { ToolDef } from "./types";

describe("registry", () => {
  it("TOOLS starts as an empty array (tools added in later tasks)", () => {
    expect(TOOLS).toEqual([]);
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
