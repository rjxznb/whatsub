import type { UserMessage } from "../../types/agent";

interface Props {
  msg: UserMessage;
}

/**
 * Claude.ai-inspired user bubble: right-aligned, subtle zinc background,
 * no border, no role label. Spacing-only differentiation from assistant text.
 */
export function UserBubble({ msg }: Props) {
  return (
    <div className="flex justify-end mb-4 px-4">
      <div className="max-w-[80%] bg-zinc-800/60 text-zinc-100 text-[14px] leading-relaxed rounded-2xl px-4 py-2.5 whitespace-pre-wrap break-words">
        {msg.content}
      </div>
    </div>
  );
}
