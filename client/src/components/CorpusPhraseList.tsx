import { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, List, Layers, Tags, ChevronDown } from 'lucide-react';
import { SCENE_ORDER, SCENE_LABELS } from '../lib/scenes';
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
type MineLayout = 'flat' | 'grouped';
const LAYOUT_KEY = 'corpus.mine.layout';
// Public list has three arrangements: flat / by video source / by scene-tag.
type BrowseLayout = 'flat' | 'source' | 'tag';
const BROWSE_LAYOUT_KEY = 'corpus.browse.layout';

function hostOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Stable group key: Library entry → YouTube → URL host → "manual". */
function groupKey(s?: MineSource): string {
  if (s?.libraryEntryId) return `lib:${s.libraryEntryId}`;
  if (s?.youtubeId) return `yt:${s.youtubeId}`;
  const h = hostOf(s?.url);
  if (h) return `url:${h}`;
  return 'manual';
}

function groupTitle(s: MineSource | undefined, key: string): string {
  if (s?.title) return s.title;
  if (key.startsWith('lib:')) return '库内视频';
  if (key.startsWith('yt:')) return 'YouTube';
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
}

export function CorpusPhraseList({ mode, tags, selected, onSelect, autoSelectFirst }: Props) {
  const { data, error, refreshing, refresh } = useCorpusList<BrowseResp | MineResp>(
    mode === 'mine' ? { mode: 'mine', tags } : { mode: 'browse', tags },
  );
  const isMine = mode === 'mine';
  const [addOpen, setAddOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [layout, setLayout] = useState<MineLayout>(() => {
    try {
      return (localStorage.getItem(LAYOUT_KEY) as MineLayout) ?? 'flat';
    } catch {
      return 'flat';
    }
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const setMineLayout = (l: MineLayout) => {
    setLayout(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* ignore */
    }
  };
  const [browseLayout, setBrowseLayout] = useState<BrowseLayout>(() => {
    try {
      return (localStorage.getItem(BROWSE_LAYOUT_KEY) as BrowseLayout) ?? 'flat';
    } catch {
      return 'flat';
    }
  });
  const setBrowseLayoutPersist = (l: BrowseLayout) => {
    setBrowseLayout(l);
    try {
      localStorage.setItem(BROWSE_LAYOUT_KEY, l);
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

  // Auto-select the first phrase when entering the page or when the active
  // list refreshes — so users don't land on a blank detail panel.
  useEffect(() => {
    if (!autoSelectFirst || selected) return;
    const items = data?.items;
    if (items && items.length > 0) {
      onSelect(items[0].phraseNormalized);
    }
  }, [autoSelectFirst, selected, data, onSelect]);

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
        {/* Layout: 平铺 (flat) vs 按来源分组 (grouped). */}
        <div className="flex items-center rounded bg-zinc-800/60 p-0.5">
          <button
            type="button"
            onClick={() => setMineLayout('flat')}
            title="平铺：每条短语一行"
            className={'grid h-5 w-5 place-items-center rounded ' + (layout === 'flat' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
          >
            <List size={12} />
          </button>
          <button
            type="button"
            onClick={() => setMineLayout('grouped')}
            title="按来源分组"
            className={'grid h-5 w-5 place-items-center rounded ' + (layout === 'grouped' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
          >
            <Layers size={12} />
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
          onClick={() => setBrowseLayoutPersist('flat')}
          title="平铺：每条短语一行"
          className={'grid h-5 w-5 place-items-center rounded ' + (browseLayout === 'flat' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
        >
          <List size={12} />
        </button>
        <button
          type="button"
          onClick={() => setBrowseLayoutPersist('source')}
          title="按视频来源分组"
          className={'grid h-5 w-5 place-items-center rounded ' + (browseLayout === 'source' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
        >
          <Layers size={12} />
        </button>
        <button
          type="button"
          onClick={() => setBrowseLayoutPersist('tag')}
          title="按场景 / 标签分组"
          className={'grid h-5 w-5 place-items-center rounded ' + (browseLayout === 'tag' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
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

    // 按来源分组（「我的」grouped 或 公共 source）：group key = libraryEntryId → youtubeId → host → manual.
    if ((isMine && layout === 'grouped') || (!isMine && browseLayout === 'source')) {
      const order: string[] = [];
      const buckets = new Map<string, MineItem[]>();
      for (const it of data.items as MineItem[]) {
        const k = groupKey(it.source);
        if (!buckets.has(k)) {
          buckets.set(k, []);
          order.push(k);
        }
        buckets.get(k)!.push(it);
      }
      return (
        <div>
          {order.map((k) => {
            const grp = buckets.get(k)!;
            const isCollapsed = collapsed.has(k);
            return (
              <div key={k}>
                <button
                  type="button"
                  onClick={() => toggleGroup(k)}
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-zinc-400 hover:bg-zinc-800/60 border-b border-zinc-800/60"
                >
                  <ChevronDown size={12} className={isCollapsed ? '-rotate-90 transition-transform' : 'transition-transform'} />
                  <span className="flex-1 truncate text-zinc-300">{groupTitle(grp[0].source, k)}</span>
                  <span className="text-zinc-500">{grp.length}</span>
                </button>
                {!isCollapsed && <ul>{grp.map((it, i) => renderRow(it, i))}</ul>}
              </div>
            );
          })}
        </div>
      );
    }

    // 按场景/标签分组（仅公共）：一条短语出现在它的每个标签下；18 个官方场景
    // 按 SCENE_ORDER 在前，自定义标签按字母在后，无标签的归到「未分类」。
    if (!isMine && browseLayout === 'tag') {
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
      const officialSet = SCENE_ORDER as readonly string[];
      const official = SCENE_ORDER.filter((s) => buckets.has(s));
      const custom = [...buckets.keys()].filter((t) => !officialSet.includes(t)).sort();
      const order = [...official, ...custom];
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
          {order.map((t) => renderGroup(`tag:${t}`, SCENE_LABELS[t] ?? t, buckets.get(t)!))}
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
