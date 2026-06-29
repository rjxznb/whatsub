// src/components/agent/AgentTour.tsx
//
// First-run coachmark for the AI 助手 (private tutor). Two steps:
//   ① point at the ChatBar  → "open it"          (advances once the panel opens)
//   ② point at the ⌘ tools  → "click the tools"  (inside the panel)
//
// Non-blocking: a pulsing amber ring + a tooltip, both above the ChatBar's
// z-50. The ring is pointer-events:none so the user can actually click the
// highlighted target to advance. The target rect is tracked every frame
// because the ChatBar is draggable and animates between modes.

import { useEffect, useState } from "react";
import type { ChatBarMode } from "./ChatBar";

const TOUR_KEY = "agentTourSeen";

export function shouldShowAgentTour(): boolean {
  try {
    return !localStorage.getItem(TOUR_KEY);
  } catch {
    return false;
  }
}

export function markAgentTourSeen(): void {
  try {
    localStorage.setItem(TOUR_KEY, "1");
  } catch {
    /* localStorage unavailable — ignore */
  }
}

interface Props {
  mode: ChatBarMode;
  onDismiss: () => void;
}

const TIP_W = 264;

export function AgentTour({ mode, onDismiss }: Props) {
  const step: 1 | 2 = mode === "panel" ? 2 : 1;
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    let raf = 0;
    const sel = step === 1 ? "[data-agent-chatbar]" : "[data-agent-tools-btn]";
    const tick = () => {
      const el = document.querySelector(sel) as HTMLElement | null;
      const r = el?.getBoundingClientRect() ?? null;
      setRect(r && r.width > 0 && r.height > 0 ? r : null);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [step]);

  if (!rect) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Place the tooltip on whichever side of the target has more room.
  const placeAbove = rect.top > vh - rect.bottom;
  const gap = 14;
  let left = rect.left + rect.width / 2 - TIP_W / 2;
  left = Math.max(12, Math.min(left, vw - TIP_W - 12));

  const title = step === 1 ? "认识一下你的 AI 私教" : "这里是工具箱";
  const desc =
    step === 1
      ? "点开它 —— 可以用中文问任何英语问题，还能让它精讲字幕、陪你角色扮演、按你的薄弱点推荐复习。"
      : "点这个 ⌘ 按钮打开工具箱：精讲、角色扮演、查词、推荐复习、管理生词本…… AI 能帮你做的都在里面。";

  return (
    <>
      {/* pulsing highlight ring around the target (non-interactive) */}
      <div
        className="fixed z-[9998] pointer-events-none rounded-xl border-2 border-amber-400 animate-pulse"
        style={{
          left: rect.left - 5,
          top: rect.top - 5,
          width: rect.width + 10,
          height: rect.height + 10,
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
          transition: "left 120ms ease-out, top 120ms ease-out, width 120ms, height 120ms",
        }}
      />
      {/* tooltip card */}
      <div
        className="fixed z-[9999] rounded-lg border border-amber-400/40 bg-zinc-900 p-3.5 shadow-2xl"
        style={{
          width: TIP_W,
          left,
          top: placeAbove ? undefined : rect.bottom + gap,
          bottom: placeAbove ? vh - rect.top + gap : undefined,
        }}
      >
        <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-amber-300">
          <span>{step === 1 ? "①" : "②"}</span>
          <span>{title}</span>
        </div>
        <p className="text-xs leading-relaxed text-zinc-300">{desc}</p>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[10px] text-zinc-500">{step} / 2</span>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded px-2.5 py-1 text-xs text-zinc-400 hover:text-zinc-200"
          >
            {step === 1 ? "跳过" : "知道了"}
          </button>
        </div>
      </div>
    </>
  );
}
