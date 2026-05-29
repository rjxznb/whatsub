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
 * tool calls. Clicking 确认/取消 resolves the corresponding Promise in the
 * `useAgentConfirms` store, which unblocks the agent runtime's await on
 * `opts.confirm(...)`.
 */
export function InlineConfirmCard({ pending }: Props) {
  const resolveOne = useAgentConfirms((s) => s.resolveOne);
  return (
    <div className="mx-2 my-2 p-3 bg-amber-500/10 border border-amber-500/40 rounded-lg text-sm">
      <div className="text-amber-200 mb-2">⚠ 请确认</div>
      <div className="text-zinc-300 mb-2 text-xs">
        即将调用：
        <span className="font-mono text-zinc-100">{pending.toolDef.id}</span>
      </div>
      <pre className="bg-zinc-900 rounded p-2 text-[10px] text-zinc-400 overflow-x-auto mb-3">
{summarizeArgsForDisplay(pending.toolDef.id, pending.args)}
      </pre>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => resolveOne(pending.id, "no_user_clicked")}
          className="px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 rounded"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => resolveOne(pending.id, "yes")}
          className="px-3 py-1 text-xs font-medium bg-amber-500 hover:bg-amber-400 text-zinc-900 rounded"
        >
          确认
        </button>
      </div>
    </div>
  );
}
