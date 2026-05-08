import { useEffect, useRef, useState } from "react";
import { Sparkles, Star, Loader2, AlertCircle, X } from "lucide-react";
import type { Subtitle } from "../llm/types";
import { useVocabulary } from "../store/vocab";
import { makeVocabId } from "../types/vocab";
import { useSettings } from "../store/settings";
import type { Settings } from "../types/settings";
import { normalizeExpression } from "../utils/normalizeExpression";
import { lookupExpression } from "../llm/lookupExpression";
import { getProvider } from "../llm/providers";
import { friendlyError } from "../utils/friendlyError";
import { loadDraft, saveDraft, clearDraft, type VocabDraft } from "../store/vocabDraft";

const BUBBLE_WIDTH = 400;

interface SelectionInfo {
  expression: string;
  cueIdx: number;
  cueText: string;
  cueTime: number;
  rect: DOMRect;
}

interface Props {
  /** The list container the bubble watches for selection events. */
  listRef: React.RefObject<HTMLDivElement | null>;
  subtitles: Subtitle[];
  videoId: string;
  videoTitle: string;
  /** Disable the bubble entirely (e.g. in subtitle edit mode). */
  disabled: boolean;
}

/**
 * Floating bubble that appears above any text the user drag-selects inside
 * the subtitle list. Lets them ⭐ directly save with empty meaning, or click
 * 🔍 to fetch a Chinese gloss + usage from the LLM (added in Task 8).
 */
type LookupState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string };

export function SubtitleSelectionBubble({
  listRef,
  subtitles,
  videoId,
  videoTitle,
  disabled,
}: Props) {
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  const [meaningZh, setMeaningZh] = useState("");
  const [usage, setUsage] = useState("");
  const [lookup, setLookup] = useState<LookupState>({ kind: "idle" });
  const [suggestion, setSuggestion] = useState<{
    meaningZh: string;
    usage: string;
  } | null>(null);
  const [hoverPreview, setHoverPreview] = useState<
    null | "replace" | "append"
  >(null);
  const [mounted, setMounted] = useState(false);
  const lookupAbortRef = useRef<AbortController | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const { entries, has, toggle, add } = useVocabulary();
  const { settings } = useSettings();

  // On selection change: restore from vocab (top priority), then draft, else collapsed default.
  useEffect(() => {
    if (!info) return;
    setLookup({ kind: "idle" });
    setSuggestion(null);
    setHoverPreview(null);
    lookupAbortRef.current?.abort();

    const id = makeVocabId(info.expression);
    const existing = entries.find((e) => e.id === id);
    if (existing) {
      // Already-saved: pre-fill from vocab; debounce-upsert active.
      setMeaningZh(existing.meaningZh);
      setUsage(existing.usage);
      return;
    }
    const draft = loadDraft(info.expression);
    if (draft) {
      setMeaningZh(draft.meaningZh);
      setUsage(draft.usage);
      return;
    }
    // Fresh, no draft, no vocab — empty inputs.
    setMeaningZh("");
    setUsage("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.expression]);

  // Detect selection. Mouseup events that originate INSIDE the bubble
  // (e.g., clicking a textarea or button) bubble up to listRef and would
  // otherwise re-read the document selection — which by then has been
  // cleared by the textarea taking focus, returning null and closing
  // the bubble. Skip those.
  useEffect(() => {
    if (disabled) return;
    const list = listRef.current;
    if (!list) return;
    const onMouseUp = (e: MouseEvent) => {
      if (bubbleRef.current?.contains(e.target as Node)) return;
      setTimeout(() => setInfo(readSelection(list, subtitles)), 0);
    };
    list.addEventListener("mouseup", onMouseUp);
    return () => list.removeEventListener("mouseup", onMouseUp);
  }, [listRef, subtitles, disabled]);

  const saved = info ? has(info.expression) : false;

  // Debounce-upsert when the user edits inputs while the entry is in vocab.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!info) return;
    if (!saved) return;            // only auto-update entries already in vocab
    if (suggestion) return;        // user is mid-suggestion-decision; don't fire yet

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      add({
        id: makeVocabId(info.expression),
        expression: info.expression,
        meaningZh,
        usage,
        videoId,
        videoTitle,
        cueTime: info.cueTime,
        cueText: info.cueText,
        addedAt:
          entries.find((e) => e.id === makeVocabId(info.expression))
            ?.addedAt ?? new Date().toISOString(),
      }).catch((e) => console.error("debounced vocab upsert failed", e));
    }, 500);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meaningZh, usage, saved, info?.expression, suggestion]);

  // Hide on collapsed selection.
  // Bubble close paths: outside-click (mousedown) + ESC + explicit X button.
  // We deliberately do NOT close on selectionchange-collapsed because clicking
  // ANY focusable element inside the bubble (textareas, buttons, the AI 重新查
  // ...) collapses the document-level selection on the cue text, racing focus
  // changes with selectionchange events in browser-specific ways. Every guard
  // we tried (textarea-only / any-focus-in-bubble / deferred activeElement)
  // had false-positive closes for legitimate bubble interactions. Outside-click
  // already handles "user clicked elsewhere"; we don't need a second mechanism.

  // Block wheel + touchmove on the list while bubble is visible — prevents
  // scrolling the selection out from under the bubble.
  useEffect(() => {
    if (!info) return;
    const list = listRef.current;
    if (!list) return;
    const block = (e: Event) => e.preventDefault();
    list.addEventListener("wheel", block, { passive: false });
    list.addEventListener("touchmove", block, { passive: false });
    return () => {
      list.removeEventListener("wheel", block);
      list.removeEventListener("touchmove", block);
    };
  }, [info, listRef]);

  // Outside-click close.
  useEffect(() => {
    if (!info) return;
    const onDown = (e: MouseEvent) => {
      if (!bubbleRef.current) return;
      if (bubbleRef.current.contains(e.target as Node)) return;
      // Click on selection itself — let it stand; selectionchange will close
      // if it collapses.
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        const x = e.clientX, y = e.clientY;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return;
      }
      closeBubble();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, saved, meaningZh, usage]);

  // ESC closes.
  useEffect(() => {
    if (!info) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeBubble();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, saved, meaningZh, usage]);

  // Fade-in animation: mounted flips on next animation frame.
  useEffect(() => {
    if (!info) {
      setMounted(false);
      return;
    }
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, [info?.expression]);

  if (!info) return null;

  const onLookup = async () => {
    lookupAbortRef.current?.abort();
    const ctrl = new AbortController();
    lookupAbortRef.current = ctrl;
    setLookup({ kind: "loading" });
    try {
      const provider = getProvider(settings);
      const result = await lookupExpression(
        info.expression,
        info.cueText,
        provider,
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      const userHasContent = meaningZh.trim() || usage.trim();
      if (userHasContent) {
        // Don't overwrite — show suggestion card instead.
        setSuggestion(result);
      } else {
        setMeaningZh(result.meaningZh);
        setUsage(result.usage);
      }
      setLookup({ kind: "idle" });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setLookup({ kind: "error", message: friendlyError(String(e), "analyzing").title });
    }
  };

  const onStar = async () => {
    lookupAbortRef.current?.abort();
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (saved) {
      // Cancel any pending upsert FIRST so it doesn't race with the remove.
      await toggle({
        expression: info.expression,
        meaningZh,
        usage,
        videoId,
        videoTitle,
        cueTime: info.cueTime,
        cueText: info.cueText,
      });
      // Stay open in expanded state (user might re-edit and re-save).
      return;
    }
    await add({
      id: makeVocabId(info.expression),
      expression: info.expression,
      meaningZh,
      usage,
      videoId,
      videoTitle,
      cueTime: info.cueTime,
      cueText: info.cueText,
      addedAt: new Date().toISOString(),
    });
    clearDraft(info.expression);
    // Stay open after save — ⭐ flips to filled (saved=true derives from
    // useVocabulary().has on next render), inputs remain editable, and any
    // further edits will debounce-upsert. User dismisses via the explicit
    // X close button, ESC, or by clicking outside.
  };

  const top = Math.max(
    8,
    info.rect.top - (suggestion ? 330 : 200),
  );
  const left = clampLeft(info.rect.left + info.rect.width / 2 - BUBBLE_WIDTH / 2);

  const llmReady = isProviderReady(settings);

  const closeBubble = () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      // For saved entries: flush the latest typed content synchronously so
      // a quick close (within the 500ms debounce window) doesn't lose the edit.
      if (info && saved) {
        add({
          id: makeVocabId(info.expression),
          expression: info.expression,
          meaningZh,
          usage,
          videoId,
          videoTitle,
          cueTime: info.cueTime,
          cueText: info.cueText,
          addedAt:
            entries.find((e) => e.id === makeVocabId(info.expression))
              ?.addedAt ?? new Date().toISOString(),
        }).catch((e) => console.error("flush-on-close vocab upsert failed", e));
      }
    }
    if (info && !saved && (meaningZh.trim() || usage.trim())) {
      const draft: VocabDraft = {
        expression: info.expression,
        meaningZh,
        usage,
        cueText: info.cueText,
        cueTime: info.cueTime,
        videoId,
        videoTitle,
        updatedAt: new Date().toISOString(),
      };
      saveDraft(draft);
    } else if (info && !saved) {
      // User cleared inputs (or never typed) on an unsaved word — wipe any
      // stale draft so it doesn't ghost-restore on next selection.
      clearDraft(info.expression);
    }
    setInfo(null);
  };

  return (
    <div
      ref={bubbleRef}
      style={{ position: "fixed", top, left, width: BUBBLE_WIDTH }}
      className={
        "z-50 flex flex-col rounded-lg border border-zinc-700 bg-zinc-900/95 shadow-xl backdrop-blur " +
        "transition-all duration-150 ease-out " +
        (mounted ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-1 scale-95")
      }
    >
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
        <span
          className="flex-1 truncate text-sm text-zinc-100"
          title={info.expression}
        >
          {info.expression}
        </span>
        <button
          type="button"
          onClick={onLookup}
          disabled={!llmReady || lookup.kind === "loading"}
          title={llmReady ? "AI 查词" : "请先在设置里配置 AI 翻译服务"}
          className="flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-white bg-gradient-to-r from-indigo-500 to-purple-500 shadow-sm shadow-purple-500/30 hover:from-indigo-400 hover:to-purple-400 hover:shadow-purple-500/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:from-indigo-500 disabled:hover:to-purple-500"
        >
          {lookup.kind === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {(meaningZh || usage).trim() ? "AI 重新查" : "AI 查词"}
        </button>
        <button
          type="button"
          onClick={onStar}
          title={saved ? "已收藏 · 点击移除" : "收藏到我的词汇本"}
          className={
            "flex h-7 w-7 items-center justify-center rounded-full transition-colors " +
            (saved
              ? "text-amber-300 hover:bg-amber-900/30"
              : "text-zinc-400 hover:bg-zinc-800 hover:text-amber-300")
          }
        >
          <Star className="h-4 w-4" fill={saved ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          onClick={closeBubble}
          title="关闭"
          className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Inputs (always visible) */}
      <div className="flex flex-col gap-2 px-3 py-2">
        {lookup.kind === "error" && (
          <div className="flex items-center gap-2 rounded bg-red-900/30 px-2 py-1 text-xs text-red-300">
            <AlertCircle className="h-3.5 w-3.5" />
            <span className="flex-1 truncate">查询失败：{lookup.message}</span>
            <button
              type="button"
              onClick={onLookup}
              className="rounded px-2 py-0.5 hover:bg-red-900/40"
            >
              重试
            </button>
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">📖 中文释义</span>
          <textarea
            value={meaningZh}
            onChange={(e) => setMeaningZh(e.target.value)}
            rows={2}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-blue-400 resize-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">💬 用法</span>
          <textarea
            value={usage}
            onChange={(e) => setUsage(e.target.value)}
            rows={2}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-blue-400 resize-none"
          />
        </label>
        {suggestion && (
          <div className="flex flex-col gap-2 rounded border border-amber-500/40 bg-amber-950/20 p-2">
            <div className="text-xs font-medium text-amber-300">
              AI 建议
              {hoverPreview === "replace" && " · 替换后效果预览"}
              {hoverPreview === "append" && " · 追加后效果预览"}
            </div>
            <div className="text-xs text-amber-100/90 max-h-40 overflow-y-auto whitespace-pre-wrap leading-relaxed">
              <div className="mb-1">
                <span className="text-amber-300">📖 </span>
                {hoverPreview === "replace"
                  ? suggestion.meaningZh || "（空）"
                  : hoverPreview === "append" && suggestion.meaningZh
                  ? joinWithBreak(meaningZh, suggestion.meaningZh)
                  : suggestion.meaningZh || "（空）"}
              </div>
              <div>
                <span className="text-amber-300">💬 </span>
                {hoverPreview === "replace"
                  ? suggestion.usage || "（空）"
                  : hoverPreview === "append" && suggestion.usage
                  ? joinWithBreak(usage, suggestion.usage)
                  : suggestion.usage || "（空）"}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onMouseEnter={() => setHoverPreview("replace")}
                onMouseLeave={() => setHoverPreview(null)}
                onClick={() => {
                  setMeaningZh(suggestion.meaningZh);
                  setUsage(suggestion.usage);
                  setSuggestion(null);
                  setHoverPreview(null);
                }}
                className="flex-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/20"
              >
                替换
              </button>
              <button
                type="button"
                onMouseEnter={() => setHoverPreview("append")}
                onMouseLeave={() => setHoverPreview(null)}
                onClick={() => {
                  setMeaningZh(joinWithBreak(meaningZh, suggestion.meaningZh));
                  setUsage(joinWithBreak(usage, suggestion.usage));
                  setSuggestion(null);
                  setHoverPreview(null);
                }}
                className="flex-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/20"
              >
                追加
              </button>
              <button
                type="button"
                onClick={() => {
                  setSuggestion(null);
                  setHoverPreview(null);
                }}
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                忽略
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function isProviderReady(settings: Settings): boolean {
  switch (settings.llmProvider) {
    case "openai-compatible":
      return !!settings.openaiCompatible.apiKey && !!settings.openaiCompatible.baseUrl;
    case "claude":
      return !!settings.claude.apiKey;
    case "gemini":
      return !!settings.gemini.apiKey;
    default:
      return false;
  }
}

/**
 * Read the current selection. Returns null if:
 *  - no selection / collapsed
 *  - normalized text is empty
 *  - anchor and focus aren't inside the same cue
 */
function readSelection(
  list: HTMLDivElement,
  subtitles: Subtitle[],
): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  // Both ends must be within the list.
  if (
    !list.contains(range.startContainer) ||
    !list.contains(range.endContainer)
  )
    return null;

  const startCue = closestCue(range.startContainer);
  const endCue = closestCue(range.endContainer);
  if (!startCue || !endCue || startCue !== endCue) return null;

  const idxStr = startCue.getAttribute("data-idx");
  if (!idxStr) return null;
  const cueIdx = Number(idxStr);
  const sub = subtitles[cueIdx];
  if (!sub) return null;

  const expression = normalizeExpression(sel.toString());
  if (!expression) return null;

  const rect = range.getBoundingClientRect();
  return {
    expression,
    cueIdx,
    cueText: sub.text,
    cueTime: sub.time,
    rect,
  };
}

function closestCue(node: Node): HTMLElement | null {
  let n: Node | null = node;
  while (n && n.nodeType !== Node.ELEMENT_NODE) n = n.parentNode;
  if (!n) return null;
  const el = n as HTMLElement;
  return el.closest<HTMLElement>("[data-idx]");
}

function clampLeft(x: number): number {
  const min = 8;
  const max = (typeof window !== "undefined" ? window.innerWidth : 1200) - BUBBLE_WIDTH - 8;
  return Math.max(min, Math.min(x, max));
}

function joinWithBreak(a: string, b: string): string {
  if (!a.trim()) return b;
  if (!b.trim()) return a;
  return `${a}\n\n${b}`;
}
