import { useState, useEffect, useRef } from "react";
import { Send, Square } from "lucide-react";

interface Props {
  /** True while a runtime turn is in flight; toggles send→stop button. */
  streaming?: boolean;
  /** True when no LLM is configured; disables input entirely. */
  noLlm?: boolean;
  /** Pre-fill the textarea (used by EmptyState suggestion clicks). */
  initialValue?: string;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function InputBox({ streaming, noLlm, initialValue, onSend, onStop }: Props) {
  const [text, setText] = useState(initialValue ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync external initialValue changes (suggestion click)
  useEffect(() => {
    if (initialValue) {
      setText(initialValue);
    }
  }, [initialValue]);

  // Auto-resize
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 96) + "px";
  }, [text]);

  const canSend = !streaming && !noLlm && text.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder = noLlm
    ? "请先配置 LLM 后再使用"
    : streaming
      ? "agent 正在思考…"
      : "问点什么…";

  return (
    <div className="flex items-end gap-2 p-2">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKey}
        placeholder={placeholder}
        disabled={noLlm}
        rows={1}
        className="flex-1 resize-none rounded bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 placeholder-zinc-500 px-2 py-1.5 focus:outline-none focus:border-blue-500 disabled:opacity-50"
        aria-label="输入消息"
      />
      {streaming ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="停止"
          className="h-8 w-8 grid place-items-center rounded bg-rose-500 hover:bg-rose-400 text-white"
        >
          <Square size={14} />
        </button>
      ) : (
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label="发送"
          className="h-8 w-8 grid place-items-center rounded bg-blue-500 hover:bg-blue-400 disabled:opacity-40 disabled:cursor-not-allowed text-white"
        >
          <Send size={14} />
        </button>
      )}
    </div>
  );
}
