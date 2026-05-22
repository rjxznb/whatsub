import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RotateCw, Cloud, ChevronsLeft, ChevronsRight } from 'lucide-react';

type Mode = 'browse' | 'mine';

interface Props {
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Current scope. When provided alongside onModeChange, a segmented
   *  toggle renders in the header next to the refresh button. */
  mode?: Mode;
  onModeChange?: (m: Mode) => void;
  /** Opens the cloud-sync manager modal. When provided, a 「云同步详情」
   *  button renders in the collapsible right region. */
  onOpenCloudSync?: () => void;
}

export function CorpusNav({ onRefresh, refreshing, mode, onModeChange, onOpenCloudSync }: Props) {
  // Collapse toggle hides the cloud-sync button — mirrors Library's
  // navCollapsed. Persisted so the user's choice survives navigation.
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('corpusNavCollapsed') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('corpusNavCollapsed', navCollapsed ? '1' : '0');
    } catch {
      /* localStorage unavailable — harmless, resets next session */
    }
  }, [navCollapsed]);

  return (
    <header className="flex items-center gap-3 px-6 py-3 border-b border-zinc-800 bg-zinc-950">
      <Link
        to="/library"
        title="返回 Library"
        className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
      >
        <ArrowLeft className="h-5 w-5" />
      </Link>
      <h1 className="text-lg font-semibold flex-1">语料库</h1>
      {mode && onModeChange && (
        <div className="flex items-center gap-0.5 rounded-full bg-zinc-900 border border-zinc-800 p-0.5">
          {(['browse', 'mine'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className={
                'px-3 py-1 text-xs rounded-full transition-colors ' +
                (mode === m
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200')
              }
            >
              {m === 'browse' ? '公共' : '⭐ 我的'}
            </button>
          ))}
        </div>
      )}
      {onRefresh && (
        <button
          onClick={onRefresh}
          disabled={refreshing}
          title={refreshing ? '刷新中…' : '刷新语料库'}
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
        >
          <RotateCw className={'h-4 w-4 ' + (refreshing ? 'animate-spin' : '')} />
        </button>
      )}
      {onOpenCloudSync && (
        <>
          <button
            type="button"
            onClick={() => setNavCollapsed((v) => !v)}
            title={navCollapsed ? '展开' : '收起'}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
          >
            {navCollapsed ? (
              <ChevronsLeft className="h-4 w-4" />
            ) : (
              <ChevronsRight className="h-4 w-4" />
            )}
          </button>
          <div
            className={
              'flex items-center overflow-hidden transition-[max-width,opacity] duration-300 ease-out ' +
              (navCollapsed ? 'max-w-0 opacity-0' : 'max-w-[200px] opacity-100')
            }
          >
            <button
              onClick={onOpenCloudSync}
              className="inline-flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white px-2.5 py-1.5 rounded hover:bg-white/5 transition-colors whitespace-nowrap"
              title="管理云端同步的语料条目"
            >
              <Cloud className="h-4 w-4" />
              云同步详情
            </button>
          </div>
        </>
      )}
    </header>
  );
}
