import { useAgentConfirms } from "../../store/agentConfirms";
import { InlineConfirmCard } from "./InlineConfirmCard";

/**
 * Renders one InlineConfirmCard per MID-risk pending confirm. Mounted by
 * ChatPanel between MessageList and InputBox so that pending confirmations
 * appear at the bottom of the thread, right above where the user is typing.
 *
 * HIGH-risk confirms are intentionally NOT rendered inline — they surface
 * via the Tauri plugin-dialog system modal (see `confirmViaUI`).
 */
export function InlineConfirmList() {
  const pending = useAgentConfirms((s) => s.pending);
  if (pending.length === 0) return null;
  const midOnly = pending.filter((p) => p.tier === "MID");
  if (midOnly.length === 0) return null;
  return (
    <div>
      {midOnly.map((p) => (
        <InlineConfirmCard key={p.id} pending={p} />
      ))}
    </div>
  );
}
