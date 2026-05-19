import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { YouTubeEmbed, parseYouTubeUrl } from './YouTubeEmbed';

interface Contribution {
  id: number;
  contextSentence: string;
  source: { kind: string; url: string; title?: string; timestampSec?: number };
  contributedAt: number;
}

interface PhraseDetail {
  phrase: {
    phraseNormalized: string;
    phraseRaw: string;
    meaningZh: string | null;
    tags: Record<string, unknown>;
  };
  publicContributions: Contribution[];
  personalContributions: Contribution[];
}

interface Props {
  phraseNormalized: string | null;
}

export function CorpusPhraseDetail({ phraseNormalized }: Props) {
  const [detail, setDetail] = useState<PhraseDetail | null>(null);
  const [selectedInstance, setSelectedInstance] = useState<Contribution | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!phraseNormalized) { setDetail(null); setSelectedInstance(null); setError(''); return; }
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const r = await invoke<PhraseDetail>('corpus_phrase_detail', { phrase: phraseNormalized });
        if (cancelled) return;
        setDetail(r);
        const first = r.publicContributions[0] ?? r.personalContributions[0] ?? null;
        setSelectedInstance(first);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [phraseNormalized]);

  if (!phraseNormalized) {
    return <div className="flex-1 p-6 text-zinc-500">选择一个短语查看实例</div>;
  }
  if (loading) return <div className="flex-1 p-6 text-zinc-500">加载中…</div>;
  if (error) return <div className="flex-1 p-6 text-red-400">{error}</div>;
  if (!detail) return null;

  const parsed = selectedInstance ? parseYouTubeUrl(selectedInstance.source.url) : null;

  return (
    <div className="flex-1 p-4 overflow-y-auto space-y-4 min-w-0">
      <div>
        <h2 className="text-xl font-semibold">{detail.phrase.phraseRaw}</h2>
        {detail.phrase.meaningZh && (
          <p className="text-zinc-400 mt-1">{detail.phrase.meaningZh}</p>
        )}
      </div>
      {parsed && (
        <YouTubeEmbed videoId={parsed.videoId} startSec={parsed.startSec} />
      )}
      {detail.publicContributions.length > 0 && (
        <section>
          <h3 className="text-sm text-zinc-400 mb-2">📚 公共实例</h3>
          <ul className="space-y-1">
            {detail.publicContributions.map((c) => (
              <li
                key={c.id}
                onClick={() => setSelectedInstance(c)}
                className={`px-3 py-2 rounded text-sm cursor-pointer hover:bg-zinc-800
                  ${selectedInstance?.id === c.id ? 'bg-zinc-800' : 'bg-zinc-900'}`}
              >
                {c.source.title && (
                  <div className="text-xs text-zinc-500">{c.source.title}</div>
                )}
                <div>{c.contextSentence}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {detail.personalContributions.length > 0 && (
        <section>
          <h3 className="text-sm text-zinc-400 mb-2">⭐ 你的实例</h3>
          <ul className="space-y-1">
            {detail.personalContributions.map((c) => (
              <li
                key={c.id}
                onClick={() => setSelectedInstance(c)}
                className={`px-3 py-2 rounded text-sm cursor-pointer hover:bg-zinc-800
                  ${selectedInstance?.id === c.id ? 'bg-zinc-800' : 'bg-zinc-900'}`}
              >
                {c.source.title && (
                  <div className="text-xs text-zinc-500">{c.source.title}</div>
                )}
                <div>{c.contextSentence}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
