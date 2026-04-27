import type { RoleSetup } from "../llm/types";

interface Props {
  role: RoleSetup | null;
  sceneContext: string;
}

export function RoleSetupCard({ role, sceneContext }: Props) {
  if (!role) {
    return <div className="p-4 text-zinc-500 text-sm">分析完成后这里会显示角色信息...</div>;
  }
  return (
    <div className="p-4 space-y-4">
      <section>
        <div className="text-zinc-500 text-[10px] uppercase tracking-wide">场景</div>
        <div className="text-zinc-200 text-sm leading-relaxed mt-1">{sceneContext}</div>
      </section>
      <section className="border border-zinc-800 rounded-md p-3 bg-zinc-900/40">
        <div className="text-amber-300 font-semibold">{role.name}</div>
        <div className="text-zinc-400 text-xs mt-1">{role.identity}</div>
        <div className="text-zinc-500 text-[10px] mt-2">性格</div>
        <div className="text-zinc-200 text-xs">{role.personality}</div>
        <div className="text-zinc-500 text-[10px] mt-2">口音</div>
        <div className="text-zinc-200 text-xs">{role.accent}</div>
      </section>
    </div>
  );
}
