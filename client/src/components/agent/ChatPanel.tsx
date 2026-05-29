import { useEffect } from "react";
import { ConversationHeader } from "./ConversationHeader";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Body — typically MessageList in real use; tests pass a div. */
  children?: React.ReactNode;
  /** Optional input row slot (InputBox lands here in T25). */
  inputBox?: React.ReactNode;
}

export function ChatPanel({ open, onClose, children, inputBox }: Props) {
  // Esc closes
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="AI 助手"
      className="fixed bottom-[84px] right-5 z-50 w-[380px] h-[560px] flex flex-col bg-zinc-900/95 backdrop-blur-xl border border-zinc-800 rounded-lg shadow-2xl overflow-hidden"
    >
      <ConversationHeader onClose={onClose} />
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
      {inputBox && <div className="border-t border-zinc-800">{inputBox}</div>}
    </div>
  );
}
