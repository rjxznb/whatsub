import { useState } from 'react';
import { Play, ExternalLink, Volume2 } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useCorpusList } from '../hooks/useCorpusList';
import { YouTubeEmbed, parseYouTubeUrl } from './YouTubeEmbed';
import { ttsSpeak } from '../tutor/tts';

/** One source video shown as a single page: ONE player on top, then every
 *  public-corpus phrase that came from that video listed below — each row a
 *  ▶ MM:SS button that re-seeks the single player to that phrase's timestamp.
 *  Replaces the "one embedded player per phrase" experience when browsing the
 *  public corpus 按视频来源. */

interface VideoSource {
  kind?: string;
  url?: string;
  title?: string;
  timestampSec?: number;
  youtubeId?: string;
}
interface BrowseItem {
  phraseNormalized: string;
  phraseRaw: string;
  meaningZh: string | null;
  tags?: string[];
  source?: VideoSource;
}
interface BrowseResp {
  items: BrowseItem[];
}

function ytIdOf(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1) || null;
    if (host.endsWith('youtube.com')) return u.searchParams.get('v');
    return null;
  } catch {
    return null;
  }
}

function videoIdOf(s?: VideoSource): string | null {
  return s?.youtubeId ?? ytIdOf(s?.url);
}

/** Seek-to second for a phrase: explicit timestampSec, else parsed from the URL. */
function startSecOf(s?: VideoSource): number | null {
  if (typeof s?.timestampSec === 'number' && s.timestampSec > 0) {
    return Math.floor(s.timestampSec);
  }
  const p = parseYouTubeUrl(s?.url ?? '');
  return p && p.startSec > 0 ? p.startSec : null;
}

function formatTime(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function CorpusVideoDetail({ videoId, tags }: { videoId: string; tags: string[] }) {
  const { data, error } = useCorpusList<BrowseResp>({ mode: 'browse', tags });
  // seekSec + nonce key the embed; bumping the nonce re-seeks even to the same
  // second (so re-clicking a row replays from its timestamp).
  const [seekSec, setSeekSec] = useState(0);
  const [seekNonce, setSeekNonce] = useState(0);
  const [active, setActive] = useState<string | null>(null);

  const speak = (text: string) => void ttsSpeak(text, { lang: 'en-US' });

  if (error && !data) {
    return <div className="h-full p-6 text-red-300 text-sm break-all">加载失败：{error}</div>;
  }
  if (!data) {
    return <div className="h-full p-6 text-zinc-500">加载中…</div>;
  }

  const items = data.items
    .filter((it) => videoIdOf(it.source) === videoId)
    .sort((a, b) => (startSecOf(a.source) ?? 0) - (startSecOf(b.source) ?? 0));

  const title = items.find((it) => it.source?.title)?.source?.title ?? `YouTube · ${videoId}`;

  function jump(it: BrowseItem) {
    const sec = startSecOf(it.source) ?? 0;
    setSeekSec(sec);
    setSeekNonce((n) => n + 1);
    setActive(it.phraseNormalized);
  }

  return (
    <div className="h-full p-4 overflow-y-auto space-y-3 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <h2 className="text-base font-semibold truncate flex-1" title={title}>
          {title}
        </h2>
        <span className="text-xs text-zinc-500 shrink-0">{items.length} 条语料</span>
        <button
          type="button"
          onClick={() =>
            void openUrl(`https://www.youtube.com/watch?v=${videoId}`).catch(() => {})
          }
          title="在浏览器打开"
          className="shrink-0 flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-blue-300"
        >
          <ExternalLink className="h-4 w-4" />
        </button>
      </div>

      <YouTubeEmbed key={`${videoId}:${seekSec}:${seekNonce}`} videoId={videoId} startSec={seekSec} />

      {items.length === 0 ? (
        <div className="text-zinc-500 text-sm">这个视频暂无语料（可能需要点右上角 ↻ 刷新）。</div>
      ) : (
        <ul className="space-y-1">
          {items.map((it) => {
            const sec = startSecOf(it.source);
            const isActive = active === it.phraseNormalized;
            return (
              <li
                key={it.phraseNormalized}
                onClick={() => jump(it)}
                className={`group px-3 py-2 rounded cursor-pointer hover:bg-zinc-800 ${
                  isActive ? 'bg-zinc-800' : 'bg-zinc-900'
                }`}
              >
                <div className="flex items-center gap-2">
                  {sec !== null && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        jump(it);
                      }}
                      title={`跳转到 ${formatTime(sec)} 播放`}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-mono rounded bg-amber-400/15 border border-amber-400/40 text-amber-200 hover:bg-amber-400/30 shrink-0"
                    >
                      <Play className="h-2.5 w-2.5 fill-current" />
                      {formatTime(sec)}
                    </button>
                  )}
                  <span className="text-sm font-medium flex-1 min-w-0">{it.phraseRaw}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      speak(it.phraseRaw);
                    }}
                    title="朗读"
                    className="shrink-0 flex h-6 w-6 items-center justify-center rounded-full text-zinc-500 opacity-0 group-hover:opacity-100 hover:bg-zinc-700 hover:text-blue-300"
                  >
                    <Volume2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {it.meaningZh && (
                  <div className="text-xs text-zinc-400 mt-0.5 pl-0.5">{it.meaningZh}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
