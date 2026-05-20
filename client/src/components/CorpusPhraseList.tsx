import { useCorpusList } from '../hooks/useCorpusList';

interface MineItem {
  phraseNormalized: string;
  phraseRaw: string;
  meaningZh: string | null;
  tags?: string[];
}
interface PublicItem extends MineItem {
  tags?: string[];
  /** Phase-D mirror — older rows may still only carry the legacy shape. */
}

interface BrowseResp { items: PublicItem[] }
interface MineResp   { items: MineItem[] }

interface Props {
  /** 'mine' shows the user's personal saves filtered by per-contribution
   *  tags; 'browse' shows public corpus filtered by per-phrase tags.list.
   *  Both modes AND-intersect on every tag in `tags`. */
  mode: 'mine' | 'browse';
  tags: string[];
  selected: string | null;
  onSelect: (phraseNormalized: string) => void;
}

export function CorpusPhraseList({ mode, tags, selected, onSelect }: Props) {
  const { data, error, refreshing } = useCorpusList<BrowseResp | MineResp>(
    mode === 'mine' ? { mode: 'mine', tags } : { mode: 'browse', tags },
  );

  if (error && !data) {
    return (
      <div className="p-4 text-red-300 text-xs w-64 h-full border-r border-zinc-800 break-all">
        加载失败：{error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-4 text-zinc-500 text-sm w-64 h-full border-r border-zinc-800">
        {refreshing ? '加载中…' : '初始化…'}
      </div>
    );
  }
  const items = data.items;
  if (items.length === 0) {
    return (
      <div className="p-4 text-zinc-500 text-sm w-64 h-full border-r border-zinc-800">暂无</div>
    );
  }

  return (
    <ul className="w-64 h-full border-r border-zinc-800 overflow-y-auto min-w-0">
      {items.map((item) => (
        <li
          key={item.phraseNormalized}
          onClick={() => onSelect(item.phraseNormalized)}
          className={`px-3 py-2 cursor-pointer hover:bg-zinc-800 ${
            selected === item.phraseNormalized ? 'bg-zinc-800' : ''
          }`}
        >
          <div className="text-sm font-medium">{item.phraseRaw}</div>
          {item.meaningZh && (
            <div className="text-xs text-zinc-400 truncate">{item.meaningZh}</div>
          )}
          {item.tags && item.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {item.tags.map((t) => (
                <span key={t} className="px-1.5 py-0.5 text-[10px] rounded-full bg-amber-400/15 border border-amber-400/40 text-amber-200">
                  {t}
                </span>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
