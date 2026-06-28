import { useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

// The plugin's website — install instructions + feature walkthroughs. Both
// the "下载插件" and "了解更多功能" buttons go here. Adjust if the URL changes.
const PLUGIN_WEBSITE_URL = "https://whatsub.eversay.cc/plugin";

interface Slide {
  badge: string;
  icon: string;
  /** Optional image icon (e.g. an SVG under client/public). When set it
   *  replaces the emoji `icon`. */
  iconSrc?: string;
  title: string;
  desc: string;
  /** Demo clip. Drop a short muted mp4 at the path under client/public.
   *  Missing file → 🎬 placeholder. */
  media: string;
}

const SLIDES: Slide[] = [
  {
    badge: "公共语料库",
    icon: "📚",
    iconSrc: "/icons/corpus.svg",
    title: "精选实用英语短语",
    desc: "精选地道英语短语，每条带中文释义和重点笔记，并标注它出自哪个视频；可按视频来源或标签浏览，点 ▶ 时间戳就能跳到原视频对应位置听原声。",
    media: "/help/feature-subtitles.mp4",
  },
  {
    badge: "我的语料库",
    icon: "⭐",
    title: "随手收藏 · 多端同步",
    desc: "在桌面端字幕里、或用浏览器插件在任意英文网页划词，一键收藏到你的个人语料库，多设备自动同步、随时回看。",
    media: "/help/feature-plugin-sync.mp4",
  },
];

interface Props {
  /** Dismiss the tour (✕ / backdrop / 知道了). Persists corpusTourSeen. */
  onDismiss: () => void;
}

/**
 * Left/right paging onboarding for the corpus page. Two slides introducing
 * what the 语料库 IS (not the plugin / subtitle pitch it used to show):
 *   1. 公共语料库 — browse curated phrases by scene / video source / tag
 *   2. 我的语料库 — save phrases (desktop or plugin) → multi-device sync
 *
 * Slides translate horizontally on a flex track (same pattern as the
 * corpus mode switcher). Prev/next arrows + dot indicators drive paging.
 */
export function CorpusTour({ onDismiss }: Props) {
  const [page, setPage] = useState(0);
  const [failed, setFailed] = useState<Set<number>>(new Set());

  const last = SLIDES.length - 1;
  const go = (next: number) => setPage(Math.max(0, Math.min(last, next)));

  function openPluginSite() {
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
            语料库介绍
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
                    {slide.iconSrc ? (
                      <img src={slide.iconSrc} alt="" className="h-6 w-6" />
                    ) : (
                      slide.icon
                    )}
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

        {/* Action — 下载插件 is the primary CTA (the plugin fills 我的语料库);
            a small 知道了 below dismisses. */}
        <div className="px-6 py-5 space-y-2">
          <button
            type="button"
            onClick={openPluginSite}
            className="w-full px-4 py-2 bg-amber-400/15 border border-amber-400/50 text-amber-100 rounded-lg hover:bg-amber-400/25 transition-colors text-sm font-medium"
          >
            下载插件
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="w-full text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            知道了
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
