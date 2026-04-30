import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Star, Trash2, Volume2, FileOutput } from "lucide-react";
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
      <div className="p-6 space-y-6">
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
      <div className="p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
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
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 px-6 py-3 border-b border-zinc-800">
        <Link
          to="/library"
          title="返回 Library"
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-lg font-semibold flex-1">
          我的词汇本{" "}
          <span className="text-zinc-500 text-sm font-normal">
            ({entries.length})
          </span>
        </h1>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索短语 / 中文释义 ..."
          className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-sm w-64"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortMode)}
          className="px-2 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-sm text-zinc-200"
          title="排序方式"
        >
          {(Object.keys(SORT_LABELS) as SortMode[]).map((k) => (
            <option key={k} value={k}>
              {SORT_LABELS[k]}
            </option>
          ))}
        </select>
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
  return (
    <div className="border border-zinc-800 rounded-md p-3 bg-zinc-900/40 group">
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
    </div>
  );
}
