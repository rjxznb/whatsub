import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Star, Trash2, Volume2, FileOutput, ChevronDown, Check } from "lucide-react";
import { NoteBubble } from "../components/NoteBubble";
import { NoteBadge } from "../components/NoteBadge";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useVocabulary } from "../store/vocab";
import { lookupPhonetic } from "../llm/phonetic";
import { useSpeech } from "../hooks/useSpeech";
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
  const { speak } = useSpeech();
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
      alert(`导出失败：${e}`);
    }
  }

  let body: ReactNode;
  if (entries.length === 0) {
    body = (
      <div className="text-center text-zinc-500 mt-32 text-sm leading-relaxed px-6">
        <Star className="mx-auto h-10 w-10 text-zinc-700 mb-3" />
        还没收藏任何短语。
        <br />
        打开任意视频的「重点短语」标签，点击 ⭐ 即可保存到这里。
      </div>
    );
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
            </div>
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
    </div>
  );
}

interface CardProps {
  entry: VocabEntry;
  ipa: string | null | undefined;
  onSpeak: () => void;
  onRemove: () => void;
  /** When true, render a small "from <video>" line under the card body. */
  showSource?: boolean;
}

function VocabCard({ entry: e, ipa, onSpeak, onRemove, showSource }: CardProps) {
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
  const hasNote = !!e.note;

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
          title="移出词汇本"
          className="flex h-6 w-6 items-center justify-center rounded-full text-zinc-500 hover:bg-red-900/30 hover:text-red-300 transition-colors opacity-0 group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {e.meaningZh && (
        <div className="text-zinc-100 text-xs mt-1.5">{e.meaningZh}</div>
      )}
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
