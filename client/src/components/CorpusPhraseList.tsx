import { useEffect, useState } from 'react';
import { useCorpusList } from '../hooks/useCorpusList';
import { corpusQuota, type Quota } from '../lib/api/quota';

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
  /** When true, the first item in the list is auto-selected as soon as
   *  data arrives and nothing else is already selected. Caller passes
   *  this only on the currently-visible list so we don't auto-select on
   *  the parked sibling. */
  autoSelectFirst?: boolean;
}

export function CorpusPhraseList({ mode, tags, selected, onSelect, autoSelectFirst }: Props) {
  const { data, error, refreshing } = useCorpusList<BrowseResp | MineResp>(
    mode === 'mine' ? { mode: 'mine', tags } : { mode: 'browse', tags },
  );
  const isMine = mode === 'mine';

  // Server-authoritative personal-corpus quota (used/limit). Only fetched for
  // the 'mine' list; best-effort (a failure just hides the badge). Refetched
  // whenever the list data changes so the count tracks plugin-side saves after
  // a refresh. limit = hasActiveSubscription ? 1000 : 50, so it reflects
  // cross-platform (Alipay/web) subscriptions, not just a local guess.
  const [quota, setQuota] = useState<Quota | null>(null);
  useEffect(() => {
    if (!isMine) return;
    let cancelled = false;
    corpusQuota()
      .then((q) => { if (!cancelled) setQuota(q); })
      .catch(() => { /* keep prior value / stay hidden */ });
    return () => { cancelled = true; };
  }, [isMine, data]);

  // Auto-select the first phrase when entering the page or when the active
  // list refreshes — so users don't land on a blank detail panel.
  useEffect(() => {
    if (!autoSelectFirst || selected) return;
    const items = data?.items;
    if (items && items.length > 0) {
      onSelect(items[0].phraseNormalized);
    }
  }, [autoSelectFirst, selected, data, onSelect]);

  const header = isMine ? (
    <div
      className="px-3 py-2 border-b border-zinc-800 text-xs text-zinc-400 shrink-0"
      title="个人语料库额度（订阅 1000 / 免费 50）"
    >
      个人语料{' '}
      {quota ? (
        <span className={quota.used >= quota.limit ? 'text-amber-300 font-medium' : 'text-zinc-200'}>
          {quota.used}/{quota.limit}
        </span>
      ) : (
        '…'
      )}
    </div>
  ) : null;

  function renderBody() {
    if (error && !data) {
      return <div className="p-4 text-red-300 text-xs break-all">加载失败：{error}</div>;
    }
    if (!data) {
      return <div className="p-4 text-zinc-500 text-sm">{refreshing ? '加载中…' : '初始化…'}</div>;
    }
    if (data.items.length === 0) {
      return <div className="p-4 text-zinc-500 text-sm">暂无</div>;
    }
    return (
      <ul>
        {data.items.map((item) => (
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

  return (
    <div className="w-64 h-full border-r border-zinc-800 flex flex-col min-w-0">
      {header}
      <div className="flex-1 overflow-y-auto min-w-0">{renderBody()}</div>
    </div>
  );
}
