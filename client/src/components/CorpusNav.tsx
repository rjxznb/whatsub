import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

interface Props {
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function CorpusNav({ onRefresh, refreshing }: Props) {
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
