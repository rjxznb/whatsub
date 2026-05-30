import { useState, useEffect, useRef, useMemo } from "react";
import { Send, Square } from "lucide-react";
import { useAgent } from "../../store/agent";

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

/**
 * Chat input with terminal-style ↑/↓ history navigation through the active
 * conversation's prior user messages.
 *
 * History semantics (mirrors bash / zsh):
 *   - First ↑ saves any in-progress draft, then jumps to the newest user
 *     message.
 *   - Each subsequent ↑ moves one step further back; at the oldest message
 *     ↑ is a no-op (no wraparound).
 *   - ↓ moves forward through history; going past the newest restores the
 *     saved draft and exits nav mode.
 *   - Typing anything (other than the same string that was recalled) exits
 *     nav mode immediately — the user is now editing, not browsing.
 *   - Submit clears nav state.
 */
export function InputBox({
  streaming,
  noLlm,
  initialValue,
  onSend,
  onStop,
}: Props) {
  const [text, setText] = useState(initialValue ?? "");
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [savedDraft, setSavedDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Subscribe to the active conversation's messages directly (stable reference
  // managed by the store) and derive `userMessages` via useMemo so the
  // selector itself never returns a fresh array — that would cause
  // useSyncExternalStore to fire an infinite re-render loop.
  const messages = useAgent((s) => {
    const conv = s.history.conversations.find(
      (c) => c.id === s.history.activeConversationId,
    );
    return conv?.messages;
  });
  const userMessages = useMemo(
    () =>
      messages
        ?.filter(
          (m): m is Extract<typeof m, { role: "user" }> => m.role === "user",
        )
        .map((m) => m.content) ?? [],
    [messages],
  );

  // Sync external initialValue changes (suggestion click)
  useEffect(() => {
    if (initialValue) {
      setText(initialValue);
      setHistoryIndex(null);
      setSavedDraft("");
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
    setHistoryIndex(null);
    setSavedDraft("");
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    // If user is browsing history but starts editing the recalled text,
    // exit nav mode so subsequent ↑ starts fresh from the newest.
    if (historyIndex !== null && next !== userMessages[historyIndex]) {
      setHistoryIndex(null);
    }
    setText(next);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }

    if (userMessages.length === 0) return;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (historyIndex === null) {
        setSavedDraft(text);
        const idx = userMessages.length - 1;
        setHistoryIndex(idx);
        setText(userMessages[idx]);
        return;
      }
      if (historyIndex > 0) {
        const idx = historyIndex - 1;
        setHistoryIndex(idx);
        setText(userMessages[idx]);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      if (historyIndex === null) return; // pass through (default cursor behavior)
      e.preventDefault();
      if (historyIndex < userMessages.length - 1) {
        const idx = historyIndex + 1;
        setHistoryIndex(idx);
        setText(userMessages[idx]);
      } else {
        // Past the newest → restore saved draft, exit nav
        setHistoryIndex(null);
        setText(savedDraft);
      }
      return;
    }
  };

  const placeholder = noLlm
    ? "请先配置 LLM 后再使用"
    : streaming
      ? "agent 正在思考…"
      : "问点什么…";

  return (
    // px-2 horizontal padding only; no vertical padding so the bar's height
    // equals the button's height (h-9 = 36) + the bar's own border. items-end
    // keeps the send button anchored to the bottom row when the textarea
    // auto-grows for multi-line input.
    <div className="flex items-end gap-2 px-2">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKey}
        placeholder={placeholder}
        disabled={noLlm}
        rows={1}
        className="flex-1 resize-none rounded-md bg-transparent text-[14px] text-zinc-100 placeholder-zinc-500 px-2 py-2 focus:outline-none disabled:opacity-50"
        aria-label="输入消息"
      />
      {streaming ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="停止"
          className="h-9 w-9 shrink-0 grid place-items-center rounded-md bg-rose-500/80 hover:bg-rose-500 text-white"
        >
          <Square size={14} />
        </button>
      ) : (
        // Disabled style uses explicit colors (NOT opacity reduction) so the
        // button + icon stay legible on the bar's dark backdrop. Active state
        // is bright white-on-dark so it pops as the obvious primary action.
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label="发送"
          className={
            "h-9 w-9 shrink-0 grid place-items-center rounded-md transition-colors " +
            (canSend
              ? "bg-zinc-100 hover:bg-white text-zinc-900"
              : "bg-zinc-700 text-zinc-400 cursor-not-allowed")
          }
        >
          <Send size={14} />
        </button>
      )}
    </div>
  );
}
