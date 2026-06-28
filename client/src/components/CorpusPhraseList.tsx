import { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, List, Layers, Tags, Film, ChevronDown } from 'lucide-react';
import { useCorpusList } from '../hooks/useCorpusList';
import { corpusQuota, type Quota } from '../lib/api/quota';
import { corpusDelete } from '../lib/api/corpus';
import { confirmDialog, notify } from '../store/appDialog';
import { AddCorpusPhraseDialog } from './AddCorpusPhraseDialog';

interface MineSource {
  kind?: string;
  url?: string;
  title?: string;
  libraryEntryId?: string;
  youtubeId?: string;
}

interface MineItem {
  /** corpus_contributions.id — for per-row delete. */
  id: number;
  phraseNormalized: string;
  phraseRaw: string;
  meaningZh: string | null;
  tags?: string[];
  /** Where the phrase was saved from (drives the 按来源 grouping). */
  source?: MineSource;
}

// ── 按来源 grouping (mirrors the mobile GroupedMineView) ──────────────────────
const LAYOUT_KEY = 'corpus.mine.layout';
// Public list has three arrangements: flat / by video source / by scene-tag.
export type BrowseLayout = 'flat' | 'source' | 'tag';
const BROWSE_LAYOUT_KEY = 'corpus.browse.layout';

function hostOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Extract the YouTube video id from a watch / youtu.be URL, so phrases from
 *  the SAME video group together. Curator sources carry only `url` (no
 *  `youtubeId` field), so without this every YouTube phrase collapsed into one
 *  `url:youtube.com` bucket. */
function ytIdOf(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1) || null;
    if (host.endsWith('youtube.com')) return u.searchParams.get('v');
    return null;
  } catch {
    return null;
  }
}

/** Stable group key: Library entry → YouTube video → URL host → "manual".
 *  YouTube is keyed by the individual video id (one group per video). */
function groupKey(s?: MineSource): string {
  if (s?.libraryEntryId) return `lib:${s.libraryEntryId}`;
  if (s?.youtubeId) return `yt:${s.youtubeId}`;
  const yid = ytIdOf(s?.url);
  if (yid) return `yt:${yid}`;
  const h = hostOf(s?.url);
  if (h) return `url:${h}`;
  return 'manual';
}

function groupTitle(s: MineSource | undefined, key: string): string {
  if (s?.title) return s.title;
  if (key.startsWith('lib:')) return '库内视频';
  // No title on curator sources — show the video id so each video is distinct.
  if (key.startsWith('yt:')) return `YouTube · ${key.slice(3)}`;
  if (key.startsWith('url:')) return key.slice(4);
  return '手动添加';
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
  /** Browse-only: in 按视频来源 the list becomes a source picker; clicking a row
   *  calls this with that source's GROUP KEY (yt:<id> | url:<host> | lib:<id> |
   *  manual) so the parent shows the source detail (player for videos, plain
   *  phrase list otherwise). */
  onSelectSource?: (sourceKey: string) => void;
  /** Browse-only: highlights the selected source row. */
  selectedSource?: string | null;
  /** Browse-only: notify the parent of the current layout (fires on mount + on
   *  every change) so it can choose the right detail panel. */
  onLayoutChange?: (layout: BrowseLayout) => void;
}

export function CorpusPhraseList({
  mode,
  tags,
  selected,
  onSelect,
  autoSelectFirst,
  onSelectSource,
  selectedSource,
  onLayoutChange,
}: Props) {
  const { data, error, refreshing, refresh } = useCorpusList<BrowseResp | MineResp>(
    mode === 'mine' ? { mode: 'mine', tags } : { mode: 'browse', tags },
  );
  const isMine = mode === 'mine';
  const [addOpen, setAddOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  // Unified layout for BOTH lists: 平铺 / 按视频来源 / 按场景标签. Persisted per
  // scope (mine vs browse). The legacy mine value 'grouped' migrates to 'source'.
  const layoutKey = isMine ? LAYOUT_KEY : BROWSE_LAYOUT_KEY;
  const [layout, setLayout] = useState<BrowseLayout>(() => {
    try {
      const raw = localStorage.getItem(layoutKey);
      if (raw === 'grouped') return 'source';
      return (raw as BrowseLayout) ?? 'flat';
    } catch {
      return 'flat';
    }
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const setLayoutPersist = (l: BrowseLayout) => {
    setLayout(l);
    try {
      localStorage.setItem(layoutKey, l);
    } catch {
      /* ignore */
    }
  };

  const handleDelete = async (item: MineItem) => {
    if (deletingId !== null) return;
    // No id → the app is running an older build whose corpus_mine doesn't carry
    // the contribution id yet. Guard so we don't POST .../contribute/undefined.
    if (!item.id || item.id <= 0) {
      void notify('删除需要更新后的版本：请重启应用（重新编译）后再试。');
      return;
    }
    const ok = await confirmDialog(`从个人语料库删除「${item.phraseRaw}」？`, {
      title: '删除语料',
      okText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    setDeletingId(item.id);
    try {
      await corpusDelete(item.id);
      if (selected === item.phraseNormalized) onSelect('');
      refresh();
    } catch (e) {
      void notify(`删除失败：${String(e)}`);
    } finally {
      setDeletingId(null);
    }
  };

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

  // Tell the parent which browse layout is active (so it can pick the phrase-
  // detail vs the video-detail panel). Fires on mount + every change.
  useEffect(() => {
    onLayoutChange?.(layout);
  }, [layout, onLayoutChange]);

  // Auto-select on entering the page / refresh so users don't land on a blank
  // detail panel. In 按视频来源 we auto-select the first VIDEO, otherwise the
  // first phrase.
  useEffect(() => {
    if (!autoSelectFirst) return;
    const items = data?.items;
    if (!items || items.length === 0) return;
    if (layout === 'source') {
      if (selectedSource) return;
      onSelectSource?.(groupKey((items[0] as MineItem).source));
      return;
    }
    if (selected) return;
    onSelect(items[0].phraseNormalized);
  }, [
    autoSelectFirst,
    selected,
    selectedSource,
    layout,
    data,
    onSelect,
    onSelectSource,
  ]);

  const quotaFull = quota ? quota.used >= quota.limit : false;
  const header = isMine ? (
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-zinc-800 text-xs text-zinc-400 shrink-0">
      <span title="个人语料库额度（订阅 1000 / 免费 50）">
        个人语料{' '}
        {quota ? (
          <span className={quotaFull ? 'text-amber-300 font-medium' : 'text-zinc-200'}>
            {quota.used}/{quota.limit}
          </span>
        ) : (
          '…'
        )}
      </span>
      <div className="flex items-center gap-1">
        {/* Layout: 平铺 / 按视频来源 / 按场景标签 (same as the public list). */}
        <div className="flex items-center rounded bg-zinc-800/60 p-0.5">
          <button
            type="button"
            onClick={() => setLayoutPersist('flat')}
            title="平铺：每条短语一行"
            className={'grid h-5 w-5 place-items-center rounded ' + (layout === 'flat' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
          >
            <List size={12} />
          </button>
          <button
            type="button"
            onClick={() => setLayoutPersist('source')}
            title="按视频来源分组"
            className={'grid h-5 w-5 place-items-center rounded ' + (layout === 'source' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
          >
            <Layers size={12} />
          </button>
          <button
            type="button"
            onClick={() => setLayoutPersist('tag')}
            title="按场景 / 标签分组"
            className={'grid h-5 w-5 place-items-center rounded ' + (layout === 'tag' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
          >
            <Tags size={12} />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          disabled={quotaFull}
          title={quotaFull ? '额度已满，无法添加' : '添加短语到个人语料库'}
          className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-zinc-300 hover:bg-white/5 hover:text-zinc-100 transition-colors disabled:opacity-40"
        >
          <Plus size={13} /> 添加
        </button>
      </div>
    </div>
  ) : (
    <div className="flex items-center justify-end gap-2 px-3 py-2 border-b border-zinc-800 text-xs text-zinc-400 shrink-0">
      {/* Layout: 平铺 (flat) / 按视频来源 (source) / 按场景标签 (tag). */}
      <div className="flex items-center rounded bg-zinc-800/60 p-0.5">
        <button
          type="button"
          onClick={() => setLayoutPersist('flat')}
          title="平铺：每条短语一行"
          className={'grid h-5 w-5 place-items-center rounded ' + (layout === 'flat' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
        >
          <List size={12} />
        </button>
        <button
          type="button"
          onClick={() => setLayoutPersist('source')}
          title="按视频来源分组"
          className={'grid h-5 w-5 place-items-center rounded ' + (layout === 'source' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
        >
          <Layers size={12} />
        </button>
        <button
          type="button"
          onClick={() => setLayoutPersist('tag')}
          title="按场景 / 标签分组"
          className={'grid h-5 w-5 place-items-center rounded ' + (layout === 'tag' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
        >
          <Tags size={12} />
        </button>
      </div>
    </div>
  );

  const toggleGroup = (k: string) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  function renderRow(item: MineItem | PublicItem, idx: number) {
    // mine rows can share a phraseNormalized (duplicate uploads) → key by id.
    const key = isMine ? `${(item as MineItem).id}-${idx}` : item.phraseNormalized;
    return (
      <li
        key={key}
        onClick={() => onSelect(item.phraseNormalized)}
        className={`group relative px-3 py-2 cursor-pointer hover:bg-zinc-800 ${
          selected === item.phraseNormalized ? 'bg-zinc-800' : ''
        }`}
      >
        <div className="text-sm font-medium pr-6">{item.phraseRaw}</div>
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
        {isMine && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handleDelete(item as MineItem);
            }}
            disabled={deletingId !== null}
            title="从个人语料库删除"
            className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-zinc-500 opacity-0 group-hover:opacity-100 hover:bg-red-900/30 hover:text-red-300 transition-colors disabled:opacity-40"
          >
            {deletingId === (item as MineItem).id ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Trash2 size={13} />
            )}
          </button>
        )}
      </li>
    );
  }

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

    // 「按视频来源」：每个来源一行的选择器；点击 → 父组件展示该视频的播放器 + 该
    // 视频下所有语料（带时间戳跳转），而不是每条语料各自一个播放器。公共/我的通用。
    if (layout === 'source') {
      const order: string[] = [];
      const buckets = new Map<string, PublicItem[]>();
      for (const it of data.items as PublicItem[]) {
        const k = groupKey(it.source);
        if (!buckets.has(k)) {
          buckets.set(k, []);
          order.push(k);
        }
        buckets.get(k)!.push(it);
      }
      return (
        <ul>
          {order.map((k) => {
            const grp = buckets.get(k)!;
            const isSel = selectedSource === k;
            return (
              <li
                key={k}
                onClick={() => onSelectSource?.(k)}
                className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-zinc-800 ${
                  isSel ? 'bg-zinc-800' : ''
                }`}
              >
                <Film size={14} className="shrink-0 text-zinc-500" />
                <span className="flex-1 truncate text-sm text-zinc-200">
                  {groupTitle(grp[0].source, k)}
                </span>
                <span className="text-[11px] text-zinc-500 shrink-0">{grp.length}</span>
              </li>
            );
          })}
        </ul>
      );
    }

    // 按标签分组：一条短语出现在它的每个标签下；组按「条数多→少、同条数按字母」
    // 排序，无标签的归到「未分类」。公共/我的通用。标签是自由文本，不再有场景概念。
    if (layout === 'tag') {
      const buckets = new Map<string, PublicItem[]>();
      const untagged: PublicItem[] = [];
      for (const it of data.items as PublicItem[]) {
        const itags = it.tags ?? [];
        if (itags.length === 0) {
          untagged.push(it);
          continue;
        }
        for (const t of itags) {
          if (!buckets.has(t)) buckets.set(t, []);
          buckets.get(t)!.push(it);
        }
      }
      const order = [...buckets.keys()].sort(
        (a, b) => buckets.get(b)!.length - buckets.get(a)!.length || a.localeCompare(b),
      );
      const renderGroup = (k: string, title: string, grp: PublicItem[]) => {
        const isCollapsed = collapsed.has(k);
        return (
          <div key={k}>
            <button
              type="button"
              onClick={() => toggleGroup(k)}
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-zinc-400 hover:bg-zinc-800/60 border-b border-zinc-800/60"
            >
              <ChevronDown size={12} className={isCollapsed ? '-rotate-90 transition-transform' : 'transition-transform'} />
              <span className="flex-1 truncate text-zinc-300">{title}</span>
              <span className="text-zinc-500">{grp.length}</span>
            </button>
            {!isCollapsed && <ul>{grp.map((it, i) => renderRow(it, i))}</ul>}
          </div>
        );
      };
      return (
        <div>
          {order.map((t) => renderGroup(`tag:${t}`, t, buckets.get(t)!))}
          {untagged.length > 0 && renderGroup('tag:__untagged', '未分类', untagged)}
        </div>
      );
    }

    return <ul>{data.items.map((it, i) => renderRow(it, i))}</ul>;
  }

  return (
    <div className="w-64 h-full border-r border-zinc-800 flex flex-col min-w-0">
      {header}
      <div className="flex-1 overflow-y-auto min-w-0">{renderBody()}</div>
      {addOpen && (
        <AddCorpusPhraseDialog
          quotaFull={quotaFull}
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            refresh(); // refetch the mine list (quota refetches via the data effect)
          }}
        />
      )}
    </div>
  );
}
