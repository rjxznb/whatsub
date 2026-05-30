import { Bot } from "lucide-react";
import type { AssistantBlock, AssistantMessage } from "../../types/agent";
import { ToolCallCard } from "./ToolCallCard";
import { MarkdownText } from "./markdown";

interface Props {
  msg: AssistantMessage;
  /** True if this message is still streaming (last assistant of the conversation, runtime in flight). */
  streaming?: boolean;
}

/** Index of the last text block, or -1 if none. */
function lastTextBlockIdx(blocks: AssistantBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === "text") return i;
  }
  return -1;
}

/**
 * Claude.ai-inspired assistant row: small Bot avatar at left, flat text body
 * (no bubble, no border). Tool calls are sub-rows in the same column.
 */
export function AssistantBubble({ msg, streaming }: Props) {
  const lastText = lastTextBlockIdx(msg.blocks);
  return (
    <div className="flex gap-3 mb-4 px-4">
      <div className="shrink-0 mt-0.5">
        <div className="h-6 w-6 grid place-items-center rounded-full ring-1 ring-zinc-700 bg-zinc-900">
          <Bot size={14} className="text-zinc-400" />
        </div>
      </div>
      <div className="flex-1 min-w-0 text-[14px] text-zinc-100 leading-relaxed space-y-2">
        {msg.blocks.map((b, i) => {
          if (b.type === "text") {
            return (
              <MarkdownText
                key={i}
                text={b.text}
                withCursor={!!streaming && i === lastText}
              />
            );
          }
          return (
            <ToolCallCard
              key={i}
              callBlock={b}
              parentStreaming={!!streaming}
            />
          );
        })}
        {msg.stopReason === "error" && (
          <div className="text-xs text-rose-400">连接中断</div>
        )}
        {msg.stopReason === "cancelled" && (
          <div className="text-xs text-zinc-500">已停止</div>
        )}
      </div>
    </div>
  );
}
