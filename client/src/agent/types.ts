// src/agent/types.ts
import type { JSONSchemaType } from "ajv";

export type RiskTier = "LOW" | "MID" | "HIGH";

export interface PageContext {
  pathname: string;
  videoId?: string;
  cueIdx?: number | null;
}

export interface ExecuteContext {
  signal: AbortSignal;
}

export interface ToolDef<TArgs = unknown, TResult = unknown> {
  id: string;
  description: string;
  parameters: JSONSchemaType<TArgs>;
  riskTier: RiskTier;
  /** Optional per-args risk override; checked first by the gate. */
  getRisk?: (args: TArgs) => RiskTier;
  availableOn: (page: PageContext) => boolean;
  runningLabel: string;
  doneLabel: (result: TResult) => string;
  execute: (args: TArgs, ctx: ExecuteContext) => Promise<TResult>;
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call_start"; callId: string; name: string }
  | { type: "tool_call_args"; callId: string; deltaJson: string }
  | { type: "tool_call_end"; callId: string }
  | { type: "stop_reason"; reason: "end_turn" | "tool_use" | "max_tokens" }
  | { type: "error"; message: string; upsell?: boolean };
