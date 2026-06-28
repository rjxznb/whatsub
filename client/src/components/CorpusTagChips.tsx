import { useCorpusTags, type TagScope } from '../hooks/useCorpusTags';

// Corpus tags are free-form (NOT the legacy 18-scene model — the 语料 is
// scene-independent). Render whatever the server returns, in its order
// (count-desc / tag-asc), with no special-cased "official scene" pinning.

interface Props {
  scope: TagScope;
  selected: string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
  invalidateNonce: number;
}

export function CorpusTagChips({ scope, selected, onToggle, onClear, invalidateNonce }: Props) {
  const { tags, loading } = useCorpusTags(scope, invalidateNonce);

  const isSel = (t: string) => selected.includes(t);

  function chip(t: { tag: string; count: number }) {
    const active = isSel(t.tag);
    return (
      <button
        key={t.tag}
        onClick={() => onToggle(t.tag)}
        className={
          'px-2.5 py-1 text-xs rounded-full border transition-colors ' +
          (active
            ? 'bg-amber-400/20 border-amber-400/60 text-amber-200'
            : 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-zinc-600')
        }
      >
        {t.tag}
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
      {tags.map((t) => chip(t))}
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
