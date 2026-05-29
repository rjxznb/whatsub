import type { AssistantMessage } from "../../types/agent";

interface Props {
  msg: AssistantMessage;
  /** True if this message is still streaming (last assistant of the conversation, runtime in flight). */
  streaming?: boolean;
}

export function AssistantBubble({ msg, streaming }: Props) {
  return (
    <div className="flex justify-start my-2 px-2">
      <div className="max-w-[90%] flex flex-col gap-1">
        <div className="text-xs text-zinc-500 mb-1">🤖</div>
        {msg.blocks.map((b, i) => {
          if (b.type === "text") {
            const isLast = i === msg.blocks.length - 1;
            return (
              <div
                key={i}
                className="text-sm text-zinc-200 whitespace-pre-wrap break-words"
              >
                {b.text}
                {streaming && isLast && (
                  <span className="inline-block w-1 h-4 ml-1 bg-zinc-400 animate-pulse align-middle" />
                )}
              </div>
            );
          }
          return (
            <ToolCallPlaceholder
              key={i}
              name={b.name}
              callId={b.callId}
            />
          );
        })}
        {msg.stopReason === "error" && (
          <div className="text-xs text-rose-400">⚠ 连接中断</div>
        )}
        {msg.stopReason === "cancelled" && (
          <div className="text-xs text-zinc-500">已停止</div>
        )}
      </div>
    </div>
  );
}

interface ToolCallPlaceholderProps {
  name: string;
  callId: string;
  status?: string;
}

/**
 * Placeholder for tool_call blocks. T23 will replace this with the real
 * ToolCallCard component (1-line import swap).
 */
export function ToolCallPlaceholder({ name }: ToolCallPlaceholderProps) {
  return (
    <div className="my-2 px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded text-xs text-zinc-300">
      🔧 工具调用：{name}
    </div>
  );
}
