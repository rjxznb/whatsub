import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * First-visit guided tour for the Library → Import flow.
 *
 * Four steps, advanced via document-level event listeners + polling.
 * Targets discovered via `data-tour="..."` attributes so we don't
 * thread refs across 3 component boundaries.
 *
 *   import    → 高亮 + Import 按钮.              点击 → "checklist"
 *   checklist → 高亮 ImportChecklistDialog.      用户配好梯子+登录后,
 *                                                checklist 关闭 → "url"
 *                                                (检测 url-input 在 DOM)
 *   url       → 高亮 URL 输入框.                 输入框非空 → "download"
 *                                                (覆盖输入 / 粘贴 / 示例按钮
 *                                                程序化填入三种路径)
 *   download  → 高亮 开始解析 按钮.              点击 → dismiss(结束)
 *
 * `checklist` step不画 dim mask — checklist dialog 本身有 backdrop,
 * 叠两层会显得脏。只画琥珀色脉冲框 + tooltip。
 */

export type LibraryTourStep =
  | "import"
  | "checklist"
  | "url"
  | "download"
  | null;

interface Props {
  step: Exclude<LibraryTourStep, null>;
  onAdvance: (next: LibraryTourStep) => void;
  onDismiss: () => void;
}

interface StepConfig {
  selector: string;
  message: string;
  pad: number;
  /** When true, skip the dark dim mask (target already has its own
   *  backdrop, e.g. the checklist dialog). */
  noDim?: boolean;
}

const STEP_CONFIG: Record<Exclude<LibraryTourStep, null>, StepConfig> = {
  import: {
    selector: '[data-tour="import-button"]',
    message: "👋 欢迎使用 whatsub —— 先点这里开始导入第一个视频",
    pad: 10,
  },
  checklist: {
    selector: '[data-tour="checklist"]',
    message:
      "✅ ① 确认梯子已开 ② 选个站点登录拿 cookies(下载会员/受限内容用),完成后点底部按钮继续",
    pad: 6,
    noDim: true,
  },
  url: {
    selector: '[data-tour="url-input"]',
    message: "🔗 粘贴视频链接,或点输入框下方「试试示例链接」一键填入",
    pad: 8,
  },
  download: {
    selector: '[data-tour="submit-button"]',
    message: "▶️ 一切就绪,点这里开始下载和解析",
    pad: 8,
  },
};

export function LibraryTour({ step, onAdvance, onDismiss }: Props) {
  const config = STEP_CONFIG[step];
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Re-measure target on step change + keep polling for the lifetime
  // of the step (no timeout — user might park on a step for minutes
  // and we want to recover gracefully when the target re-mounts).
  //
  // Two guards added after a real bug: ① skip zero-size rects (target
  // is in DOM but layout hasn't settled — happens during ImportModal
  // mount transition); ② only setState when bounds actually change,
  // so we don't churn React 5×/s when the target is stationary.
  useEffect(() => {
    setRect(null);
    let lastKey = "null";
    function update() {
      const el = document.querySelector<HTMLElement>(config.selector);
      if (!el) {
        if (lastKey !== "null") {
          setRect(null);
          lastKey = "null";
        }
        return;
      }
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        // Element exists but layout pending — wait, don't blank the
        // existing rect (avoids a "flash gone, flash back" cycle).
        return;
      }
      const key = `${r.left},${r.top},${r.width},${r.height}`;
      if (key !== lastKey) {
        setRect(r);
        lastKey = key;
      }
    }
    update();
    const interval = window.setInterval(update, 200);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [config.selector]);

  // Polled advancement for checklist→url and url→download. We poll
  // rather than listen for events because the sample-link button
  // fills the input via React state (no native `input` event), and
  // checklist closure happens through several code paths — polling
  // covers all of them uniformly.
  useEffect(() => {
    function check() {
      if (step === "checklist") {
        if (document.querySelector('[data-tour="url-input"]')) {
          onAdvance("url");
        }
      } else if (step === "url") {
        const el = document.querySelector<HTMLInputElement>(
          '[data-tour="url-input"]',
        );
        if (el && el.value.trim().length > 0) {
          onAdvance("download");
        }
      }
    }
    const interval = window.setInterval(check, 200);
    return () => window.clearInterval(interval);
  }, [step, onAdvance]);

  // Click-based advancement for import/download steps. Document-level
  // so the underlying button's own React onClick runs first/unimpeded.
  useEffect(() => {
    if (step !== "import" && step !== "download") return;
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (step === "import" && target?.closest('[data-tour="import-button"]')) {
        onAdvance("checklist");
      } else if (
        step === "download" &&
        target?.closest('[data-tour="submit-button"]')
      ) {
        onDismiss();
      }
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [step, onAdvance, onDismiss]);

  if (!rect) return null;

  const cutoutX = rect.left - config.pad;
  const cutoutY = rect.top - config.pad;
  const cutoutW = rect.width + config.pad * 2;
  const cutoutH = rect.height + config.pad * 2;

  // Tooltip placement: prefer below; fall back above when near the
  // bottom of the viewport.
  const TIP_HEIGHT_APPROX = 48;
  const tipBelow = rect.bottom + TIP_HEIGHT_APPROX + 24 < window.innerHeight;
  const tipTop = tipBelow ? rect.bottom + 18 : rect.top - TIP_HEIGHT_APPROX - 12;
  const tipCenter = rect.left + rect.width / 2;
  const tipLeft = Math.max(16, Math.min(window.innerWidth - 16, tipCenter));

  return createPortal(
    // Wrapper MUST hold the z-index itself, not delegate to the SVG.
    // The opacity animation here creates a stacking context, so any
    // z-index on children is local to this wrapper — without the
    // outer z-[200] the whole tour stacks at z=auto against siblings,
    // which lets a z-50 ImportModal cover the tour ring + tooltip.
    // pointer-events: none so the gap between SVG and tooltip doesn't
    // capture clicks; tooltip overrides to pointer-events: auto so
    // 跳过引导 still works.
    <div className="fixed inset-0 z-[200] pointer-events-none animate-vocab-tour-fade-in">
      <svg
        className="absolute inset-0 w-full h-full"
        width="100%"
        height="100%"
        aria-hidden
      >
        {/* Dim mask — skipped on noDim steps (checklist dialog already
            has its own backdrop, double-dim looks broken). */}
        {!config.noDim && (
          <>
            <defs>
              <mask id="library-tour-mask">
                <rect x="0" y="0" width="100%" height="100%" fill="white" />
                <rect
                  x={cutoutX}
                  y={cutoutY}
                  width={cutoutW}
                  height={cutoutH}
                  rx={8}
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
              mask="url(#library-tour-mask)"
            />
          </>
        )}
        {/* Pulsing amber ring around the target. */}
        <rect
          x={cutoutX - 1}
          y={cutoutY - 1}
          width={cutoutW + 2}
          height={cutoutH + 2}
          rx={9}
          fill="none"
          stroke="rgb(251, 191, 36)"
          className="animate-vocab-tour-pulse"
        />
      </svg>

      <div
        className="absolute pointer-events-auto px-4 py-2.5 bg-zinc-900 border border-amber-400/50 text-amber-100 rounded-lg shadow-2xl text-sm max-w-[90vw] flex items-center gap-3"
        style={{
          top: tipTop,
          left: tipLeft,
          transform: "translateX(-50%)",
        }}
      >
        <span className="font-medium whitespace-nowrap overflow-hidden text-ellipsis">
          {config.message}
        </span>
        <span className="text-zinc-600 shrink-0">·</span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-zinc-400 hover:text-zinc-200 text-xs shrink-0 transition-colors"
        >
          跳过引导
        </button>
      </div>
    </div>,
    document.body,
  );
}
