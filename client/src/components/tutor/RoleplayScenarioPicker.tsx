import type { RoleplayScenario } from "../../tutor/types";

interface Props {
  scenarios: RoleplayScenario[];
  loading?: boolean;
  onPick: (s: RoleplayScenario) => void;
  onCancel: () => void;
}

function stars(d: 1 | 2 | 3): string {
  return "★".repeat(d);
}

export function RoleplayScenarioPicker({
  scenarios,
  loading,
  onPick,
  onCancel,
}: Props) {
  return (
    <div className="bg-zinc-900/80 backdrop-blur-2xl ring-1 ring-white/10 rounded-2xl shadow-2xl shadow-black/40 w-full max-w-[560px] p-7 text-zinc-100">
      <div className="text-xs text-zinc-500 uppercase tracking-wider mb-2">角色扮演</div>
      <div className="text-base text-zinc-100 mb-5">挑一个场景开始</div>

      {loading && scenarios.length === 0 && (
        <div className="text-sm text-zinc-500 py-6 text-center">
          正在生成场景…
        </div>
      )}

      <div className="space-y-2 mb-5">
        {scenarios.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(s)}
            className="w-full text-left px-4 py-3 rounded-md bg-white/5 hover:bg-white/10 transition-colors"
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
          className="px-4 py-2 rounded-md text-sm text-zinc-300 hover:bg-white/5"
        >
          取消
        </button>
      </div>
    </div>
  );
}
