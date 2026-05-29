import { useState } from "react";
import { useAgent } from "../../store/agent";
import { getTool } from "../../agent/registry";
import type { AssistantBlock, ToolMessage } from "../../types/agent";

interface Props {
  /** The tool_call AssistantBlock that spawned this card. */
  callBlock: Extract<AssistantBlock, { type: "tool_call" }>;
  /** True if the parent assistant message is still streaming (runtime mid-turn). */
  parentStreaming?: boolean;
}

/**
 * Renders a tool call's lifecycle inside an AssistantBubble. State is derived
 * from the matching ToolMessage (looked up by callId) in the active conversation:
 *
 *   - no ToolMessage + !parentStreaming → queued   (▸ 准备调用 X)
 *   - no ToolMessage + parentStreaming  → running  (⟳ <runningLabel>)
 *   - ToolMessage.status === "ok"       → done OK  (folded ✓ <doneLabel>)
 *   - ToolMessage.status === "error"    → failed   (expanded by default)
 *   - ToolMessage.status === "cancelled_by_user" → cancelled (⊘ 已取消)
 */
export function ToolCallCard({ callBlock, parentStreaming }: Props) {
  // Find the matching ToolMessage in the active conversation.
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

  // ── No ToolMessage yet: queued or running ─────────────────────────────────
  if (!toolMsg) {
    if (parentStreaming) {
      return (
        <div className="my-1 px-3 py-1.5 bg-zinc-800/40 border border-zinc-700/60 rounded text-xs text-zinc-400 inline-flex items-center gap-2">
          <span className="inline-block animate-spin">⟳</span> {runningLabel}
        </div>
      );
    }
    return (
      <div className="my-1 px-3 py-1.5 bg-zinc-800/40 border border-zinc-700/60 rounded text-xs text-zinc-500">
        ▸ 准备调用 {callBlock.name}
      </div>
    );
  }

  // ── Cancelled ─────────────────────────────────────────────────────────────
  if (toolMsg.status === "cancelled_by_user") {
    return (
      <div className="my-1 px-3 py-1.5 bg-zinc-800/40 border border-zinc-700/60 rounded text-xs text-zinc-500">
        ⊘ 已取消
      </div>
    );
  }

  // ── Failed ────────────────────────────────────────────────────────────────
  if (toolMsg.status === "error") {
    return (
      <div className="my-1 px-3 py-2 bg-rose-500/10 border border-rose-500/30 rounded text-xs">
        <div className="text-rose-300 mb-1">✗ {callBlock.name} 失败</div>
        <div className="text-zinc-400 whitespace-pre-wrap break-words mb-1">
          {toolMsg.errorMessage ?? "(unknown error)"}
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-zinc-500 hover:text-zinc-300 underline text-xs"
        >
          {expanded ? "收起" : "详情"}
        </button>
        {expanded && (
          <pre className="mt-2 p-2 bg-zinc-900 rounded text-[10px] text-zinc-400 overflow-x-auto">
{JSON.stringify(callBlock.args, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  // ── Done OK ───────────────────────────────────────────────────────────────
  return (
    <div className="my-1 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/30 rounded text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-emerald-300 hover:text-emerald-200 w-full text-left"
      >
        <span>✓ {doneLabel(toolMsg.result)}</span>
        <span className="ml-auto text-zinc-500">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          <div className="text-zinc-500 text-[10px]">
            {callBlock.name} · {toolMsg.durationMs}ms
          </div>
          <pre className="p-2 bg-zinc-900 rounded text-[10px] text-zinc-400 overflow-x-auto">
{"Args:\n" + JSON.stringify(callBlock.args, null, 2)}
          </pre>
          <pre className="p-2 bg-zinc-900 rounded text-[10px] text-zinc-400 overflow-x-auto">
{"Result:\n" + JSON.stringify(toolMsg.result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
