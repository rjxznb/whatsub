import { useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";

const PLUGIN_DOWNLOAD_URL = "https://whatsub.eversay.cc/download/plugin";
// "了解更多功能" target — the plugin's feature/landing page where the user
// can watch full walkthroughs. Adjust if the public URL changes.
const PLUGIN_WEBSITE_URL = "https://whatsub.eversay.cc/plugin";
// Demo clip showing the highlight-on-web → appears-in-desktop flow. Drop a
// short muted mp4 (or gif → switch the <video> for an <img>) at
// client/public/help/corpus-plugin-sync.mp4. Missing file → placeholder.
const DEMO_VIDEO_SRC = "/help/corpus-plugin-sync.mp4";

interface Props {
  /** Dismiss the tour (✕ / backdrop / 知道了). Persists corpusTourSeen. */
  onDismiss: () => void;
}

/**
 * Single-modal onboarding for the corpus page's plugin-sync feature.
 *
 * Flow per the product ask:
 *   1. Announce: this is the new plugin-sync feature.
 *   2. Show a short demo clip — highlight a phrase on any web page with
 *      the plugin, then watch it appear in the desktop corpus.
 *   3. Point users at the plugin website for the full feature tour.
 */
export function CorpusTour({ onDismiss }: Props) {
  const [mediaFailed, setMediaFailed] = useState(false);

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
        {/* Header — new-feature announcement */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-4">
          <div className="h-10 w-10 rounded-full bg-amber-400/15 border border-amber-400/40 flex items-center justify-center text-xl">
            🔌
          </div>
          <div className="flex-1">
            <div className="text-[11px] uppercase tracking-wide text-amber-300/80 font-medium">
              新功能
            </div>
            <h2 className="text-lg font-semibold text-zinc-100">插件同步</h2>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            title="关闭"
            className="h-8 w-8 flex items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            ✕
          </button>
        </div>

        <p className="px-6 text-sm text-zinc-300 leading-relaxed">
          装上浏览器插件，在任意英文网页上
          <span className="text-amber-200 font-medium">划词</span>
          一键保存，桌面端这里
          <span className="text-amber-200 font-medium">立刻同步</span>
          就能查到例句和出处。
        </p>

        {/* Demo clip — highlight on web → appears in desktop */}
        <div className="px-6 py-4">
          <div className="rounded-xl overflow-hidden border border-zinc-800 bg-black aspect-video">
            {mediaFailed ? (
              <div className="h-full w-full flex flex-col items-center justify-center gap-2 text-zinc-600 text-sm">
                <span className="text-3xl">🎬</span>
                <span>演示动画</span>
                <span className="text-xs text-zinc-700">
                  （放置于 public/help/corpus-plugin-sync.mp4）
                </span>
              </div>
            ) : (
              <video
                src={DEMO_VIDEO_SRC}
                autoPlay
                loop
                muted
                playsInline
                className="h-full w-full object-cover"
                onError={() => setMediaFailed(true)}
              />
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="px-6 pb-6 flex items-center gap-2">
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
