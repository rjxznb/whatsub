import { useEffect } from "react";
import { createPortal } from "react-dom";

interface Props {
  title: string;
  /** Body text. `\n` is honored (whitespace-pre-line). */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Themed replacement for the OS-native `confirm()` dialog — matches the
 * app's zinc/blue surface (see RenameDialog / ImportChecklistDialog).
 *
 * Rendered via a portal to `document.body` so it positions against the
 * viewport even when the caller sits inside a transformed ancestor (e.g.
 * a framer-motion `layout` Library card — `position: fixed` would
 * otherwise be relative to that card's transform box).
 *
 * Enter = confirm, Esc / backdrop-click = cancel.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "确定",
  cancelLabel = "取消",
  onConfirm,
  onClose,
}: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter") {
        onConfirm();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onConfirm, onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-5 w-[420px] max-w-[calc(100vw-2rem)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-zinc-100 mb-2">{title}</h2>
        <p className="text-sm text-zinc-400 leading-relaxed whitespace-pre-line mb-4">
          {message}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-zinc-300 hover:text-zinc-100"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className="px-4 py-1.5 bg-blue-500 hover:bg-blue-400 text-black text-sm rounded font-medium"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
