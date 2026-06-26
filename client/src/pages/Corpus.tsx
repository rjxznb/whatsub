import { useState } from 'react';
import { CorpusPhraseList, type BrowseLayout } from '../components/CorpusPhraseList';
import { CorpusPhraseDetail } from '../components/CorpusPhraseDetail';
import { CorpusVideoDetail } from '../components/CorpusVideoDetail';
import { CorpusNav } from '../components/CorpusNav';
import { CorpusTagChips } from '../components/CorpusTagChips';
import { CorpusTour } from '../components/CorpusTour';
import { invalidateAll } from '../lib/corpusCache';
import { useAuth } from '../store/auth';
import { useLicense } from '../store/license';
import { AccountLoginDialog } from '../components/AccountLoginDialog';

type Mode = 'browse' | 'mine';

export function Corpus() {
  const [mode, setMode] = useState<Mode>('browse');
  const [tags, setTags] = useState<string[]>([]);
  const [phrase, setPhrase] = useState<string | null>(null);
  // 按视频来源: the selected video for the video-detail panel + a mirror of the
  // browse layout (reported up by CorpusPhraseList) so we pick the right panel.
  const [selectedVideo, setSelectedVideo] = useState<string | null>(null);
  const [browseLayout, setBrowseLayout] = useState<BrowseLayout>('flat');
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const status = useAuth((s) => s.status);
  const authFromLicense = useAuth((s) => s.authFromLicense);
  const licenseKey = useLicense((s) => s.state?.key ?? null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);

  // First-visit onboarding modal. localStorage gate so it only fires once
  // per machine; announces the plugin-sync feature with a demo clip.
  const [showTour, setShowTour] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return !window.localStorage.getItem('corpusTourSeen');
  });
  function dismissTour() {
    setShowTour(false);
    window.localStorage.setItem('corpusTourSeen', '1');
  }

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
    setSelectedVideo(null);
  }

  function clearTags() {
    setTags([]);
    setPhrase(null);
    setSelectedVideo(null);
  }

  function switchMode(next: Mode) {
    setMode(next);
    setPhrase(null);
    setSelectedVideo(null);
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
              <div className="w-64 shrink-0 h-full">
                <CorpusPhraseList
                  mode="browse"
                  tags={mode === 'browse' ? tags : []}
                  selected={mode === 'browse' ? phrase : null}
                  onSelect={(p) => {
                    setPhrase(p);
                    setSelectedVideo(null);
                  }}
                  autoSelectFirst={mode === 'browse'}
                  onSelectVideo={setSelectedVideo}
                  selectedVideo={selectedVideo}
                  onBrowseLayoutChange={(l) => {
                    setBrowseLayout(l);
                    if (l !== 'source') setSelectedVideo(null);
                  }}
                />
              </div>
              <div className="flex-1 min-w-0 h-full">
                {mode === 'browse' && browseLayout === 'source' ? (
                  selectedVideo ? (
                    <CorpusVideoDetail
                      videoId={selectedVideo}
                      tags={mode === 'browse' ? tags : []}
                    />
                  ) : (
                    <div className="h-full p-6 text-zinc-500">
                      选择左侧的一个视频，查看它的播放器和全部语料
                    </div>
                  )
                ) : (
                  <CorpusPhraseDetail phraseNormalized={phrase} />
                )}
              </div>
              <div className="w-64 shrink-0 h-full border-l border-zinc-800">
                <CorpusPhraseList
                  mode="mine"
                  tags={mode === 'mine' ? tags : []}
                  selected={mode === 'mine' ? phrase : null}
                  onSelect={setPhrase}
                  autoSelectFirst={mode === 'mine'}
                />
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm p-6 bg-zinc-800 rounded-lg border border-zinc-700 space-y-3 text-center">
            <h2 className="text-base font-semibold">
              {status === 'unknown' ? '云端连接中' : '登录后可用'}
            </h2>
            <p className="text-xs text-zinc-400">
              {status === 'unknown'
                ? '正在连接云端语料库…'
                : retryError
                  ? `失败原因: ${retryError}`
                  : '语料库需要登录账号才能加载。用你在手机端使用的邮箱登录即可（无需订阅）。'}
            </p>
            {status === 'unauthed' && (
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={() => setLoginOpen(true)}
                  className="px-3 py-1.5 text-sm bg-blue-500 hover:bg-blue-400 text-black font-medium rounded"
                >
                  登录账号
                </button>
                {licenseKey && (
                  <button
                    onClick={handleRetrySession}
                    disabled={retrying}
                    className="px-3 py-1.5 text-sm bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 rounded"
                  >
                    {retrying ? '重试中…' : '重试'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <AccountLoginDialog
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        title="登录账号"
        hint="用你在手机端使用的邮箱登录。登录后即可浏览语料库、把视频云同步到手机。"
      />
      {/* First-visit plugin-sync announcement modal. */}
      {showTour && status === 'authed' && (
        <CorpusTour onDismiss={dismissTour} />
      )}
    </div>
  );
}
