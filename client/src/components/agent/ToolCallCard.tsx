import { useState } from "react";
import { useAgent } from "../../store/agent";
import { getTool } from "../../agent/registry";
import type { AssistantBlock, ToolMessage } from "../../types/agent";
import { YouTubeResults } from "./YouTubeResults";
import type { YouTubeSearchHit } from "../../agent/tools/youtube_search";

interface Props {
  /** The tool_call AssistantBlock that spawned this card. */
  callBlock: Extract<AssistantBlock, { type: "tool_call" }>;
  /** True if the parent assistant message is still streaming (runtime mid-turn). */
  parentStreaming?: boolean;
  /** True while the whole runtime turn is in flight — INCLUDING after the
   *  parent message finished streaming, while this tool is actually executing.
   *  Without it, a long tool (e.g. youtube_search's yt-dlp call) would show a
   *  static "准备调用" with no spinner for its entire run. */
  turnInFlight?: boolean;
}

/**
 * Claude.ai-inspired tool call row: a single subtle text row with hover
 * background; clickable rows expand to show args/result/error JSON.
 * Critically: NO colored backgrounds (no amber/emerald/rose boxes) — just
 * text color shifts indicate state.
 *
 * State derivation (from the matching ToolMessage by callId):
 *   - no ToolMessage + !parentStreaming → queued
 *   - no ToolMessage + parentStreaming  → running
 *   - ToolMessage.status === "ok"       → done OK (folded)
 *   - ToolMessage.status === "error"    → failed (expanded by default)
 *   - ToolMessage.status === "cancelled_by_user" → cancelled
 */
export function ToolCallCard({ callBlock, parentStreaming, turnInFlight }: Props) {
  const toolMsg = useAgent((s) => {
    const conv = s.history.conversations.find(
      (c) => c.id === s.history.activeConversationId,
    );
    return conv?.messages.find(
      (m): m is ToolMessage =>
        m.role === "tool" && m.callId === callBlock.callId,
    );
  });

  // Failed tools expand by default; OK tools fold by default.
  const initiallyExpanded = toolMsg?.status === "error";
  const [expanded, setExpanded] = useState(initiallyExpanded);

  const tool = getTool(callBlock.name);
  const runningLabel = tool?.runningLabel ?? "正在执行…";
  const doneLabel = (result: unknown): string =>
    tool?.doneLabel(result) ?? "已完成";

  // ── No ToolMessage yet: queued or running (non-clickable rows) ────────────
  if (!toolMsg) {
    // Spin while the parent message is streaming OR while the turn is still in
    // flight (the tool is executing after the message finished streaming) — a
    // long yt-dlp search would otherwise sit at a static "准备调用" with no
    // visible progress for its whole 45s run.
    if (parentStreaming || turnInFlight) {
      return (
        <div className="my-1.5 flex items-center gap-2 text-xs text-zinc-500 px-2 -ml-2">
          <span className="inline-block animate-spin text-zinc-500">⟳</span>
          <span className="truncate">{runningLabel}</span>
        </div>
      );
    }
    return (
      <div className="my-1.5 flex items-center gap-2 text-xs text-zinc-500 px-2 -ml-2">
        <span className="text-zinc-600">▸</span>
        <span className="truncate">准备调用 {callBlock.name}</span>
      </div>
    );
  }

  // ── Cancelled (non-clickable) ─────────────────────────────────────────────
  if (toolMsg.status === "cancelled_by_user") {
    return (
      <div className="my-1.5 flex items-center gap-2 text-xs text-zinc-600 px-2 -ml-2">
        <span>⊘</span>
        <span className="truncate">已取消</span>
      </div>
    );
  }

  // ── Failed (clickable; text-only red, no box) ─────────────────────────────
  if (toolMsg.status === "error") {
    return (
      <div className="my-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-xs hover:bg-zinc-900/60 rounded px-2 py-1 -ml-2 w-full text-left"
        >
          <span className="text-rose-400">✗</span>
          <span className="flex-1 truncate text-rose-400">
            {callBlock.name} 失败 — {toolMsg.errorMessage ?? "(unknown error)"}
          </span>
          <span className="text-zinc-600">{expanded ? "▾" : "▸"}</span>
        </button>
        {expanded && (
          <div className="mt-1 ml-2 space-y-1.5 text-[11px]">
            <pre className="px-2 py-1.5 bg-zinc-950 rounded text-zinc-400 overflow-x-auto">
{`Args:\n${JSON.stringify(callBlock.args, null, 2)}`}
            </pre>
          </div>
        )}
      </div>
    );
  }

  // ── youtube_search: render rich preview cards (thumbnail → inline play) ───
  const ytHits =
    callBlock.name === "youtube_search"
      ? ((toolMsg.result as { hits?: YouTubeSearchHit[] } | null)?.hits ?? null)
      : null;

  // ── Done OK (clickable; faded zinc text, no green) ────────────────────────
  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-xs hover:bg-zinc-900/60 rounded px-2 py-1 -ml-2 w-full text-left text-zinc-400"
      >
        <span className="text-zinc-500">·</span>
        <span className="flex-1 truncate">{doneLabel(toolMsg.result)}</span>
        <span className="text-zinc-600">{expanded ? "▾" : "▸"}</span>
      </button>
      {ytHits && <YouTubeResults hits={ytHits} />}
      {expanded && (
        <div className="mt-1 ml-2 space-y-1.5 text-[11px]">
          <div className="text-zinc-600 text-[10px]">
            {callBlock.name} · {toolMsg.durationMs}ms
          </div>
          <pre className="px-2 py-1.5 bg-zinc-950 rounded text-zinc-400 overflow-x-auto">
{`Args:\n${JSON.stringify(callBlock.args, null, 2)}`}
          </pre>
          <pre className="px-2 py-1.5 bg-zinc-950 rounded text-zinc-400 overflow-x-auto">
{`Result:\n${JSON.stringify(toolMsg.result, null, 2)}`}
          </pre>
        </div>
      )}
    </div>
  );
}
