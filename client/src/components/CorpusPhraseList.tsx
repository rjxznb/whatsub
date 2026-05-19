import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface PublicItem {
  phraseNormalized: string;
  phraseRaw: string;
  meaningZh: string | null;
  tags: { scene?: string };
}

interface MineItem {
  phraseNormalized: string;
  phraseRaw: string;
  meaningZh: string | null;
}

interface Props {
  /** scene key for public list, or null for "我的" personal corpus */
  scene: string | null;
  selected: string | null;
  onSelect: (phraseNormalized: string) => void;
}

export function CorpusPhraseList({ scene, selected, onSelect }: Props) {
  const [items, setItems] = useState<Array<PublicItem | MineItem>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setItems([]);
    (async () => {
      try {
        if (scene === null) {
          const r = await invoke<{ items: MineItem[] }>('corpus_mine', { pageSize: 100 });
          if (!cancelled) setItems(r.items);
        } else {
          const r = await invoke<{ items: PublicItem[] }>('corpus_browse', { scene, pageSize: 100 });
          if (!cancelled) setItems(r.items);
        }
      } catch (e) {
        const msg = String(e);
        if (!cancelled) setError(msg === 'license_required' ? '需购买后可见' : '加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scene]);

  if (loading) return <div className="p-4 text-zinc-500 text-sm w-64 border-r border-zinc-800">加载中…</div>;
  if (error) return <div className="p-4 text-red-400 text-sm w-64 border-r border-zinc-800">{error}</div>;
  if (items.length === 0) return <div className="p-4 text-zinc-500 text-sm w-64 border-r border-zinc-800">暂无</div>;

  return (
    <ul className="w-64 border-r border-zinc-800 overflow-y-auto min-w-0">
      {items.map((item) => (
        <li
          key={item.phraseNormalized}
          onClick={() => onSelect(item.phraseNormalized)}
          className={`px-3 py-2 cursor-pointer hover:bg-zinc-800
            ${selected === item.phraseNormalized ? 'bg-zinc-800' : ''}`}
        >
          <div className="text-sm font-medium">{item.phraseRaw}</div>
          {item.meaningZh && (
            <div className="text-xs text-zinc-400 truncate">{item.meaningZh}</div>
          )}
        </li>
      ))}
    </ul>
  );
}
