// src/types/agent.ts — mirrors src-tauri/src/commands/agent.rs serde shapes

export interface AgentHistory {
  version: 1;
  activeConversationId: string | null;
  conversations: Conversation[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pageContextAtStart: PageSnapshot;
  summaryUpToMsgId: string | null;
  summary: string | null;
  messages: Message[];
}

export interface PageSnapshot {
  pathname: string;
  videoId?: string;
  videoTitle?: string;
  cueIdx?: number;
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface UserMessage {
  role: "user";
  id: string;
  ts: number;
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  id: string;
  ts: number;
  blocks: AssistantBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" | "cancelled";
  usage?: { promptChars: number; responseChars: number; cnyEstimate: number | null };
  vendor: string;
  model: string;
}

export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown };

export interface ToolMessage {
  role: "tool";
  id: string;
  ts: number;
  callId: string;
  name: string;
  status: "ok" | "error" | "cancelled_by_user";
  result?: unknown;
  errorMessage?: string;
  durationMs: number;
  confirmDecision?:
    | "auto"
    | "inline_yes"
    | "inline_no"
    | "modal_yes"
    | "modal_no"
    | "panel_closed";
}
