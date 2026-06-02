// src/components/agent/AtMenu.tsx
//
// "@" reference picker shown while the user types "@..." in the chat input —
// lists Library videos to reference. Same portal/positioning/close pattern as
// SlashMenu/ToolsPopover (data-agent-popover so it doesn't collapse the panel).
// Keyboard nav (↑/↓/Enter) is driven by InputBox.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatTime } from "../../utils/time";

export interface AtVideoItem {
  id: string;
  title: string;
  durationSec?: number;
}

interface Props {
  open: boolean;
  anchorEl: HTMLElement | null;
  items: AtVideoItem[];
  highlight: number;
  onHover: (i: number) => void;
  onPick: (item: AtVideoItem) => void;
  onClose: () => void;
}

export function AtMenu({ open, anchorEl, items, highlight, onHover, onPick, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const width = 320;
    const margin = 8;
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - width - margin));
    const bottom = window.innerHeight - r.top + 8;
    setPos({ left, bottom, width });
  }, [open, anchorEl]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (anchorEl?.contains(t)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [open, anchorEl, onClose]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={panelRef}
      data-no-drag
      data-agent-popover
      role="dialog"
      aria-label="引用库视频"
      className="fixed z-[120] flex flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900/98 shadow-2xl backdrop-blur-xl"
      style={{ left: pos.left, bottom: pos.bottom, width: pos.width, maxHeight: "min(60vh, 440px)" }}
    >
      <div className="shrink-0 border-b border-zinc-800 px-3 py-2 text-[12px] text-zinc-400">
        引用库视频 · 选中后可一键总结 / 找类似
      </div>
      <div className="min-h-0 overflow-y-auto py-1">
        {items.length === 0 && (
          <div className="px-3 py-2 text-[12px] text-zinc-500">没有匹配的视频</div>
        )}
        {items.map((it, i) => (
          <button
            key={it.id}
            type="button"
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(it)}
            className={
              "mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded px-2 py-1 text-left " +
              (i === highlight ? "bg-white/10" : "hover:bg-white/5")
            }
          >
            <span className="text-zinc-500">📹</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-100">{it.title}</span>
            {it.durationSec != null && (
              <span className="shrink-0 text-[11px] text-zinc-500">{formatTime(it.durationSec)}</span>
            )}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
