import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
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
  }, [onClose]);

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
        <button
          key={i}
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
      ))}
    </div>
  );
}
