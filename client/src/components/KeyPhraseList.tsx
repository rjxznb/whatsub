import type { KeyPhrase } from "../llm/types";

interface Props {
  phrases: KeyPhrase[];
}

export function KeyPhraseList({ phrases }: Props) {
  if (phrases.length === 0) {
    return <div className="p-4 text-zinc-500 text-sm">分析完成后这里会显示重点短语...</div>;
  }
  return (
    <div className="overflow-y-auto h-full p-3 space-y-3">
      {phrases.map((p, i) => (
        <div key={i} className="border border-zinc-800 rounded-md p-3 bg-zinc-900/40">
          <div className="text-amber-300 font-semibold text-sm">{p.expression}</div>
          <div className="text-zinc-100 text-xs mt-1.5">{p.meaningZh}</div>
          <div className="text-zinc-400 text-xs mt-1 italic">{p.usage}</div>
        </div>
      ))}
    </div>
  );
}
