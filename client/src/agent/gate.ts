import type { ToolDef, RiskTier } from "./types";

export const ConfirmationGate = {
  classify(toolDef: ToolDef, args: unknown): RiskTier {
    if (toolDef.getRisk) return toolDef.getRisk(args as never);
    return toolDef.riskTier;
  },
};
