import { useState } from 'react';
import { useCorpusPhrase } from '../hooks/useCorpusPhrase';
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

interface Props { phraseNormalized: string | null }

export function CorpusPhraseDetail({ phraseNormalized }: Props) {
  const { data: detail, error } = useCorpusPhrase<PhraseDetail>(phraseNormalized);
  const [selectedInstance, setSelectedInstance] = useState<Contribution | null>(null);

  if (!phraseNormalized) {
    return <div className="flex-1 p-6 text-zinc-500">选择一个短语查看实例</div>;
  }
  if (error && !detail) {
    return <div className="flex-1 p-6 text-red-300 text-sm break-all">加载失败：{error}</div>;
  }
  if (!detail || !detail.phrase) {
    return <div className="flex-1 p-6 text-zinc-500">加载中…</div>;
  }

  const instance =
    selectedInstance ??
    detail.publicContributions[0] ??
    detail.personalContributions[0] ??
    null;
  const parsed = instance ? parseYouTubeUrl(instance.source.url) : null;

  return (
    <div className="flex-1 p-4 overflow-y-auto space-y-4 min-w-0">
      <div>
        <h2 className="text-xl font-semibold">{detail.phrase.phraseRaw}</h2>
        {detail.phrase.meaningZh && (
          <p className="text-zinc-400 mt-1">{detail.phrase.meaningZh}</p>
        )}
      </div>
      {parsed && <YouTubeEmbed videoId={parsed.videoId} startSec={parsed.startSec} />}
      {detail.publicContributions.length > 0 && (
        <section>
          <h3 className="text-sm text-zinc-400 mb-2">📚 公共实例</h3>
          <ul className="space-y-1">
            {detail.publicContributions.map((c) => (
              <li key={c.id} onClick={() => setSelectedInstance(c)}
                  className={`px-3 py-2 rounded text-sm cursor-pointer hover:bg-zinc-800 ${
                    instance?.id === c.id ? 'bg-zinc-800' : 'bg-zinc-900'
                  }`}>
                {c.source.title && <div className="text-xs text-zinc-500">{c.source.title}</div>}
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
              <li key={c.id} onClick={() => setSelectedInstance(c)}
                  className={`px-3 py-2 rounded text-sm cursor-pointer hover:bg-zinc-800 ${
                    instance?.id === c.id ? 'bg-zinc-800' : 'bg-zinc-900'
                  }`}>
                {c.source.title && <div className="text-xs text-zinc-500">{c.source.title}</div>}
                <div>{c.contextSentence}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
