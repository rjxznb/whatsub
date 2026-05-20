import { useCorpusTags, type TagScope } from '../hooks/useCorpusTags';

// 18 scenes in canonical order — used to pin official scene tags to the
// front of the chip row so the visual ordering matches the rest of the
// product (which still talks about scenes in copy). User-/curator-added
// tags fall to the right of these in count-desc / tag-asc order.
const SCENE_ORDER = [
  'immigration', 'housing', 'medical', 'campus', 'banking',
  'shopping', 'transport', 'social', 'dining', 'emergency',
  'job', 'phone', 'salon', 'driving', 'travel',
  'fitness', 'mental_health', 'maintenance',
] as const;

const SCENE_LABELS: Record<string, string> = {
  immigration: '入境通关', housing: '住房安家', medical: '医疗健康',
  campus: '校园学习', banking: '银行财务', shopping: '日常购物',
  transport: '交通出行', social: '社交日常', dining: '餐饮',
  emergency: '紧急情况', job: '求职职场', phone: '电话沟通',
  salon: '美容美发', driving: '驾照开车', travel: '旅游度假',
  fitness: '运动健身', mental_health: '心理健康', maintenance: '搬家维修',
};

function labelFor(tag: string): string {
  return SCENE_LABELS[tag] ?? tag;
}

interface Props {
  scope: TagScope;
  selected: string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
  invalidateNonce: number;
}

export function CorpusTagChips({ scope, selected, onToggle, onClear, invalidateNonce }: Props) {
  const { tags, loading } = useCorpusTags(scope, invalidateNonce);

  // Split: official scene tags first (in canonical order), then everything
  // else as the server returned them (already count-desc / tag-asc).
  const sceneSet = new Set<string>(SCENE_ORDER);
  const byTag = new Map(tags.map((t) => [t.tag, t.count]));
  const scenes = SCENE_ORDER
    .filter((s) => byTag.has(s))
    .map((s) => ({ tag: s, count: byTag.get(s)! }));
  const extras = tags.filter((t) => !sceneSet.has(t.tag));

  const isSel = (t: string) => selected.includes(t);

  function chip(t: { tag: string; count: number }, key: string) {
    const active = isSel(t.tag);
    return (
      <button
        key={key}
        onClick={() => onToggle(t.tag)}
        className={
          'px-2.5 py-1 text-xs rounded-full border transition-colors ' +
          (active
            ? 'bg-amber-400/20 border-amber-400/60 text-amber-200'
            : 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-zinc-600')
        }
      >
        {labelFor(t.tag)}
        <span className="ml-1.5 text-[10px] text-zinc-500">{t.count}</span>
      </button>
    );
  }

  if (loading && tags.length === 0) {
    return (
      <div className="px-4 py-2 text-xs text-zinc-500 border-b border-zinc-800">
        正在加载标签…
      </div>
    );
  }

  if (tags.length === 0) {
    return (
      <div className="px-4 py-2 text-xs text-zinc-500 border-b border-zinc-800">
        {scope === 'public' ? '公共语料库暂无标签' : '你还没有给任何短语打过标签'}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 border-b border-zinc-800">
      {scenes.map((t) => chip(t, `s-${t.tag}`))}
      {extras.length > 0 && scenes.length > 0 && (
        <span className="mx-1 h-4 w-px bg-zinc-800" aria-hidden />
      )}
      {extras.map((t) => chip(t, `x-${t.tag}`))}
      {selected.length > 0 && (
        <button
          onClick={onClear}
          className="ml-2 px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300"
          title="清除所有选中"
        >
          清除 ({selected.length})
        </button>
      )}
    </div>
  );
}
