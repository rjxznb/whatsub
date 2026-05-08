import { useEffect, useState } from "react";
import { Search, Star } from "lucide-react";
import type { Subtitle } from "../llm/types";
import { useVocabulary } from "../store/vocab";
import { normalizeExpression } from "../utils/normalizeExpression";

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
export function SubtitleSelectionBubble({
  listRef,
  subtitles,
  videoId,
  videoTitle,
  disabled,
}: Props) {
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  const { has, toggle } = useVocabulary();

  // Detect a valid selection on mouseup inside the list container.
  useEffect(() => {
    if (disabled) return;
    const list = listRef.current;
    if (!list) return;
    const onMouseUp = () => {
      // Defer until selection settles after the click that ends drag.
      setTimeout(() => setInfo(readSelection(list, subtitles)), 0);
    };
    list.addEventListener("mouseup", onMouseUp);
    return () => list.removeEventListener("mouseup", onMouseUp);
  }, [listRef, subtitles, disabled]);

  // Hide if selection is cleared elsewhere (e.g. clicking the video).
  useEffect(() => {
    if (!info) return;
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setInfo(null);
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, [info]);

  if (!info) return null;

  const saved = has(info.expression);
  const top = Math.max(8, info.rect.top - 44);
  const left = clampLeft(info.rect.left + info.rect.width / 2 - 120);

  const onStar = async () => {
    await toggle({
      expression: info.expression,
      meaningZh: "",
      usage: "",
      videoId,
      videoTitle,
      cueTime: info.cueTime,
      cueText: info.cueText,
    });
    setInfo(null);
    // Clear browser selection so it doesn't immediately re-pop.
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div
      style={{ position: "fixed", top, left, width: 240 }}
      className="z-50 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 shadow-xl backdrop-blur"
    >
      <span
        className="flex-1 truncate text-sm text-zinc-100"
        title={info.expression}
      >
        {info.expression}
      </span>
      <button
        type="button"
        title="LLM 查词（Task 8 后启用）"
        disabled
        className="flex h-7 items-center gap-1 rounded px-2 text-xs text-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
      >
        <Search className="h-3.5 w-3.5" />
        查词
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
    </div>
  );
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
  const max = (typeof window !== "undefined" ? window.innerWidth : 1200) - 248;
  return Math.max(min, Math.min(x, max));
}
