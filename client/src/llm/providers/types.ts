import type { Settings } from "../../types/settings";
import type { ToolDef, AgentEvent } from "../../agent/types";
import type { Message } from "../../types/agent";

export interface ProviderRequest {
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}

/**
 * A provider streams text chunks. Caller is responsible for parsing JSON-lines.
 */
export interface Provider {
  stream(req: ProviderRequest): AsyncIterable<string>;
}

export type ProviderFactory = (settings: Settings) => Provider;

// — Agent extensions —

export interface StreamWithToolsOpts {
  systemPrompt: string;
  history: Message[];
  tools: ToolDef[];
  signal: AbortSignal;
}

export interface AgentProvider {
  streamWithTools(opts: StreamWithToolsOpts): AsyncGenerator<AgentEvent>;
}
