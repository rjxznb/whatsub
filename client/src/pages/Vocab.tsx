import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { notify } from "../store/appDialog";
import { ArrowLeft, Star, Trash2, Volume2, FileOutput, ChevronDown, Check, Cloud, CloudUpload, Loader2, Play, Film } from "lucide-react";
import { NoteBubble } from "../components/NoteBubble";
import { NoteBadge } from "../components/NoteBadge";
import { VocabTour } from "../components/VocabTour";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useVocabulary } from "../store/vocab";
import { corpusQuota, type Quota } from "../lib/api/quota";
import { PhrasePlayer } from "../components/PhrasePlayer";
import { parseYouTubeUrl } from "../components/YouTubeEmbed";
import { formatTime } from "../utils/time";
import { lookupPhonetic } from "../llm/phonetic";
import { ttsSpeak } from "../tutor/tts";
import type { VocabEntry } from "../types/vocab";

type SortMode = "byVideo" | "recent" | "oldest" | "alpha";

const SORT_LABELS: Record<SortMode, string> = {
  byVideo: "按视频分组",
  recent: "最近添加",
  oldest: "最早添加",
  alpha: "字母顺序",
};

/** Resolves IPA for the visible expressions; missing entries silently render none. */
function usePhonetics(entries: VocabEntry[]): Record<string, string | null> {
  const [map, setMap] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      entries.map(async (e) => {
        try {
          return [e.expression, await lookupPhonetic(e.expression)] as const;
        } catch {
          return [e.expression, null] as const;
        }
      })
    ).then((pairs) => {
      if (cancelled) return;
      setMap(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [entries]);
  return map;
}

/** RFC4180-ish CSV escaping: wrap in quotes, double-up internal quotes. */
function csvCell(v: string | number | undefined): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function entriesToCsv(entries: VocabEntry[]): string {
  const header = ["expression", "meaningZh", "usage", "videoTitle", "addedAt", "cueTime"];
  const rows = entries.map((e) =>
    [
      csvCell(e.expression),
      csvCell(e.meaningZh),
      csvCell(e.usage),
      csvCell(e.videoTitle),
      csvCell(e.addedAt),
      csvCell(e.cueTime ?? ""),
    ].join(",")
  );
  // BOM so Excel detects UTF-8 by default.
  return "﻿" + [header.join(","), ...rows].join("\n");
}

/** Build a deep-link to the player, including ?t= when we have a cue time. */
function playerHrefFor(e: VocabEntry): string {
  const base = `/player/${e.videoId}`;
  return e.cueTime != null ? `${base}?t=${e.cueTime.toFixed(2)}` : base;
}

export function Vocab() {
  const { entries, loaded, reload, remove } = useVocabulary();
  const promoteMany = useVocabulary((s) => s.promoteMany);
  const [corpusQ, setCorpusQ] = useState<Quota | null>(null);
  const [batchingId, setBatchingId] = useState<string | null>(null);
  // 按视频 inline player: one expanded group at a time; clicking a phrase's
  // timestamp seeks that group's shared player.
  const [expandedVideoId, setExpandedVideoId] = useState<string | null>(null);
  const [seek, setSeek] = useState<{ videoId: string; sec: number } | null>(null);
  // Best-effort personal-corpus quota for the batch precheck (hidden if it
  // fails — the backend still enforces quota_exceeded). Refetched as the count
  // changes (promotes from anywhere).
  useEffect(() => {
    let cancelled = false;
    corpusQuota().then((q) => { if (!cancelled) setCorpusQ(q); }).catch(() => {});
    return () => { cancelled = true; };
  }, [entries]);

  const batchPromote = async (videoId: string, ids: string[]) => {
    if (ids.length === 0) return;
    const remaining = corpusQ ? corpusQ.limit - corpusQ.used : Infinity;
    if (remaining < ids.length) {
      await notify(
        `云端余量不足：还能上传 ${Math.max(0, remaining)} 条，但有 ${ids.length} 条待上传。可先移除一些或升级订阅。`,
      );
      return;
    }
    setBatchingId(videoId);
    try {
      const { succeeded, failed } = await promoteMany(ids);
      corpusQuota().then(setCorpusQ).catch(() => {});
      if (failed.length === 0) {
        await notify(`已上传 ${succeeded} 条到云端语料库。`);
      } else {
        await notify(
          `上传完成：成功 ${succeeded}，失败 ${failed.length}（${PROMOTE_REASON[failed[0].reason] ?? failed[0].reason}）。`,
        );
      }
    } finally {
      setBatchingId(null);
    }
  };
  // Read phrases with the Edge neural voice (same as the tutor) — better than
  // the OS TTS. Falls back to Web Speech inside ttsSpeak if edge is unreachable.
  const speak = (text: string) => {
    void ttsSpeak(text, { lang: "en-US" });
  };
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>(() => {
    const saved =
      typeof window !== "undefined" ? window.localStorage.getItem("vocabSort") : null;
    return (saved as SortMode) ?? "byVideo";
  });

  useEffect(() => {
    if (!loaded) void reload();
  }, [loaded, reload]);

  useEffect(() => {
    window.localStorage.setItem("vocabSort", sort);
  }, [sort]);

  // First-visit tour: two-step guided onboarding.
  //   "card"   — dim + highlight first card, "双击我试试 ✨"
  //   "bubble" — dim + highlight the note bubble that just opened,
  //              "点击气泡开始记笔记 ✏️"
  //   null     — tour off (already-seen-it state, persisted in
  //              localStorage)
  // Even when entries.length === 0 we still run the tour by dropping a
  // demo card into the empty-state slot, so a fresh user can experience
  // the note interaction before saving anything real.
  type TourStep = "card" | "bubble" | null;
  const [tourStep, setTourStep] = useState<TourStep>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem("vocabTourSeen") ? null : "card";
  });
  function dismissTour() {
    setTourStep(null);
    window.localStorage.setItem("vocabTourSeen", "1");
    // Also close the demo NoteBubble if it's currently open. Without
    // this, clicking 跳过引导 during step="bubble" only unmounts the
    // tour overlay but leaves the bubble in the user's face — feels
    // like the skip didn't take effect. The demo card itself stays
    // (separate dismissDemo flow) so the user can still try the
    // double-click → bubble interaction later if they want.
    setDemoEditing(null);
  }
  function advanceTour() {
    setTourStep("bubble");
  }

  // Demo card's open-editor state. Mirrors the real VocabCard's editing
  // pattern (capturing the rect at open time so the fold-back animation
  // has a stable target) but the on-save callback is a no-op — we don't
  // want the demo's content to land in the user's actual vocab.json.
  const [demoEditing, setDemoEditing] = useState<{
    rect: { left: number; top: number; width: number; height: number };
  } | null>(null);

  // Demo-card dismissal: once the user clicks 🗑 on the demo card we
  // remember it across sessions and revert to the plain empty-state
  // text. Without this flag, removing the demo card would only hide
  // it for the current visit and it would re-spawn on the next launch
  // — feels like a bug rather than the user's intent.
  const [demoDismissed, setDemoDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return !!window.localStorage.getItem("vocabDemoDismissed");
  });
  function dismissDemo() {
    setDemoDismissed(true);
    window.localStorage.setItem("vocabDemoDismissed", "1");
    // If the tour was anchored on the now-gone demo card, end it too.
    // Otherwise its cutout would freeze on a stale rect over an empty
    // page — looks broken.
    if (tourStep) dismissTour();
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.expression.toLowerCase().includes(q) ||
        e.meaningZh.toLowerCase().includes(q) ||
        e.usage.toLowerCase().includes(q)
    );
  }, [entries, search]);

  const phoneticMap = usePhonetics(filtered);

  async function exportCsv() {
    if (entries.length === 0) return;
    const path = await save({
      defaultPath: "vocabulary.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    try {
      await invoke("write_text_file", { path, content: entriesToCsv(entries) });
    } catch (e) {
      void notify(`导出失败：${e}`);
    }
  }

  let body: ReactNode;
  if (entries.length === 0) {
    if (!demoDismissed) {
      // Demo card persists across the whole empty state (not just the
      // tour) so the tour dismissing mid-bubble doesn't yank the card
      // out from under an open bubble. The card behaves like a real
      // VocabCard — including the 🗑 button — so users who don't want
      // it can remove it at any point.
      body = (
        <div className="p-6 pr-14">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-12 gap-y-3">
            <DemoCard
              onDoubleClick={(rect) => {
                setDemoEditing({ rect });
              }}
              onSpeak={() => speak("save you money")}
              onRemove={dismissDemo}
            />
          </div>
          <div className="text-center text-zinc-500 mt-12 text-xs leading-relaxed px-6">
            <Star className="inline-block h-3.5 w-3.5 text-zinc-600 mr-1 mb-0.5" />
            上面是一张演示卡片，可以双击试试笔记功能、或者点 🗑 移除。真正收藏短语时，打开任意视频的「重点短语」标签，点击 ⭐ 就会出现在这里。
          </div>
        </div>
      );
    } else {
      body = (
        <div className="text-center text-zinc-500 mt-32 text-sm leading-relaxed px-6">
          <Star className="mx-auto h-10 w-10 text-zinc-700 mb-3" />
          还没收藏任何短语。
          <br />
          打开任意视频的「重点短语」标签，点击 ⭐ 即可保存到这里。
        </div>
      );
    }
  } else if (filtered.length === 0) {
    body = (
      <div className="text-center text-zinc-500 mt-32 text-sm">
        没有匹配 "{search}" 的短语。
      </div>
    );
  } else if (sort === "byVideo") {
    // Group by source video; newest within each group first.
    const groups = (() => {
      const map = new Map<string, { videoTitle: string; items: VocabEntry[] }>();
      for (const e of filtered) {
        const key = e.videoId || "__unknown__";
        const slot = map.get(key);
        if (slot) slot.items.push(e);
        else map.set(key, { videoTitle: e.videoTitle || "(未知来源)", items: [e] });
      }
      return Array.from(map.entries()).map(([videoId, v]) => ({
        videoId,
        videoTitle: v.videoTitle,
        items: v.items.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1)),
      }));
    })();
    body = (
      // pr-14: extra 32px on the right (over the 24px from p-6) so the
      // rightmost column's NoteBadge — which dangles ~40px past the
      // card's right edge — has room to render fully without being
      // clipped by the wrapper's overflow-x-hidden.
      <div className="p-6 pr-14 space-y-6">
        {groups.map((g) => (
          <section key={g.videoId}>
            <div className="flex items-center gap-2 mb-2">
              {g.videoId !== "__unknown__" ? (
                <Link
                  to={`/player/${g.videoId}`}
                  className="text-zinc-300 hover:text-blue-300 text-sm font-medium underline-offset-2 hover:underline"
                  title="跳到视频"
                >
                  {g.videoTitle}
                </Link>
              ) : (
                <span className="text-zinc-300 text-sm font-medium">
                  {g.videoTitle}
                </span>
              )}
              <span className="text-zinc-600 text-xs">·</span>
              <span className="text-zinc-500 text-xs">{g.items.length} 条</span>
              {(() => {
                const unp = g.items.filter((i) => !i.cloudContributionId).map((i) => i.id);
                if (unp.length === 0) return null;
                const busy = batchingId === g.videoId;
                return (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void batchPromote(g.videoId, unp)}
                    title="把这个视频里未上传的短语一起上传到云端语料库"
                    className="ml-auto inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-blue-300 transition-colors disabled:opacity-50"
                  >
                    {busy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <CloudUpload className="h-3 w-3" />
                    )}
                    上传 {unp.length} 条
                    {corpusQ ? `（余 ${Math.max(0, corpusQ.limit - corpusQ.used)}）` : ""}
                  </button>
                );
              })()}
              {g.videoId !== "__unknown__" && (
                <button
                  type="button"
                  onClick={() =>
                    setExpandedVideoId((v) => (v === g.videoId ? null : g.videoId))
                  }
                  title="在此预览视频，点短语时间戳跳转"
                  className={
                    "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors " +
                    (expandedVideoId === g.videoId
                      ? "bg-white/10 text-zinc-100"
                      : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100")
                  }
                >
                  <Film className="h-3 w-3" />
                  {expandedVideoId === g.videoId ? "收起" : "预览"}
                </button>
              )}
            </div>
            {/* Inline shared player for this video (accordion — one at a time). */}
            {expandedVideoId === g.videoId && (
              <div className="mb-3 overflow-hidden rounded-lg border border-zinc-800">
                <PhrasePlayer
                  videoId={g.videoId}
                  youtubeId={parseYouTubeUrl(g.items.find((i) => i.videoUrl)?.videoUrl ?? "")?.videoId}
                  seekTo={seek?.videoId === g.videoId ? seek.sec : undefined}
                />
              </div>
            )}
            {/* gap-x bumped to 12 (48px) so the NoteBadge tag — which
                dangles ~40px past the card's right edge with its 26°
                tilt — has room to swing without overlapping the next
                card. Vertical gap stays small. */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-3">
              {g.items.map((e) => (
                <VocabCard
                  key={e.id}
                  entry={e}
                  ipa={phoneticMap[e.expression]}
                  onSpeak={() => speak(e.expression)}
                  onRemove={() => void remove(e.id)}
                  onSeek={
                    expandedVideoId === g.videoId && e.cueTime != null
                      ? () => setSeek({ videoId: g.videoId, sec: e.cueTime! })
                      : undefined
                  }
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  } else {
    // Flat sorted list.
    const sorted = [...filtered].sort((a, b) => {
      if (sort === "recent") return a.addedAt < b.addedAt ? 1 : -1;
      if (sort === "oldest") return a.addedAt < b.addedAt ? -1 : 1;
      // alpha
      return a.expression.toLowerCase().localeCompare(b.expression.toLowerCase());
    });
    body = (
      // pr-14: same reason as the byVideo branch — clear the badge's
      // right-side overhang without resorting to clipping it.
      <div className="p-6 pr-14">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-12 gap-y-3">
          {sorted.map((e) => (
            <VocabCard
              key={e.id}
              entry={e}
              ipa={phoneticMap[e.expression]}
              onSpeak={() => speak(e.expression)}
              onRemove={() => void remove(e.id)}
              showSource
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    // overflow-x-hidden: NoteBadge SVG containers sit at right:-51px on
    // each card and extend ~40px past the card's right edge. On the
    // rightmost grid column those SVGs poke past the page's content
    // area and trigger a viewport-level horizontal scroll, leaving an
    // unused strip of background visible to the right of the cards.
    // The badge overflow is purely decorative — clipping it at the
    // viewport edge has no functional cost.
    <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
      <header className="flex items-center gap-3 px-6 py-3 border-b border-zinc-800">
        <Link
          to="/library"
          title="返回 Library"
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-lg font-semibold flex-1 flex items-baseline gap-2 flex-wrap min-w-0">
          <span className="shrink-0">我的词汇本</span>
          {entries.length === 0 ? (
            <span className="text-zinc-500 text-sm font-normal italic">
              等你来贡献第一个短语 ✨
            </span>
          ) : (
            <span className="text-zinc-400 text-sm font-normal flex items-baseline gap-1.5">
              <span>· 已经收藏</span>
              {/* Caveat handwriting font + amber color makes the number
                  feel like a personal tally mark — the user's growing
                  trophy count, not a debug stat. text-2xl gives it
                  visual prominence over the surrounding labels without
                  pushing the header layout around too much. */}
              <span className="font-handwrite font-bold text-amber-300 text-2xl leading-none">
                {entries.length}
              </span>
              <span>个短语</span>
            </span>
          )}
        </h1>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索短语 / 中文释义 ..."
          className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-sm w-64"
        />
        <SortDropdown value={sort} onChange={setSort} />
        <button
          type="button"
          disabled={entries.length === 0}
          onClick={exportCsv}
          title="导出为 CSV"
          className="flex items-center gap-1 px-3 py-1.5 text-sm rounded bg-zinc-900 border border-zinc-800 text-zinc-200 hover:border-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <FileOutput className="h-3.5 w-3.5" />
          导出 CSV
        </button>
      </header>
      {body}

      {/* First-visit tour. With a demo card injected into the empty-
          state slot, the tour can run regardless of entries.length. */}
      {tourStep && (
        <VocabTour
          step={tourStep}
          onAdvance={advanceTour}
          onDismiss={dismissTour}
        />
      )}

      {/* Demo bubble — opened only by a double-click on the demo card.
          Renders even after the tour dismisses so the user can finish
          the demo if they want; closes via Done/Cancel/backdrop like a
          real bubble, but on close it just unmounts (no save to the
          real store). */}
      {demoEditing && (
        <NoteBubble
          initialNote=""
          cardRect={demoEditing.rect}
          onDone={() => setDemoEditing(null)}
          onCancel={() => setDemoEditing(null)}
        />
      )}
    </div>
  );
}

/** Backend reason → Chinese message for a failed cloud promote. */
const PROMOTE_REASON: Record<string, string> = {
  quota_exceeded: "云端语料额度已满",
  auth_required: "云端未连接，请稍后重试",
  bad_token: "登录已过期",
  rate_limited: "操作太频繁，请稍后再试",
  empty_phrase: "短语为空，无法上传",
};

interface CardProps {
  entry: VocabEntry;
  ipa: string | null | undefined;
  onSpeak: () => void;
  onRemove: () => void;
  /** When true, render a small "from <video>" line under the card body. */
  showSource?: boolean;
  /** When provided (按视频 preview), render a ▶ MM:SS chip that seeks the
   *  group's inline player to this phrase's cue time. */
  onSeek?: () => void;
}

function VocabCard({ entry: e, ipa, onSpeak, onRemove, showSource, onSeek }: CardProps) {
  const href = playerHrefFor(e);
  const cardRef = useRef<HTMLDivElement>(null);
  // Bubble open-state lives on the card so each card has its own. We
  // capture the card's bounding rect at the moment the bubble opens —
  // not on every render — so the fold-back animation has a stable
  // target even if the card scrolled mid-edit.
  const [editing, setEditing] = useState<{
    rect: { left: number; top: number; width: number; height: number };
  } | null>(null);
  const updateNote = useVocabulary((s) => s.updateNote);
  const promoteToCloud = useVocabulary((s) => s.promoteToCloud);
  const unpromote = useVocabulary((s) => s.unpromote);
  const hasNote = !!e.note;

  // Promote to / un-promote from the cloud personal corpus.
  const promoted = !!e.cloudContributionId;
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudErr, setCloudErr] = useState<string | null>(null);
  const toggleCloud = async () => {
    if (cloudBusy) return;
    setCloudBusy(true);
    setCloudErr(null);
    if (promoted) {
      await unpromote(e.id);
    } else {
      const r = await promoteToCloud(e.id);
      if (!r.ok) setCloudErr(PROMOTE_REASON[r.reason ?? ""] ?? `上传失败：${r.reason ?? ""}`);
    }
    setCloudBusy(false);
  };

  function openEditor() {
    if (!cardRef.current) return;
    const r = cardRef.current.getBoundingClientRect();
    setEditing({
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    });
  }

  return (
    <div
      ref={cardRef}
      // data-vocab-card: VocabTour queries this attribute to find the
      // first card and anchor its dim-cutout + tooltip to it.
      data-vocab-card="true"
      onDoubleClick={(ev) => {
        // Prevent double-click from selecting text in the card or
        // navigating via the <Link>'s text. Open the editor instead.
        ev.preventDefault();
        openEditor();
      }}
      className={
        // Hover lights the card up with a warm amber halo + brighter
        // border (matching the amber expression text — feels like the
        // word itself glows on hover). Active gives a small scale-down
        // + slightly darker bg so a click reads as a tactile "press in"
        // even though the card itself isn't the navigation target.
        // transition-all 150ms is fast enough for transform to snap on
        // press but slow enough that hover-in feels smooth.
        "relative border border-zinc-800 rounded-md p-3 bg-zinc-900/40 group cursor-default " +
        "transition-all duration-150 ease-out " +
        "hover:border-amber-400/40 hover:bg-zinc-900/70 " +
        "hover:shadow-[0_0_28px_-6px_rgba(251,191,36,0.35)] " +
        "active:scale-[0.98] active:bg-zinc-900/90 active:shadow-[0_0_18px_-8px_rgba(251,191,36,0.25)]"
      }
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Link
          to={href}
          title={
            e.cueTime != null
              ? `跳到视频 ${e.cueTime.toFixed(1)}s`
              : "跳到视频"
          }
          className="text-amber-300 hover:text-amber-200 font-semibold text-sm underline-offset-2 hover:underline"
        >
          {e.expression}
        </Link>
        {ipa && <span className="font-ipa text-zinc-300 text-sm">{ipa}</span>}
        {onSeek && e.cueTime != null && (
          <button
            type="button"
            onClick={onSeek}
            title="在上方预览里跳到这一句"
            className="inline-flex items-center gap-0.5 rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-blue-300 hover:bg-zinc-700 transition-colors"
          >
            <Play className="h-2.5 w-2.5" fill="currentColor" />
            {formatTime(e.cueTime)}
          </button>
        )}
        <button
          type="button"
          onClick={onSpeak}
          title="朗读"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-blue-300 transition-colors"
        >
          <Volume2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void toggleCloud()}
          disabled={cloudBusy}
          title={promoted ? "已在云端语料库 · 点击移除" : "上传到云端语料库（个人语料）"}
          className={
            "flex h-6 w-6 items-center justify-center rounded-full transition-colors " +
            (promoted
              ? "text-blue-300 hover:bg-blue-900/30"
              : "text-zinc-500 hover:bg-zinc-800 hover:text-blue-300")
          }
        >
          {cloudBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : promoted ? (
            <Cloud className="h-3.5 w-3.5" />
          ) : (
            <CloudUpload className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="移出词汇本"
          className="mr-2 flex h-6 w-6 items-center justify-center rounded-full text-zinc-500 hover:bg-red-900/30 hover:text-red-300 transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {e.meaningZh && (
        <div className="text-zinc-100 text-xs mt-1.5">{e.meaningZh}</div>
      )}
      {cloudErr && <div className="text-[10px] text-rose-300 mt-1">{cloudErr}</div>}
      {e.usage && (
        <div className="text-zinc-400 text-xs mt-1 italic">{e.usage}</div>
      )}
      {showSource && e.videoTitle && (
        <div className="text-zinc-500 text-[11px] mt-2 truncate">
          来自：{e.videoTitle}
        </div>
      )}

      {/* Tag indicator + drag-off handle when a note exists.
          The tag dangles by a string from the card's punched hole.
          User drags it past PULL_THRESHOLD → onPullOff fires → editor opens. */}
      {hasNote && !editing && <NoteBadge onPullOff={openEditor} />}

      {/* TipTap editor in a portal — positioned relative to the card via
          the captured rect. Unmounts after the fold animation completes. */}
      {editing && (
        <NoteBubble
          initialNote={e.note ?? ""}
          cardRect={editing.rect}
          onDone={(note) => {
            void updateNote(e.id, note);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** Static demo card shown in the empty-state slot. Visually + behaviorally
 *  identical to a real VocabCard so the tour's "double-click me" lesson
 *  generalises and the user can practice all the same gestures (speak,
 *  delete, double-click → notes) on hard-coded sample content. The
 *  bubble's save callback discards rather than writes to vocab.json,
 *  and the delete button just hides the card via a localStorage flag. */
function DemoCard({
  onDoubleClick,
  onSpeak,
  onRemove,
}: {
  onDoubleClick: (rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  }) => void;
  onSpeak: () => void;
  onRemove: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  function handleDoubleClick(ev: React.MouseEvent) {
    ev.preventDefault();
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    onDoubleClick({
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
    });
  }
  return (
    <div
      ref={ref}
      data-vocab-card="true"
      onDoubleClick={handleDoubleClick}
      className={
        "relative border border-zinc-800 rounded-md p-3 bg-zinc-900/40 group cursor-default " +
        "transition-all duration-150 ease-out " +
        "hover:border-amber-400/40 hover:bg-zinc-900/70 " +
        "hover:shadow-[0_0_28px_-6px_rgba(251,191,36,0.35)] " +
        "active:scale-[0.98] active:bg-zinc-900/90 active:shadow-[0_0_18px_-8px_rgba(251,191,36,0.25)]"
      }
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-amber-300 font-semibold text-sm">
          save you money
        </span>
        <span className="font-ipa text-zinc-300 text-sm">
          /seɪv juː ˈmʌni/
        </span>
        <button
          type="button"
          onClick={onSpeak}
          title="朗读"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-blue-300 transition-colors"
        >
          <Volume2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="移除演示卡片"
          className="flex h-6 w-6 items-center justify-center rounded-full text-zinc-500 hover:bg-red-900/30 hover:text-red-300 transition-colors opacity-0 group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="text-zinc-100 text-xs mt-1.5">省钱</div>
      <div className="text-zinc-400 text-xs mt-1 italic">
        「Knowing your rights can save you money.」
      </div>
      <div className="text-zinc-500 text-[11px] mt-2 truncate">
        来自：示例视频（演示卡片）
      </div>
    </div>
  );
}

/** Custom sort dropdown. Replaces the native <select> so we can animate
 *  the open transition (native <select> hands rendering off to the OS
 *  and ignores any CSS animation on it). The trigger button gets the
 *  same click-pop feedback as toolbar buttons; the panel unrolls
 *  downward via clip-path (see App.css `animate-sort-slide-down`). */
function SortDropdown({
  value,
  onChange,
}: {
  value: SortMode;
  onChange: (v: SortMode) => void;
}) {
  const [open, setOpen] = useState(false);
  // Trigger button's measured width — captured at open time and applied
  // to the menu so the panel always matches the button's actual rendered
  // width, regardless of which option is currently selected (different
  // labels have different lengths).
  const [menuWidth, setMenuWidth] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  function handleSelect(k: SortMode) {
    onChange(k);
    setOpen(false);
  }

  function handleToggle() {
    if (!open && triggerRef.current) {
      setMenuWidth(triggerRef.current.offsetWidth);
    }
    setOpen((v) => !v);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        title="排序方式"
        // active:border-zinc-400 + transition-colors gives a brief border
        // highlight on press without changing the bg color (no scaling
        // either — text/icon stay perfectly still). Press is instant on
        // mousedown; release fades back over 200ms so a quick click
        // still registers as a visible "blink" of the border.
        className="px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-sm text-zinc-200 hover:border-zinc-700 active:border-zinc-400 transition-colors duration-200 flex items-center gap-1.5 min-w-[120px] justify-between"
      >
        <span>{SORT_LABELS[value]}</span>
        <ChevronDown
          className={
            "w-3.5 h-3.5 text-zinc-400 transition-transform " +
            (open ? "rotate-180" : "")
          }
        />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-30 bg-zinc-900 border border-zinc-700 rounded shadow-2xl py-1 overflow-hidden animate-sort-slide-down"
          style={{
            transformOrigin: "top center",
            width: menuWidth ?? undefined,
          }}
        >
          {(Object.keys(SORT_LABELS) as SortMode[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => handleSelect(k)}
              className={
                "w-full px-3 py-1.5 text-sm text-left flex items-center justify-between gap-3 hover:bg-zinc-800 transition-colors " +
                (k === value
                  ? "bg-blue-500/15 text-blue-300"
                  : "text-zinc-200")
              }
            >
              <span>{SORT_LABELS[k]}</span>
              {k === value && <Check className="w-3.5 h-3.5 text-blue-300" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
