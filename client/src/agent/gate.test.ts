import { describe, it, expect } from "vitest";
import { ConfirmationGate } from "./gate";
import type { ToolDef, RiskTier } from "./types";

function tool(id: string, riskTier: RiskTier, getRisk?: (args: any) => RiskTier): ToolDef {
  return {
    id,
    description: "",
    parameters: { type: "object", properties: {}, additionalProperties: false } as any,
    riskTier,
    getRisk,
    availableOn: () => true,
    runningLabel: "",
    doneLabel: () => "",
    execute: async () => null,
  };
}

describe("ConfirmationGate.classify", () => {
  it("returns static riskTier when no getRisk", () => {
    expect(ConfirmationGate.classify(tool("a", "LOW"), {})).toBe("LOW");
    expect(ConfirmationGate.classify(tool("b", "MID"), {})).toBe("MID");
    expect(ConfirmationGate.classify(tool("c", "HIGH"), {})).toBe("HIGH");
  });
  it("uses getRisk(args) when defined", () => {
    const t = tool("vocab_add", "MID", (args: { entries: unknown[] }) =>
      args.entries.length >= 3 ? "MID" : "LOW",
    );
    expect(ConfirmationGate.classify(t, { entries: ["a"] })).toBe("LOW");
    expect(ConfirmationGate.classify(t, { entries: ["a", "b"] })).toBe("LOW");
    expect(ConfirmationGate.classify(t, { entries: ["a", "b", "c"] })).toBe("MID");
  });
});
