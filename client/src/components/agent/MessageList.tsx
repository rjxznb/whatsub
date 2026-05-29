import { useEffect, useRef } from "react";
import { useAgent } from "../../store/agent";
import { UserBubble } from "./UserBubble";
import { AssistantBubble } from "./AssistantBubble";

interface Props {
  /** True if a runtime turn is currently in flight; used to mark the last assistant
   *  message as still streaming (cursor visible). */
  streamingMsgId?: string | null;
}

export function MessageList({ streamingMsgId }: Props) {
  const history = useAgent((s) => s.history);
  const activeConv = history.conversations.find(
    (c) => c.id === history.activeConversationId,
  );
  const messages = activeConv?.messages ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length]);

  if (!activeConv || messages.length === 0) {
    return null; // EmptyState handled by parent in T25
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto py-2">
      {messages.map((m) => {
        if (m.role === "user") return <UserBubble key={m.id} msg={m} />;
        if (m.role === "assistant") {
          return (
            <AssistantBubble
              key={m.id}
              msg={m}
              streaming={streamingMsgId === m.id}
            />
          );
        }
        // role === "tool" → skipped; T23 will render via ToolCallCard
        return null;
      })}
    </div>
  );
}
