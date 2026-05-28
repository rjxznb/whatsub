import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** Optional hover hint shown as a themed tooltip next to the item.
   *  Use when the action's behavior isn't obvious from the label alone
   *  (e.g. "删除文件夹" — but only deletes the folder, not its videos). */
  description?: string;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** When provided, mousedowns inside this element do NOT auto-close the menu.
   *  Use this when the anchor that opens the menu also needs to toggle it
   *  closed on re-click — otherwise the outside-click handler fires first and
   *  the anchor's onClick reopens. */
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export function ContextMenu({ x, y, items, onClose, anchorRef }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorRef]);

  // Clamp position so the menu doesn't overflow the viewport.
  const adjustedX = Math.min(x, window.innerWidth - 200);
  const adjustedY = Math.min(y, window.innerHeight - items.length * 32 - 8);

  return (
    <div
      ref={ref}
      style={{ left: adjustedX, top: adjustedY }}
      className="fixed z-[100] bg-zinc-900 border border-zinc-700 rounded shadow-xl py-1 min-w-[180px]"
    >
      {items.map((item, i) => (
        // Wrapper + group so `group-hover:` reveals the description tooltip
        // next to the row. `relative` anchors the tooltip's absolute pos.
        <div key={i} className="group relative">
          <button
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className={
              "w-full px-3 py-1.5 text-left text-sm hover:bg-zinc-800 " +
              (item.danger ? "text-red-400" : "text-zinc-200")
            }
          >
            {item.label}
          </button>
          {item.description && (
            <div
              role="tooltip"
              className="hidden group-hover:block absolute left-full top-0 ml-2 z-[110] w-56 px-2.5 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-xs leading-relaxed text-zinc-300 shadow-lg pointer-events-none whitespace-normal"
            >
              {item.description}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
