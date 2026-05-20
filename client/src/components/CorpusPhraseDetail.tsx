import { useEffect, useState } from 'react';
import { Play, ChevronLeft, ChevronRight, Volume2 } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useCorpusPhrase } from '../hooks/useCorpusPhrase';
import { useSpeech } from '../hooks/useSpeech';
import { lookupPhonetic } from '../llm/phonetic';
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
    /** Schema migration 2026-05-20: corpus_phrases.key_notes column was
     *  dropped and the equivalent moved to corpus_contributions.usage_note.
     *  Server's /lookup now aggregates that field and returns it as
     *  `usage_note` (camelCase → usageNote on this side). The UI label
     *  stays 「📝 重点笔记」 — same intent, just the storage moved. */
    usageNote: string | null;
    tags: Record<string, unknown> | string[];
  };
  publicContributions: Contribution[];
  personalContributions: Contribution[];
}

interface Props { phraseNormalized: string | null }

function formatTime(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Resolve the seek-to second for a contribution. Prefers the explicit
 *  `source.timestampSec` (set at save time), falls back to parsing it out
 *  of the URL's `t=` param. Returns null when neither carries one — the
 *  jump button is hidden in that case rather than silently jumping to 0. */
// Mirror of CorpusTagChips' label map so scene tag chips render as the
// Chinese label (not the raw key like "medical"). Free-form admin tags
// fall through to their literal string.
const SCENE_LABELS: Record<string, string> = {
  immigration: '入境通关', housing: '住房安家', medical: '医疗健康',
  campus: '校园学习', banking: '银行财务', shopping: '日常购物',
  transport: '交通出行', social: '社交日常', dining: '餐饮',
  emergency: '紧急情况', job: '求职职场', phone: '电话沟通',
  salon: '美容美发', driving: '驾照开车', travel: '旅游度假',
  fitness: '运动健身', mental_health: '心理健康', maintenance: '搬家维修',
};
function tagLabel(t: string): string {
  return SCENE_LABELS[t] ?? t;
}

function phraseTagList(tags: Record<string, unknown> | string[] | null | undefined): string[] {
  if (!tags) return [];
  // Server may emit either a bare string[] (legacy curator-aggregate output)
  // or a { list: [...] } envelope (current per-contribution shape, also what
  // /lookup withScope now returns). Accept both.
  if (Array.isArray(tags)) {
    return tags.filter((t): t is string => typeof t === 'string' && t.length > 0);
  }
  const list = (tags as { list?: unknown }).list;
  if (Array.isArray(list)) {
    return list.filter((t): t is string => typeof t === 'string' && t.length > 0);
  }
  // Legacy fallback for rows that still only have tags.scene.
  const scene = (tags as { scene?: unknown }).scene;
  return typeof scene === 'string' && scene.length > 0 ? [scene] : [];
}

function instanceStartSec(c: Contribution): number | null {
  if (typeof c.source.timestampSec === 'number' && c.source.timestampSec > 0) {
    return c.source.timestampSec;
  }
  const parsed = parseYouTubeUrl(c.source.url);
  return parsed && parsed.startSec > 0 ? parsed.startSec : null;
}

export function CorpusPhraseDetail({ phraseNormalized }: Props) {
  const { data: detail, error } = useCorpusPhrase<PhraseDetail>(phraseNormalized);
  const [selectedInstance, setSelectedInstance] = useState<Contribution | null>(null);
  // Bumping this forces the YouTubeEmbed to remount, even when the
  // selected instance hasn't changed — needed so clicking the inline
  // timestamp re-seeks the player to the start second instead of being
  // a no-op when you're already on that instance.
  const [seekNonce, setSeekNonce] = useState(0);
  const { speak, voices, voiceURI, setVoiceURI } = useSpeech();
  const [ipa, setIpa] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIpa(null);
    const phrase = detail?.phrase?.phraseRaw;
    if (!phrase) return;
    void lookupPhonetic(phrase).then((p) => {
      if (!cancelled) setIpa(p);
    }).catch(() => { /* dict miss is fine — render no badge */ });
    return () => { cancelled = true; };
  }, [detail?.phrase?.phraseRaw]);

  if (!phraseNormalized) {
    return <div className="h-full p-6 text-zinc-500">选择一个短语查看例句出处</div>;
  }
  if (error && !detail) {
    return <div className="h-full p-6 text-red-300 text-sm break-all">加载失败：{error}</div>;
  }
  if (!detail || !detail.phrase) {
    return <div className="h-full p-6 text-zinc-500">加载中…</div>;
  }

  // All instances (public first, then personal) flattened into one carousel
  // — left/right arrows step through the combined list, since the YouTube
  // embed is a single slot and users mainly want fast switching, not a
  // per-source button maze.
  const allInstances = [...detail.publicContributions, ...detail.personalContributions];
  const selectedIdx = selectedInstance
    ? allInstances.findIndex((c) => c.id === selectedInstance.id)
    : -1;
  const currentIdx = selectedIdx >= 0 ? selectedIdx : 0;
  const instance = allInstances[currentIdx] ?? null;
  const parsedUrl = instance ? parseYouTubeUrl(instance.source.url) : null;
  // YouTubeEmbed receives the explicit per-instance startSec when available;
  // otherwise it falls back to whatever the URL itself carries.
  const embedStart = instance
    ? instanceStartSec(instance) ?? parsedUrl?.startSec ?? 0
    : 0;

  function goPrev() {
    if (allInstances.length === 0) return;
    const next = currentIdx > 0 ? currentIdx - 1 : allInstances.length - 1;
    setSelectedInstance(allInstances[next] ?? null);
    setSeekNonce((n) => n + 1);
  }
  function goNext() {
    if (allInstances.length === 0) return;
    const next = currentIdx < allInstances.length - 1 ? currentIdx + 1 : 0;
    setSelectedInstance(allInstances[next] ?? null);
    setSeekNonce((n) => n + 1);
  }
  function reseek() {
    setSeekNonce((n) => n + 1);
  }

  function renderInstance(c: Contribution) {
    const isActive = instance?.id === c.id;
    const sec = instanceStartSec(c);
    return (
      <li
        key={c.id}
        onClick={() => setSelectedInstance(c)}
        className={`px-3 py-2 rounded text-sm cursor-pointer hover:bg-zinc-800 ${
          isActive ? 'bg-zinc-800' : 'bg-zinc-900'
        }`}
      >
        {(sec !== null || c.source.title) && (
          <div className="flex items-center gap-2 mb-1">
            {sec !== null && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setSelectedInstance(c); }}
                title={`跳转到 ${formatTime(sec)} 播放`}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-mono rounded bg-amber-400/15 border border-amber-400/40 text-amber-200 hover:bg-amber-400/30"
              >
                <Play className="h-2.5 w-2.5 fill-current" />
                {formatTime(sec)}
              </button>
            )}
            {c.source.title && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openUrl(c.source.url).catch((err) =>
                    console.error('open source url failed', err)
                  );
                }}
                title={`在浏览器打开 ${c.source.url}`}
                className="text-xs text-zinc-400 hover:text-blue-300 hover:underline truncate text-left max-w-full"
              >
                {c.source.title}
              </button>
            )}
          </div>
        )}
        <div>{c.contextSentence}</div>
      </li>
    );
  }


  return (
    <div className="h-full p-4 overflow-y-auto space-y-4 min-w-0">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-xl font-semibold">{detail.phrase.phraseRaw}</h2>
          {ipa && <span className="font-ipa text-zinc-300 text-base">{ipa}</span>}
          <button
            type="button"
            onClick={() => speak(detail.phrase.phraseRaw)}
            title="朗读"
            className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-blue-300 transition-colors"
          >
            <Volume2 className="h-4 w-4" />
          </button>
          {voices.length > 0 && (
            <select
              value={voiceURI ?? ''}
              onChange={(e) => setVoiceURI(e.target.value)}
              title="选择 TTS 音色"
              className="ml-auto text-xs bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-200 max-w-[200px]"
            >
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          )}
        </div>
        {detail.phrase.meaningZh && (
          <p className="text-zinc-400 mt-1">{detail.phrase.meaningZh}</p>
        )}
        {(() => {
          const list = phraseTagList(detail.phrase.tags);
          if (list.length === 0) return null;
          return (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {list.map((t) => (
                <span
                  key={t}
                  className="px-2 py-0.5 text-[11px] rounded-full bg-amber-400/15 border border-amber-400/40 text-amber-200"
                >
                  {tagLabel(t)}
                </span>
              ))}
            </div>
          );
        })()}
      </div>
      {parsedUrl && (
        <div className="space-y-2">
          {allInstances.length > 1 && (
            <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5">
              <button
                type="button"
                onClick={goPrev}
                title="上一个出处"
                className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="flex-1 text-center font-mono text-xs text-zinc-400">
                {currentIdx + 1} / {allInstances.length}
              </div>
              <button
                type="button"
                onClick={goNext}
                title="下一个出处"
                className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
          <YouTubeEmbed
            key={`${instance?.id ?? 'none'}:${seekNonce}`}
            videoId={parsedUrl.videoId}
            startSec={embedStart}
          />
          {instance && (() => {
            const sec = instanceStartSec(instance);
            if (sec === null) return null;
            return (
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-400">跳转到语料出处</span>
                <button
                  type="button"
                  onClick={reseek}
                  title={`跳到 ${formatTime(sec)} 重新播放`}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded bg-amber-400/15 border border-amber-400/40 text-amber-200 hover:bg-amber-400/30"
                >
                  <Play className="h-3 w-3 fill-current" />
                  {formatTime(sec)}
                </button>
              </div>
            );
          })()}
        </div>
      )}
      {detail.phrase.usageNote && (
        <section>
          <h3 className="text-sm text-zinc-400 mb-2">📝 重点笔记</h3>
          <p className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap bg-zinc-900 rounded p-3 border border-zinc-800">
            {detail.phrase.usageNote}
          </p>
        </section>
      )}
      {detail.personalContributions.length > 0 && (
        <section>
          <h3 className="text-sm text-zinc-400 mb-2">⭐ 我的例句出处</h3>
          <ul className="space-y-1">
            {detail.personalContributions.map(renderInstance)}
          </ul>
        </section>
      )}
    </div>
  );
}
