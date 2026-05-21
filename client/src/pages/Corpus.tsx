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
      <CorpusNav
        onRefresh={status === 'authed' ? handleRefresh : undefined}
        refreshing={refreshing}
        mode={status === 'authed' ? mode : undefined}
        onModeChange={status === 'authed' ? switchMode : undefined}
      />
      {status === 'authed' ? (
        <>
          <CorpusTagChips
            scope={mode === 'browse' ? 'public' : 'mine'}
            selected={tags}
            onToggle={toggleTag}
            onClear={clearTags}
            invalidateNonce={refreshKey}
          />
          {/* a = public list (left)  ·  b = detail (center)  ·  c = personal list (right)
            * 公共 mode: viewport shows a + b, c parked off-screen right.
            * 我的 mode: row translates left by one-list-width — a slides off-screen
            *           left, b shifts to fill from x=0, c slides into the right slot. */}
          <div key={refreshKey} className="flex-1 overflow-hidden">
            <div
              className="flex h-full transition-transform duration-300 ease-out"
              style={{
                width: 'calc(100% + 16rem)',
                transform: mode === 'mine' ? 'translateX(-16rem)' : 'translateX(0)',
              }}
            >
              <div className="w-64 shrink-0 h-full flex flex-col">
                <div className="px-3 py-2 border-b border-zinc-800 text-xs font-medium text-zinc-300 bg-zinc-950 shrink-0">
                  📚 公共短语
                </div>
                <div className="flex-1 min-h-0">
                  <CorpusPhraseList
                    mode="browse"
                    tags={mode === 'browse' ? tags : []}
                    selected={mode === 'browse' ? phrase : null}
                    onSelect={setPhrase}
                  />
                </div>
              </div>
              <div className="flex-1 min-w-0 h-full">
                <CorpusPhraseDetail phraseNormalized={phrase} />
              </div>
              <div className="w-64 shrink-0 h-full border-l border-zinc-800 flex flex-col">
                <div className="px-3 py-2 border-b border-zinc-800 text-xs font-medium text-zinc-300 bg-zinc-950 shrink-0">
                  ⭐ 我的短语
                </div>
                <div className="flex-1 min-h-0">
                  <CorpusPhraseList
                    mode="mine"
                    tags={mode === 'mine' ? tags : []}
                    selected={mode === 'mine' ? phrase : null}
                    onSelect={setPhrase}
                  />
                </div>
              </div>
            </div>
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
