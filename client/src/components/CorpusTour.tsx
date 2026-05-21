import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";

const PLUGIN_DOWNLOAD_URL = "https://whatsub.eversay.cc/download/plugin";

/**
 * Two-step onboarding tour for the corpus page.
 *
 * Step 1 — "welcome":
 *   Centered modal explaining the three-part workflow: install the
 *   browser plugin → highlight phrases on any web page → click the
 *   refresh button here to sync. Primary CTA opens the plugin
 *   download URL in the system browser.
 *
 * Step 2 — "refresh":
 *   Dim the page, cut a hole around the refresh button (queried via
 *   data-corpus-refresh="true"), float a tooltip "保存完点这里刷新同步".
 *   Auto-advances to dismiss when the user clicks 知道了.
 */

type Step = "welcome" | "refresh";

interface Props {
  step: Step;
  onAdvance: () => void;
  onDismiss: () => void;
}

export function CorpusTour({ step, onAdvance, onDismiss }: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Step 2 only — measure the refresh button so the cutout / tooltip
  // can anchor to it. Poll briefly because the button mounts inside
  // CorpusNav which itself only renders once auth status flips.
  useEffect(() => {
    if (step !== "refresh") {
      setRect(null);
      return;
    }
    function update() {
      const el = document.querySelector<HTMLElement>(
        '[data-corpus-refresh="true"]'
      );
      if (el) setRect(el.getBoundingClientRect());
    }
    update();
    let attempts = 0;
    const interval = window.setInterval(() => {
      update();
      attempts++;
      if (attempts > 30) window.clearInterval(interval);
    }, 50);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [step]);

  function handleDownload() {
    openUrl(PLUGIN_DOWNLOAD_URL).catch((err) =>
      console.error("open plugin download failed", err)
    );
  }

  if (step === "welcome") {
    return createPortal(
      <div className="fixed inset-0 z-[200] flex items-center justify-center animate-vocab-tour-fade-in">
        <div
          className="absolute inset-0 bg-black/65 backdrop-blur-sm pointer-events-auto"
          onClick={onDismiss}
        />
        <div className="relative pointer-events-auto max-w-md w-[90%] bg-zinc-900 border border-amber-400/40 rounded-2xl shadow-2xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-amber-400/15 border border-amber-400/40 flex items-center justify-center text-xl">
              📚
            </div>
            <h2 className="text-lg font-semibold text-zinc-100">
              语料库 · 入门
            </h2>
          </div>
          <p className="text-sm text-zinc-300 leading-relaxed">
            在浏览英文网页时遇到地道短语，划词一键存入你的私人语料库 —
            桌面端这里就能查回所有保存的例句和来源。
          </p>
          <ol className="space-y-3 text-sm">
            <li className="flex gap-3">
              <span className="shrink-0 h-6 w-6 rounded-full bg-amber-400/15 border border-amber-400/40 text-amber-200 text-xs flex items-center justify-center font-mono">
                1
              </span>
              <span className="text-zinc-300 pt-0.5">
                <span className="text-zinc-100 font-medium">
                  下载浏览器插件
                </span>{" "}
                — 装到 Edge/Chrome，登录与桌面端同一个许可证
              </span>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 h-6 w-6 rounded-full bg-amber-400/15 border border-amber-400/40 text-amber-200 text-xs flex items-center justify-center font-mono">
                2
              </span>
              <span className="text-zinc-300 pt-0.5">
                <span className="text-zinc-100 font-medium">划词保存</span> —
                网页上选中短语，弹窗里填中文翻译、笔记、标签
              </span>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 h-6 w-6 rounded-full bg-amber-400/15 border border-amber-400/40 text-amber-200 text-xs flex items-center justify-center font-mono">
                3
              </span>
              <span className="text-zinc-300 pt-0.5">
                <span className="text-zinc-100 font-medium">回到这里</span> —
                点右上 ↻ 刷新，新保存的短语和例句出处同步过来
              </span>
            </li>
          </ol>
          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={handleDownload}
              className="flex-1 px-4 py-2 bg-amber-400/15 border border-amber-400/50 text-amber-100 rounded-lg hover:bg-amber-400/25 transition-colors text-sm font-medium"
            >
              下载浏览器插件 →
            </button>
            <button
              type="button"
              onClick={onAdvance}
              className="px-4 py-2 bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg hover:bg-zinc-700 transition-colors text-sm"
            >
              下一步
            </button>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onDismiss}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              跳过引导
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  // Step 2 — anchor on refresh button
  if (!rect) return null;
  const PAD = 6;
  const cutoutX = rect.left - PAD;
  const cutoutY = rect.top - PAD;
  const cutoutW = rect.width + PAD * 2;
  const cutoutH = rect.height + PAD * 2;

  // Tooltip below the button, right-aligned (refresh is in top-right).
  const tipTop = rect.bottom + 14;
  const tipRight = window.innerWidth - rect.right - PAD - 4;

  return createPortal(
    <div className="fixed inset-0 z-[200] pointer-events-none animate-vocab-tour-fade-in">
      <svg
        className="absolute inset-0 w-full h-full"
        width="100%"
        height="100%"
        aria-hidden
      >
        <defs>
          <mask id="corpus-tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            <rect
              x={cutoutX}
              y={cutoutY}
              width={cutoutW}
              height={cutoutH}
              rx={cutoutH / 2}
              fill="black"
            />
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="rgba(0, 0, 0, 0.65)"
          mask="url(#corpus-tour-mask)"
        />
        <rect
          x={cutoutX - 1}
          y={cutoutY - 1}
          width={cutoutW + 2}
          height={cutoutH + 2}
          rx={cutoutH / 2 + 1}
          fill="none"
          stroke="rgb(251, 191, 36)"
          strokeWidth="2"
          className="animate-vocab-tour-pulse"
        />
      </svg>

      <div
        className="absolute pointer-events-auto px-4 py-3 bg-zinc-900 border border-amber-400/50 text-amber-100 rounded-lg shadow-2xl text-sm flex items-center gap-3"
        style={{
          top: tipTop,
          right: tipRight,
          maxWidth: 320,
        }}
      >
        <span className="font-medium whitespace-nowrap">
          保存完点这里 ↻ 同步
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 px-3 py-1 bg-amber-400 text-zinc-900 rounded-md text-xs font-semibold hover:bg-amber-300 transition-colors"
        >
          知道了
        </button>
      </div>
    </div>,
    document.body
  );
}
