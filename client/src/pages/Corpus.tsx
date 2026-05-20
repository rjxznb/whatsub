import { useState } from 'react';
import { CorpusPhraseList } from '../components/CorpusPhraseList';
import { CorpusPhraseDetail } from '../components/CorpusPhraseDetail';
import { CorpusNav } from '../components/CorpusNav';
import { CorpusTagChips } from '../components/CorpusTagChips';
import { invalidateAll } from '../lib/corpusCache';
import { useAuth } from '../store/auth';
import { useLicense } from '../store/license';

type Mode = 'browse' | 'mine';

export function Corpus() {
  const [mode, setMode] = useState<Mode>('browse');
  const [tags, setTags] = useState<string[]>([]);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const status = useAuth((s) => s.status);
  const authFromLicense = useAuth((s) => s.authFromLicense);
  const licenseKey = useLicense((s) => s.state?.key ?? null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await invalidateAll();
      setRefreshKey((k) => k + 1);
    } finally {
      setRefreshing(false);
    }
  };

  const handleRetrySession = async () => {
    if (!licenseKey) return;
    setRetrying(true);
    setRetryError('');
    try {
      const r = await authFromLicense(licenseKey);
      if (!r.ok) setRetryError(r.reason ?? 'unknown');
    } finally {
      setRetrying(false);
    }
  };

  function toggleTag(t: string) {
    setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
    setPhrase(null);
  }

  function clearTags() {
    setTags([]);
    setPhrase(null);
  }

  function switchMode(next: Mode) {
    setMode(next);
    setPhrase(null);
    setTags([]); // tag namespaces don't overlap between scopes
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <CorpusNav onRefresh={status === 'authed' ? handleRefresh : undefined} refreshing={refreshing} />
      {status === 'authed' ? (
        <>
          <div className="flex border-b border-zinc-800 px-4">
            {(['browse', 'mine'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                className={
                  'px-4 py-2 text-sm border-b-2 -mb-px transition-colors ' +
                  (mode === m
                    ? 'border-amber-400 text-zinc-100'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200')
                }
              >
                {m === 'browse' ? '公共' : '⭐ 我的'}
              </button>
            ))}
          </div>
          <CorpusTagChips
            scope={mode === 'browse' ? 'public' : 'mine'}
            selected={tags}
            onToggle={toggleTag}
            onClear={clearTags}
            invalidateNonce={refreshKey}
          />
          <div key={`${refreshKey}:${mode}:${tags.join(',')}`} className="flex flex-1 overflow-hidden">
            <CorpusPhraseList
              mode={mode}
              tags={tags}
              selected={phrase}
              onSelect={setPhrase}
            />
            <CorpusPhraseDetail phraseNormalized={phrase} />
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm p-6 bg-zinc-800 rounded-lg border border-zinc-700 space-y-3 text-center">
            <h2 className="text-base font-semibold">云端未连接</h2>
            <p className="text-xs text-zinc-400">
              {status === 'unknown'
                ? '正在连接云端语料库…'
                : retryError
                  ? `失败原因: ${retryError}`
                  : '语料库需要连接云端才能加载，请点击重试。'}
            </p>
            {status === 'unauthed' && (
              <button
                onClick={handleRetrySession}
                disabled={retrying || !licenseKey}
                className="px-3 py-1.5 text-sm bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 rounded"
              >
                {retrying ? '重试中…' : '重试'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
