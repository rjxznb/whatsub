// src/components/agent/YouTubeResults.tsx
//
// Rich preview for youtube_search tool results, rendered in the chat instead of
// a bare JSON dump. Each hit is a card: i.ytimg thumbnail (CSP allows
// *.ytimg.com) → click to play inline via YouTubeEmbed (frame-src allows
// youtube-nocookie) → 导入 (reuses import_video) + 在 YouTube 打开.

import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Play, Download, ExternalLink, Check, Loader2 } from "lucide-react";
import { YouTubeEmbed } from "../YouTubeEmbed";
import { importVideoTool } from "../../agent/tools/import_video";
import { notify } from "../../store/appDialog";
import { formatTime } from "../../utils/time";
import type { YouTubeSearchHit } from "../../agent/tools/youtube_search";

/** Compact Chinese view-count label (12000 → "1.2万次"). */
function compactViews(n?: number | null): string {
  if (n == null) return "";
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿次播放`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万次播放`;
  return `${n} 次播放`;
}

function HitCard({ hit }: { hit: YouTubeSearchHit }) {
  const [playing, setPlaying] = useState(false);
  const [importState, setImportState] = useState<"idle" | "doing" | "done">("idle");
  const thumb = `https://i.ytimg.com/vi/${hit.id}/mqdefault.jpg`;

  const doImport = async () => {
    if (importState !== "idle") return;
    setImportState("doing");
    try {
      await importVideoTool.execute(
        { url: hit.url },
        { signal: new AbortController().signal },
      );
      setImportState("done");
      void notify("已启动导入，进度在 Library 查看。");
    } catch (e) {
      setImportState("idle");
      void notify(`导入失败：${String(e)}`);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-700/70 bg-zinc-800/40">
      <div className="relative aspect-video bg-zinc-900">
        {playing ? (
          <YouTubeEmbed videoId={hit.id} className="absolute inset-0 h-full w-full border-0" />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            title="点击预览播放"
            className="group absolute inset-0 h-full w-full"
          >
            <img
              src={thumb}
              alt={hit.title}
              loading="lazy"
              className="h-full w-full object-cover"
            />
            <span className="absolute inset-0 grid place-items-center transition-colors group-hover:bg-black/30">
              <span className="grid h-11 w-11 place-items-center rounded-full bg-black/55 text-white opacity-90 group-hover:opacity-100">
                <Play size={18} className="ml-0.5" fill="currentColor" />
              </span>
            </span>
            {hit.durationSec != null && (
              <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 py-px text-[10px] text-white">
                {formatTime(hit.durationSec)}
              </span>
            )}
          </button>
        )}
      </div>

      <div className="p-2">
        <div className="line-clamp-2 text-[13px] leading-snug text-zinc-100" title={hit.title}>
          {hit.title}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-zinc-500">
          {hit.channel ?? ""}
          {hit.channel && hit.viewCount != null ? " · " : ""}
          {compactViews(hit.viewCount)}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            onClick={doImport}
            disabled={importState !== "idle"}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-600 px-2 py-1 text-[11px] text-zinc-200 transition-colors hover:border-zinc-400 hover:text-white disabled:opacity-60"
          >
            {importState === "doing" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : importState === "done" ? (
              <Check size={12} />
            ) : (
              <Download size={12} />
            )}
            {importState === "doing" ? "导入中…" : importState === "done" ? "已导入" : "导入"}
          </button>
          <button
            type="button"
            onClick={() => void openUrl(hit.url).catch(() => {})}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
          >
            <ExternalLink size={12} /> 在 YouTube 打开
          </button>
        </div>
      </div>
    </div>
  );
}

export function YouTubeResults({ hits }: { hits: YouTubeSearchHit[] }) {
  if (!hits.length) {
    return <div className="my-1 text-xs text-zinc-500">没有搜到匹配的视频。</div>;
  }
  return (
    <div className="my-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {hits.map((h) => (
        <HitCard key={h.id} hit={h} />
      ))}
    </div>
  );
}
