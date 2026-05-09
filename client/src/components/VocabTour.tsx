import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Two-step first-visit tour for the vocab page.
 *
 * Step 1 — "card":
 *   Dim the page, cut a hole around the first vocab card (real OR the
 *   demo placeholder used when entries.length === 0), float a tooltip
 *   "双击我试试 ✨". Auto-advances when the user double-clicks any
 *   vocab card.
 *
 * Step 2 — "bubble":
 *   The note bubble is now mounted (the double-click opened it in peek
 *   mode). Re-anchor the dim cutout + tooltip to the bubble's rect,
 *   prompt "点击气泡开始记笔记 ✏️". Auto-dismisses when the user
 *   clicks anywhere inside the bubble (peek → edit transition) or hits
 *   "知道了".
 *
 * Element discovery is via data attributes (`data-vocab-card="true"` +
 * `data-bubble="true"`) so the tour doesn't need refs threaded through
 * 4 layers of nested components or portals.
 */

interface Props {
  step: "card" | "bubble";
  onAdvance: () => void;
  onDismiss: () => void;
}

export function VocabTour({ step, onAdvance, onDismiss }: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Re-measure the target element on mount, on step change, and on
  // resize/scroll. For step="bubble" the bubble is mounted just-in-time
  // (after the user's double-click), so we poll briefly until it shows
  // up rather than measuring once on RAF — the bubble has its own
  // measurement effects that take a couple of frames to settle.
  useEffect(() => {
    const selector =
      step === "card" ? '[data-vocab-card="true"]' : '[data-bubble="true"]';
    function update() {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) setRect(el.getBoundingClientRect());
    }

    // Reset rect on step change so the previous step's cutout doesn't
    // briefly flash at the wrong location while we wait for the new
    // target element to mount.
    setRect(null);

    let attempts = 0;
    const interval = window.setInterval(() => {
      update();
      attempts++;
      // 30 attempts × 50ms = 1.5s; covers any sane mount delay. After
      // that we give up — staying open on a missing target would just
      // pin the tour against a stale rect.
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

  // Step transitions:
  //   card → bubble: any double-click on a vocab card
  //   bubble → done: any click inside the note bubble
  // Both listeners are document-level (capture: false) so they fire
  // AFTER the underlying card/bubble's own React handlers — ensuring
  // the bubble actually mounts (or transitions to edit mode) before
  // our tour state updates trigger their own re-render.
  useEffect(() => {
    if (step === "card") {
      function onDblClick(e: MouseEvent) {
        const target = e.target as HTMLElement | null;
        if (target?.closest('[data-vocab-card="true"]')) {
          onAdvance();
        }
      }
      document.addEventListener("dblclick", onDblClick);
      return () => document.removeEventListener("dblclick", onDblClick);
    }
    if (step === "bubble") {
      function onClick(e: MouseEvent) {
        const target = e.target as HTMLElement | null;
        if (target?.closest('[data-bubble="true"]')) {
          onDismiss();
        }
      }
      document.addEventListener("click", onClick);
      return () => document.removeEventListener("click", onClick);
    }
  }, [step, onAdvance, onDismiss]);

  if (!rect) return null;

  // Padding around the cutout. The bubble is much taller than a card
  // so we use a tighter pad for it (otherwise the dim "frame" feels
  // disproportionate to the highlighted region).
  const PAD = step === "card" ? 12 : 8;
  const cutoutX = rect.left - PAD;
  const cutoutY = rect.top - PAD;
  const cutoutW = rect.width + PAD * 2;
  const cutoutH = rect.height + PAD * 2;

  // Tooltip placement: prefer below; fall back above if no room.
  const TIP_HEIGHT_APPROX = 48;
  const tipBelow = rect.bottom + TIP_HEIGHT_APPROX + 24 < window.innerHeight;
  const tipTop = tipBelow ? rect.bottom + 18 : rect.top - TIP_HEIGHT_APPROX - 12;
  const tipCenter = rect.left + rect.width / 2;
  const tipLeft = Math.max(
    16,
    Math.min(window.innerWidth - 16, tipCenter),
  );

  const message =
    step === "card" ? "双击卡片试试 ✨" : "点击气泡开始记笔记 ✏️";

  return createPortal(
    <div className="animate-vocab-tour-fade-in">
      {/* Dim overlay using SVG mask. The mask creates a hole around the
          target element so it stays fully visible underneath. pointer-
          events: none so the underlying card/bubble's own click and
          double-click handlers run unimpeded — the tour observes via
          document-level listeners rather than intercepting. */}
      <svg
        className="fixed inset-0 z-[200] pointer-events-none"
        width="100%"
        height="100%"
        aria-hidden
      >
        <defs>
          <mask id="vocab-tour-mask">
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
          mask="url(#vocab-tour-mask)"
        />
        {/* Pulsing amber ring draws the eye to the cutout. */}
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
        className="fixed z-[201] px-4 py-2.5 bg-zinc-900 border border-amber-400/50 text-amber-100 rounded-lg shadow-2xl text-sm whitespace-nowrap flex items-center gap-3"
        style={{
          top: tipTop,
          left: tipLeft,
          transform: "translateX(-50%)",
        }}
      >
        <span className="font-medium">{message}</span>
        <span className="text-zinc-600">·</span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-zinc-400 hover:text-zinc-200 text-xs transition-colors"
        >
          跳过引导
        </button>
      </div>
    </div>,
    document.body,
  );
}
