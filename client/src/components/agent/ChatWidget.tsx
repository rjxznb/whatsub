import { Bot } from "lucide-react";

interface Props {
  open: boolean;
  hasUnread: boolean;
  onClick: () => void;
}

export function ChatWidget({ open, hasUnread, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={open ? "关闭 AI 助手" : "打开 AI 助手"}
      className="fixed bottom-5 right-5 z-50 h-14 w-14 grid place-items-center rounded-full bg-blue-500/95 backdrop-blur-sm hover:bg-blue-400 transition-colors shadow-lg"
    >
      <Bot size={28} className="text-white" />
      {hasUnread && !open && (
        <span
          className="absolute top-1 right-1 h-2 w-2 rounded-full bg-rose-500"
          aria-hidden="true"
        />
      )}
    </button>
  );
}
