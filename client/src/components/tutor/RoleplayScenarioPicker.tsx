import { Loader2, RefreshCw } from "lucide-react";
import type { RoleplayScenario } from "../../tutor/types";
import { TUTOR_CARD, TUTOR_EYEBROW, BTN_GHOST } from "./styles";

interface Props {
  scenarios: RoleplayScenario[];
  loading?: boolean;
  onPick: (s: RoleplayScenario) => void;
  onCancel: () => void;
  /** Re-derive a fresh batch (clears the cached scenarios for this video). */
  onRefresh?: () => void;
}

function stars(d: 1 | 2 | 3): string {
  return "★".repeat(d);
}

export function RoleplayScenarioPicker({
  scenarios,
  loading,
  onPick,
  onCancel,
  onRefresh,
}: Props) {
  return (
    <div className={`${TUTOR_CARD} w-full max-w-[560px] p-7`}>
      <div className={`${TUTOR_EYEBROW} mb-2`}>角色扮演</div>
      <div className="mb-5 flex items-center justify-between">
        <div className="text-base text-zinc-100">挑一个场景开始</div>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            title="换一批场景"
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 transition-colors hover:text-amber-300 disabled:opacity-40"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            换一批
          </button>
        )}
      </div>

      {loading && scenarios.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-zinc-400">
          <Loader2 size={22} className="animate-spin text-amber-400" />
          <span className="text-sm">正在生成场景…</span>
        </div>
      )}

      <div className="space-y-2 mb-5">
        {scenarios.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(s)}
            className="w-full text-left px-4 py-3 rounded-md bg-zinc-800 hover:bg-zinc-700 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div className="text-sm text-zinc-100">{s.title}</div>
              <div className="text-xs text-amber-400">{stars(s.difficulty)}</div>
            </div>
            {s.setup && (
              <div className="text-xs text-zinc-500 mt-1">{s.setup}</div>
            )}
          </button>
        ))}
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onCancel}
          className={BTN_GHOST}
        >
          取消
        </button>
      </div>
    </div>
  );
}
