import { NavLink } from 'react-router-dom';

interface Props {
  onRefresh?: () => void;
  refreshing?: boolean;
}

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 text-sm rounded ${
    isActive
      ? 'bg-zinc-800 text-zinc-100'
      : 'text-zinc-400 hover:text-zinc-200'
  }`;

export function CorpusNav({ onRefresh, refreshing }: Props) {
  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-950">
      <nav className="flex gap-2">
        <NavLink to="/library" className={linkClass}>
          字幕本
        </NavLink>
        <NavLink to="/corpus" className={linkClass}>
          📚 语料库
        </NavLink>
        <NavLink to="/settings" className={linkClass}>
          ⚙ 设置
        </NavLink>
      </nav>
      {onRefresh && (
        <button
          onClick={onRefresh}
          disabled={refreshing}
          title="刷新语料库"
          className="px-2 py-1 text-sm text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
        >
          {refreshing ? '↻ 刷新中…' : '↻'}
        </button>
      )}
    </header>
  );
}
