import { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { Send, Square, Mic } from "lucide-react";
import { useAgent } from "../../store/agent";
import { useVoiceMode } from "../../store/voiceMode";
import { ToolsPopover } from "./ToolsPopover";
import { CommandIcon } from "./CommandIcon";

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
  /** In the panel, the input row has a user-resized fixed height (ChatBar's
   *  divider). The textarea then FILLS that row (scrolls internally) instead of
   *  auto-growing — so the manual height is respected. Bar mode keeps the
   *  auto-resize behavior. */
  panelMode?: boolean;
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
  panelMode,
  onSend,
  onStop,
}: Props) {
  const [text, setText] = useState(initialValue ?? "");
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [savedDraft, setSavedDraft] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toolsBtnRef = useRef<HTMLButtonElement>(null);

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
    // Panel mode: the input row is a fixed, user-resized height (ChatBar's
    // divider drag) — the textarea fills it and scrolls internally, so we don't
    // auto-resize.
    if (panelMode) {
      el.style.height = "100%";
      return;
    }
    if (text.length === 0) {
      el.style.height = "36px";
      return;
    }
    el.style.height = "auto";
    const natural = el.scrollHeight;
    const isMultiLine = text.includes("\n") || natural > 40;
    el.style.height = (isMultiLine ? Math.min(natural, 96) : 36) + "px";
  }, [text, panelMode]);

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

  // Shared controls — arranged differently per mode below.
  const toolsBtn = (
    <button
      ref={toolsBtnRef}
      type="button"
      onClick={() => setToolsOpen((o) => !o)}
      aria-label="查看所有工具"
      title="Agent 能用的工具"
      className={
        "h-8 w-8 shrink-0 grid place-items-center rounded-full transition-colors " +
        (toolsOpen
          ? "bg-white/10 text-zinc-100"
          : "text-zinc-400 hover:text-zinc-100 hover:bg-white/5")
      }
    >
      <CommandIcon className="h-[15px] w-[15px]" />
    </button>
  );

  // Voice mode toggle — moved here next to the tools button.
  const voiceBtn = (
    <button
      type="button"
      onClick={() => useVoiceMode.getState().openVoice()}
      aria-label="语音模式"
      title="切换到语音模式"
      className="h-8 w-8 shrink-0 grid place-items-center rounded-full text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
    >
      <Mic size={15} />
    </button>
  );

  const sendBtn = streaming ? (
    <button
      type="button"
      onClick={onStop}
      aria-label="停止"
      className="h-9 w-9 shrink-0 grid place-items-center rounded-full bg-rose-500/80 hover:bg-rose-500 text-white transition-colors"
    >
      <Square size={14} />
    </button>
  ) : (
    // Disabled style uses explicit colors (NOT opacity reduction) so the icon
    // stays legible on the dark backdrop; active is bright white-on-dark.
    <button
      type="button"
      onClick={submit}
      disabled={!canSend}
      aria-label="发送"
      // Outline-only: just the ring circle, no fill. Brightens when sendable.
      className={
        "h-9 w-9 shrink-0 grid place-items-center rounded-full border bg-transparent transition-colors " +
        (canSend
          ? "border-zinc-400 text-zinc-100 hover:border-white hover:text-white"
          : "border-zinc-700 text-zinc-600 cursor-not-allowed")
      }
    >
      <Send size={14} />
    </button>
  );

  const textarea = (
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
      // Bar mode: explicit initial height = 36 so the first paint matches the
      // post-useLayoutEffect steady state (no UA-default flash). Panel mode:
      // fill the available space above the button row and scroll internally.
      style={
        panelMode
          ? { height: "100%" }
          : { height: 36, minHeight: 36, maxHeight: 96 }
      }
      className="w-full flex-1 resize-none bg-transparent text-[14px] text-zinc-100 placeholder-zinc-500 px-1 py-1 leading-snug focus:outline-none disabled:opacity-50"
      aria-label="输入消息"
    />
  );

  const popover = (
    <ToolsPopover
      open={toolsOpen}
      anchorEl={toolsBtnRef.current}
      onClose={() => setToolsOpen(false)}
      onPick={(tplText, caret) => {
        // Insert the tool's prompt template, drop the cursor where the user
        // fills in their content, and focus so they can type immediately.
        setText(tplText);
        setHistoryIndex(null);
        setSavedDraft("");
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          try {
            el.setSelectionRange(caret, caret);
          } catch {
            /* setSelectionRange can throw on some states — ignore */
          }
        });
      }}
    />
  );

  // Panel mode: a self-contained rounded input CARD embedded in the chat
  // surface — text on top, an action row (tools left, send right) below.
  if (panelMode) {
    return (
      <div className="h-full p-2">
        {popover}
        <div className="flex h-full flex-col rounded-2xl border border-zinc-700/70 bg-zinc-800/40 px-3 pt-2.5 pb-2">
          <div className="min-h-0 flex-1">{textarea}</div>
          <div className="flex shrink-0 items-center justify-between pt-1.5">
            <div className="flex items-center gap-1">
              {toolsBtn}
              {voiceBtn}
            </div>
            {sendBtn}
          </div>
        </div>
      </div>
    );
  }

  // Bar mode: a single inline strip (the floating 600×50 bar). items-end keeps
  // the send button anchored to the bottom row when the textarea grows.
  return (
    <div className="flex items-end gap-1.5 px-2 py-1.5" style={{ minHeight: 48 }}>
      {toolsBtn}
      {voiceBtn}
      {popover}
      {textarea}
      {sendBtn}
    </div>
  );
}
