import { useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

const PLUGIN_DOWNLOAD_URL = "https://whatsub.eversay.cc/download/plugin";
// "了解更多功能" target — the plugin's feature/landing page where the user
// can watch full walkthroughs. Adjust if the public URL changes.
const PLUGIN_WEBSITE_URL = "https://whatsub.eversay.cc/plugin";

interface Slide {
  badge: string;
  icon: string;
  title: string;
  desc: string;
  /** Demo clip. Drop a short muted mp4 at the path under client/public.
   *  Missing file → 🎬 placeholder. */
  media: string;
}

const SLIDES: Slide[] = [
  {
    badge: "功能一",
    icon: "🎬",
    title: "YouTube 双语字幕 · AI 解析重点",
    desc: "导入 YouTube 视频，自动生成中英双语字幕；AI 标注重点词汇和短语，点一下就能查义、记笔记。",
    media: "/help/feature-subtitles.mp4",
  },
  {
    badge: "功能二",
    icon: "🧩",
    title: "划词同步 · 多端语料库",
    desc: "浏览器插件在任意英文网页划词一键保存，桌面端立刻同步——多设备共享你的私人语料库。",
    media: "/help/feature-plugin-sync.mp4",
  },
];

interface Props {
  /** Dismiss the tour (✕ / backdrop / 知道了). Persists corpusTourSeen. */
  onDismiss: () => void;
}

/**
 * Left/right paging onboarding for the corpus page. Two slides, each
 * announcing a core feature with its own demo clip:
 *   1. YouTube bilingual subtitles + AI key-vocab analysis
 *   2. Highlight-to-sync multi-device corpus (the plugin)
 *
 * Slides translate horizontally on a flex track (same pattern as the
 * corpus mode switcher). Prev/next arrows + dot indicators drive paging.
 */
export function CorpusTour({ onDismiss }: Props) {
  const [page, setPage] = useState(0);
  const [failed, setFailed] = useState<Set<number>>(new Set());

  const last = SLIDES.length - 1;
  const go = (next: number) => setPage(Math.max(0, Math.min(last, next)));

  function download() {
    openUrl(PLUGIN_DOWNLOAD_URL).catch((err) =>
      console.error("open plugin download failed", err)
    );
  }
  function openWebsite() {
    openUrl(PLUGIN_WEBSITE_URL).catch((err) =>
      console.error("open plugin website failed", err)
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center animate-vocab-tour-fade-in">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm pointer-events-auto"
        onClick={onDismiss}
      />
      <div className="relative pointer-events-auto max-w-lg w-[92%] bg-zinc-900 border border-amber-400/40 rounded-2xl shadow-2xl overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center justify-between px-6 pt-5 pb-1">
          <span className="text-[11px] uppercase tracking-wide text-amber-300/80 font-medium">
            新功能介绍
          </span>
          <button
            type="button"
            onClick={onDismiss}
            title="关闭"
            className="h-8 w-8 flex items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Sliding track */}
        <div className="overflow-hidden">
          <div
            className="flex transition-transform duration-300 ease-out"
            style={{ transform: `translateX(-${page * 100}%)` }}
          >
            {SLIDES.map((slide, i) => (
              <div key={i} className="w-full shrink-0 px-6">
                <div className="flex items-center gap-3 pt-1">
                  <div className="h-10 w-10 rounded-full bg-amber-400/15 border border-amber-400/40 flex items-center justify-center text-xl">
                    {slide.icon}
                  </div>
                  <div>
                    <div className="text-[11px] text-amber-300/80 font-medium">
                      {slide.badge}
                    </div>
                    <h2 className="text-base font-semibold text-zinc-100 leading-tight">
                      {slide.title}
                    </h2>
                  </div>
                </div>
                <p className="mt-3 text-sm text-zinc-300 leading-relaxed min-h-[2.5rem]">
                  {slide.desc}
                </p>
                <div className="mt-3 rounded-xl overflow-hidden border border-zinc-800 bg-black aspect-video">
                  {failed.has(i) ? (
                    <div className="h-full w-full flex flex-col items-center justify-center gap-1.5 text-zinc-600 text-sm">
                      <span className="text-3xl">🎬</span>
                      <span>演示动画</span>
                      <span className="text-xs text-zinc-700">
                        （{slide.media}）
                      </span>
                    </div>
                  ) : (
                    <video
                      src={slide.media}
                      autoPlay
                      loop
                      muted
                      playsInline
                      className="h-full w-full object-cover"
                      onError={() =>
                        setFailed((prev) => new Set(prev).add(i))
                      }
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Pager: arrows + dots */}
        <div className="flex items-center justify-center gap-4 px-6 pt-4">
          <button
            type="button"
            onClick={() => go(page - 1)}
            disabled={page === 0}
            className="h-8 w-8 flex items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            {SLIDES.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => go(i)}
                className={
                  "h-2 rounded-full transition-all " +
                  (i === page
                    ? "w-5 bg-amber-400"
                    : "w-2 bg-zinc-700 hover:bg-zinc-600")
                }
                aria-label={`第 ${i + 1} 屏`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => go(page + 1)}
            disabled={page === last}
            className="h-8 w-8 flex items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        {/* Actions */}
        <div className="px-6 py-5 flex items-center gap-2">
          <button
            type="button"
            onClick={download}
            className="flex-1 px-4 py-2 bg-amber-400/15 border border-amber-400/50 text-amber-100 rounded-lg hover:bg-amber-400/25 transition-colors text-sm font-medium"
          >
            下载插件
          </button>
          <button
            type="button"
            onClick={openWebsite}
            className="flex-1 px-4 py-2 bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg hover:bg-zinc-700 transition-colors text-sm"
          >
            了解更多功能 →
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="px-4 py-2 text-zinc-400 hover:text-zinc-200 transition-colors text-sm"
          >
            知道了
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
