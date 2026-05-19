const SCENES: Array<{ key: string; label: string }> = [
  { key: 'immigration', label: '入境通关' },
  { key: 'housing', label: '住房安家' },
  { key: 'medical', label: '医疗健康' },
  { key: 'campus', label: '校园学习' },
  { key: 'banking', label: '银行财务' },
  { key: 'shopping', label: '日常购物' },
  { key: 'transport', label: '交通出行' },
  { key: 'social', label: '社交日常' },
  { key: 'dining', label: '餐饮' },
  { key: 'emergency', label: '紧急情况' },
  { key: 'job', label: '求职职场' },
  { key: 'phone', label: '电话沟通' },
  { key: 'salon', label: '美容美发' },
  { key: 'driving', label: '驾照开车' },
  { key: 'travel', label: '旅游度假' },
  { key: 'fitness', label: '运动健身' },
  { key: 'mental_health', label: '心理健康' },
  { key: 'maintenance', label: '搬家维修' },
];

interface Props {
  selected: string | null;
  onSelect: (scene: string | null) => void;
}

export function CorpusSceneTree({ selected, onSelect }: Props) {
  return (
    <nav className="w-48 border-r border-zinc-800 overflow-y-auto">
      <button
        onClick={() => onSelect(null)}
        className={`w-full text-left px-3 py-2 text-sm hover:bg-zinc-800
          ${selected === null ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'}`}
      >
        ⭐ 我的
      </button>
      <div className="border-t border-zinc-800 my-2" />
      <div className="text-xs text-zinc-500 px-3 py-1 uppercase">公共</div>
      {SCENES.map((s) => (
        <button
          key={s.key}
          onClick={() => onSelect(s.key)}
          className={`w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-800
            ${selected === s.key ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'}`}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}
