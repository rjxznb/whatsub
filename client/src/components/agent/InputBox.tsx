import { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { Send, Square } from "lucide-react";
import { useAgent } from "../../store/agent";

// ────────────────────────────────────────────────────────────────────────────
// Animated placeholder ("typewriter") — cycles through these prompts when
// the textarea is empty and idle. Each phrase is typed character-by-character,
// held for a beat, then deleted character-by-character before the next one.
// ────────────────────────────────────────────────────────────────────────────
const PLACEHOLDER_PHRASES = [
  "找几个 medical 场景的视频",
  "解释一下这一段对话",
  "把这段话加到生词本",
  "从云端下载这个视频",
  "查 “appointment” 的用法",
  "出 5 道题考考我",
];

const TYPE_MS = 90;
const HOLD_MS = 1600;
const DELETE_MS = 35;
const BETWEEN_MS = 400;

/** Drives a typewriter animation through `phrases` when `active` is true.
 *  Pauses (preserving state) when active flips false; resumes from the same
 *  spot when it flips back. Returns the currently-visible substring. */
function useTypewriter(active: boolean, phrases: string[]): string {
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [charsShown, setCharsShown] = useState(0);
  const [phase, setPhase] = useState<
    "typing" | "holding" | "deleting" | "between"
  >("typing");

  useEffect(() => {
    if (!active) return;
    const phrase = phrases[phraseIdx] ?? "";
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (phase === "typing") {
      if (charsShown < phrase.length) {
        timeout = setTimeout(() => setCharsShown((c) => c + 1), TYPE_MS);
      } else {
        timeout = setTimeout(() => setPhase("holding"), 0);
      }
    } else if (phase === "holding") {
      timeout = setTimeout(() => setPhase("deleting"), HOLD_MS);
    } else if (phase === "deleting") {
      if (charsShown > 0) {
        timeout = setTimeout(() => setCharsShown((c) => c - 1), DELETE_MS);
      } else {
        timeout = setTimeout(() => setPhase("between"), 0);
      }
    } else {
      // between phrases
      timeout = setTimeout(() => {
        setPhraseIdx((i) => (i + 1) % phrases.length);
        setPhase("typing");
      }, BETWEEN_MS);
    }

    return () => {
      if (timeout) clearTimeout(timeout);
    };
  }, [active, phraseIdx, charsShown, phase, phrases]);

  return (phrases[phraseIdx] ?? "").slice(0, charsShown);
}

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
  const [isFocused, setIsFocused] = useState(false);
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

  // Auto-resize for multi-line ONLY. Empty text takes a fast path that
  // skips scrollHeight measurement entirely — during the icon→bar stretch
  // animation the textarea is briefly in a ~40px-wide container; the
  // typewriter placeholder visually wraps to multiple lines, and the
  // browser's scrollHeight reports the wrapped height (~80-100px) instead
  // of the unwrapped single-line target. Without this fast path, the
  // inflated value persists in the inline height after the bar reaches
  // its final 600px width and the bar appears way too tall until the
  // user types (which re-triggers the useLayoutEffect with non-empty
  // text and a sane scrollHeight).
  //
  // useLayoutEffect (not useEffect): runs synchronously after DOM
  // mutation, BEFORE the browser paints — no one-frame UA-default-size
  // flash on first mount either.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (text.length === 0) {
      el.style.height = "36px";
      return;
    }
    el.style.height = "auto";
    const natural = el.scrollHeight;
    const isMultiLine = text.includes("\n") || natural > 40;
    el.style.height = (isMultiLine ? Math.min(natural, 96) : 36) + "px";
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

  // Animated typewriter placeholder — cycles through example prompts ONLY
  // when the textarea is empty, agent is idle, AND the textarea is NOT
  // focused. As soon as the user clicks in (cursor blink starts), the
  // animation pauses (state preserved); it resumes when focus leaves
  // (e.g., the user closes the panel back to bar).
  const typewriterIdle =
    text.length === 0 && !noLlm && !streaming && !isFocused;
  const typedPlaceholder = useTypewriter(typewriterIdle, PLACEHOLDER_PHRASES);
  const placeholder = noLlm
    ? "请先配置 LLM 后再使用"
    : streaming
      ? "agent 正在思考…"
      : isFocused
        ? "" // focused but empty: no placeholder, just the cursor
        : typedPlaceholder || "问点什么…";

  return (
    // px-2 horizontal + py-1.5 vertical padding gives the button a small
    // breathing margin (6px above + below) inside the bar. items-end keeps
    // the send button anchored to the bottom row when the textarea
    // auto-grows for multi-line input.
    //
    // minHeight: 48 = BAR_H (50) - bar border (2). Guarantees the input box
    // area never collapses below the "a" baseline the user sees on the
    // first paint — important inside panel mode where the bar's own
    // min-height: 50 isn't active (panel uses explicit height instead).
    // Without this, typing inside panel mode could shrink the bottom input
    // box to just the textarea's scrollHeight.
    <div
      className="flex items-end gap-2 px-2 py-1.5"
      style={{ minHeight: 48 }}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKey}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        placeholder={placeholder}
        disabled={noLlm}
        rows={1}
        // Explicit initial height = 36 so the very first paint matches the
        // post-useLayoutEffect steady state (no first-frame flash at UA
        // default size before the resize logic runs).
        style={{ height: 36, minHeight: 36, maxHeight: 96 }}
        className="flex-1 resize-none rounded-md bg-transparent text-[14px] text-zinc-100 placeholder-zinc-500 px-2 py-1.5 leading-tight focus:outline-none disabled:opacity-50"
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
