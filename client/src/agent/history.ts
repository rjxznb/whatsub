// src/agent/history.ts
//
// Builds the "wire history" sent to the LLM each turn from the full stored
// conversation — WITHOUT mutating the store (the UI still shows everything).
//
// Two reductions, in order:
//   #3  Trim large tool results from PAST turns to a short placeholder. The
//       model saw the full data the turn it was produced (and showed the user);
//       re-sending the whole JSON every subsequent turn just burns tokens.
//       Current-turn tool results (after the last user message) stay full so the
//       ReAct loop can still reason over them.
//   #1  Token-budget cap. Estimate the total tokens; if it exceeds the model's
//       context budget, drop the OLDEST messages until it fits (then strip any
//       leading orphan tool message whose assistant tool_call was dropped).
//
// Token counting is a cheap char heuristic — we only need "are we near the
// model's limit", not exact billing.

import type { Message, ToolMessage } from "../types/agent";

/** Rough token estimate: CJK ≈ 1 tok/char, everything else ≈ 1 tok / 4 chars. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[㐀-鿿豈-﫿]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

function messageText(m: Message): string {
  if (m.role === "user") return m.content;
  if (m.role === "assistant") {
    let s = "";
    for (const b of m.blocks) {
      if (b.type === "text") s += b.text;
      else if (b.type === "tool_call") s += b.name + JSON.stringify(b.args ?? {});
    }
    return s;
  }
  const tm = m as ToolMessage;
  return tm.status === "ok"
    ? JSON.stringify(tm.result ?? null)
    : (tm.errorMessage ?? "");
}

/** ~4 tokens of per-message envelope overhead (role tags, delimiters). */
function estimateMessageTokens(m: Message): number {
  return estimateTokens(messageText(m)) + 4;
}

/** Total estimated tokens of a whole message list (for the context-usage ring). */
export function estimateMessagesTokens(messages: Message[]): number {
  let sum = 0;
  for (const m of messages) sum += estimateMessageTokens(m);
  return sum;
}

// ── #3: trim past-turn tool results ──────────────────────────────────────────

/** Tool results whose serialized JSON exceeds this get folded in past turns. */
export const TOOL_RESULT_TRIM_CHARS = 600;

function lastUserIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

function trimOldToolResults(messages: Message[]): Message[] {
  const lastUser = lastUserIndex(messages);
  return messages.map((m, i) => {
    if (m.role !== "tool" || i >= lastUser) return m; // current turn → keep full
    const tm = m as ToolMessage;
    if (tm.status !== "ok") return m;
    const serialized = JSON.stringify(tm.result ?? null);
    if (serialized.length <= TOOL_RESULT_TRIM_CHARS) return m;
    return {
      ...tm,
      result: `[历史工具结果已折叠以节省上下文] ${tm.name} 当时返回了 ${serialized.length} 字符的结果并已展示给用户。如需具体内容请重新调用该工具。`,
    };
  });
}

// ── #1: token budget ─────────────────────────────────────────────────────────

/** Input-token budget for the wire history, derived from the model's context
 *  window with headroom reserved for the system prompt + tool schemas + output. */
export function modelContextBudget(model: string): number {
  const m = (model ?? "").toLowerCase();
  let ctx: number;
  if (m.includes("deepseek") || m.includes("gemini")) ctx = 1_000_000;
  else if (m.includes("claude")) ctx = 200_000;
  else if (m.includes("kimi") || m.includes("moonshot")) ctx = 128_000;
  else ctx = 128_000; // safe default for unknown OpenAI-compatible models
  return Math.floor(ctx * 0.85); // ~15% headroom
}

/**
 * Produce the messages actually sent to the LLM this turn. Pure — never mutates
 * the input array or its messages (trimmed tool messages are fresh objects).
 */
export function prepareWireHistory(
  messages: Message[],
  maxTokens: number,
): Message[] {
  const trimmed = trimOldToolResults(messages);

  const toks = trimmed.map(estimateMessageTokens);
  let total = toks.reduce((a, b) => a + b, 0);
  if (total <= maxTokens) return trimmed;

  // Drop oldest messages until under budget (always keep the final message).
  let start = 0;
  while (start < trimmed.length - 1 && total > maxTokens) {
    total -= toks[start];
    start++;
  }
  let kept = trimmed.slice(start);

  // A leading `tool` message would be an orphan (its assistant tool_call was
  // dropped) — providers reject that. Drop leading tool messages.
  let cut = 0;
  while (cut < kept.length && kept[cut].role === "tool") cut++;
  if (cut > 0) kept = kept.slice(cut);

  return kept;
}
