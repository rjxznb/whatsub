// src/components/AppDialog.tsx
//
// Renders the current app-styled dialog (see store/appDialog.ts). Mounted once
// at app root. Matches the app's modal style (dark card + blue/rose buttons).

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useAppDialog } from "../store/appDialog";

export function AppDialog() {
  const queue = useAppDialog((s) => s.queue);
  const resolveTop = useAppDialog((s) => s.resolveTop);
  const cur = queue[0];
  const isConfirm = cur?.kind === "confirm";

  // Esc → cancel (confirm) / dismiss (info); Enter → OK. Capture phase so it
  // wins over page-level key handlers while the dialog is up.
  useEffect(() => {
    if (!cur) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        resolveTop(!isConfirm); // info: Esc closes (true); confirm: Esc cancels
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        resolveTop(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cur, isConfirm, resolveTop]);

  if (!cur) return null;

  return createPortal(
    <div
      data-agent-popover
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) resolveTop(!isConfirm);
      }}
    >
      <div className="w-[420px] max-w-[90vw] rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl animate-agent-popover-in">
        {cur.title && (
          <h2 className="mb-2 text-base font-semibold text-zinc-100">
            {cur.title}
          </h2>
        )}
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
          {cur.message}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          {isConfirm && (
            <button
              type="button"
              onClick={() => resolveTop(false)}
              className="px-3 py-1.5 text-sm text-zinc-300 hover:text-zinc-100 transition-colors"
            >
              {cur.cancelText ?? "取消"}
            </button>
          )}
          <button
            type="button"
            autoFocus
            onClick={() => resolveTop(true)}
            className={
              "px-4 py-1.5 rounded text-sm font-medium transition-colors " +
              (cur.danger
                ? "bg-rose-500 hover:bg-rose-400 text-white"
                : "bg-blue-500 hover:bg-blue-400 text-black")
            }
          >
            {cur.okText ?? (isConfirm ? "确定" : "好")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
