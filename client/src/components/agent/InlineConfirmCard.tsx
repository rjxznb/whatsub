import {
  useAgentConfirms,
  summarizeArgsForDisplay,
} from "../../store/agentConfirms";
import type { PendingConfirm } from "../../store/agentConfirms";

interface Props {
  /** A single MID-risk PendingConfirm awaiting a user click. */
  pending: PendingConfirm;
}

/**
 * Inline confirmation card rendered inside the chat thread for MID-risk
 * tool calls. Visual refresh 2026-05-30: subtle inset card (zinc-900/40 +
 * zinc-800 border) instead of the previous amber alert box. The primary
 * confirm button is high-contrast white-on-dark, matching Claude.ai's
 * send-button style.
 */
export function InlineConfirmCard({ pending }: Props) {
  const resolveOne = useAgentConfirms((s) => s.resolveOne);
  return (
    <div className="mx-2 mb-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="text-xs text-zinc-400 mb-1">请确认</div>
      <div className="text-xs text-zinc-500 mb-3">
        即将调用：
        <span className="font-mono text-zinc-300">{pending.toolDef.id}</span>
      </div>
      <pre className="bg-zinc-950 rounded p-2 text-[10px] text-zinc-400 overflow-x-auto mb-3">
{summarizeArgsForDisplay(pending.toolDef.id, pending.args)}
      </pre>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => resolveOne(pending.id, "no_user_clicked")}
          className="px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 rounded"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => resolveOne(pending.id, "yes")}
          className="px-3 py-1.5 text-xs font-medium bg-zinc-100 hover:bg-white text-zinc-900 rounded"
        >
          确认
        </button>
      </div>
    </div>
  );
}
