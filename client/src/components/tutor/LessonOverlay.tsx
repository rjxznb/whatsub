import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  open: boolean;
  /** Esc / backdrop click. Pre-Class can use it freely; mid-lesson the
   *  parent runtime should confirm "确定退出？" before propagating. */
  onClose: () => void;
  children: ReactNode;
}

/** Full-screen takeover overlay shared by all tutor modes. Renders into
 *  document.body via portal so it sits above the player AND the agent
 *  chat bar regardless of where it's mounted from. */
export function LessonOverlay({ open, onClose, children }: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      data-tutor-overlay
      className="fixed inset-0 z-[100] bg-zinc-950/85 backdrop-blur-md flex items-center justify-center p-6 animate-agent-popover-in"
      role="dialog"
      aria-modal="true"
      aria-label="私教课"
    >
      {children}
    </div>,
    document.body,
  );
}
