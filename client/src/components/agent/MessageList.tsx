import { useEffect, useMemo, useRef } from "react";
import { useAgent } from "../../store/agent";
import { UserBubble } from "./UserBubble";
import { AssistantBubble } from "./AssistantBubble";
import whatsubIcon from "../../assets/whatsub-icon.png";

interface Props {
  /** True if a runtime turn is currently in flight; used to mark the last assistant
   *  message as still streaming (cursor visible). */
  streamingMsgId?: string | null;
  /** Turn in flight but no text streaming yet → model is thinking. Shows an
   *  animated loading row instead of a static wait. */
  thinking?: boolean;
  /** Whole runtime turn in flight (streaming OR executing tools). Threaded to
   *  tool_call cards so they spin during execution, not just during streaming. */
  turnInFlight?: boolean;
}

export function MessageList({ streamingMsgId, thinking, turnInFlight }: Props) {
  const history = useAgent((s) => s.history);
  const activeConv = history.conversations.find(
    (c) => c.id === history.activeConversationId,
  );
  const messages = activeConv?.messages ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);

  // Group a whole assistant turn — its 1+ assistant messages (one per ReAct
  // iteration) plus interleaved tool messages — under a SINGLE avatar: only the
  // first assistant message after a user message shows the avatar; later ones
  // in the same turn render a spacer. So a tool-using answer reads as ONE reply,
  // not several stacked avatars. `currentTurnHasAvatar` does the same for the
  // trailing ThinkingBubble (a continuation, not a new turn).
  const { avatarMsgIds, currentTurnHasAvatar } = useMemo(() => {
    const ids = new Set<string>();
    let turnHasAvatar = false;
    for (const m of messages) {
      if (m.role === "user") {
        turnHasAvatar = false;
      } else if (m.role === "assistant" && !turnHasAvatar) {
        ids.add(m.id);
        turnHasAvatar = true;
      }
    }
    return { avatarMsgIds: ids, currentTurnHasAvatar: turnHasAvatar };
  }, [messages]);

  // Auto-scroll to bottom on new message OR when the thinking loader appears.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, thinking]);

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
              turnInFlight={turnInFlight}
              showAvatar={avatarMsgIds.has(m.id)}
            />
          );
        }
        // role === "tool" → skipped; T23 will render via ToolCallCard
        return null;
      })}
      {thinking && <ThinkingBubble showAvatar={!currentTurnHasAvatar} />}
    </div>
  );
}

/** Loading row shown while the model is thinking (no text streaming yet):
 *  the whatsub avatar + three bouncing dots. Mirrors AssistantBubble's layout
 *  so it reads as "the reply is on its way". `showAvatar` is false when this is
 *  a continuation of an assistant turn that already showed its avatar. */
function ThinkingBubble({ showAvatar = true }: { showAvatar?: boolean }) {
  return (
    <div className="flex gap-3 mb-4 px-4">
      <div className="shrink-0 mt-0.5">
        {showAvatar ? (
          <div className="h-6 w-6 grid place-items-center rounded-full ring-1 ring-zinc-700 bg-zinc-900 overflow-hidden">
            <img src={whatsubIcon} alt="" width={20} height={20} className="rounded-full" draggable={false} />
          </div>
        ) : (
          <div className="h-6 w-6" aria-hidden />
        )}
      </div>
      <div className="flex items-center gap-1 mt-2.5">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: "0ms" }} />
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: "150ms" }} />
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: "300ms" }} />
      </div>
    </div>
  );
}
