import { useState } from "react";

interface Props {
  word: string;
  meaningZh?: string;
  usage?: string;
  /** True when the entry is fully committed to vocab.json. False (or
   *  undefined treated as true for back-compat) means this is a
   *  localStorage draft — user typed something but never hit save —
   *  so we render with a DASHED underline to flag "unfinished". */
  saved?: boolean;
}

/**
 * Inline span for an expression the user has saved to their vocab book.
 * Visually distinguished from LLM keyNote highlights (HighlightWord) by being
 * a thin yellow underline rather than a solid yellow background — keeps the
 * subtitle reading flow clean while still flagging "you've collected this".
 *
 * Hover  → tooltip with the saved meaning + usage (read-only preview).
 * Click  → opens SubtitleSelectionBubble pre-filled with this word so the
 *          user can edit. We reuse the bubble's existing "mouseup with a
 *          live selection" trigger rather than adding a new code path:
 *          the click programmatically selects the span's text via the
 *          Selection API, then dispatches a synthetic mouseup event up
 *          to the subtitle list. SubtitleSelectionBubble's listener
 *          picks up the selection and opens the bubble — vocab data
 *          (existing meaningZh / usage) is restored automatically because
 *          the bubble's open effect already calls
 *          `useVocabulary().has(expression)` and pre-fills inputs from
 *          the saved entry.
 */
export function VocabHighlight({ word, meaningZh, usage, saved = true }: Props) {
  const [open, setOpen] = useState(false);
  const hasNote = Boolean((meaningZh && meaningZh.trim()) || (usage && usage.trim()));

  const handleClick = (ev: React.MouseEvent<HTMLSpanElement>) => {
    // Stop the click before it bubbles up to the cue row. The row's
    // onClick navigates (onJump → seek video to the cue's timestamp);
    // we want this click to ONLY open the edit bubble, not jump.
    ev.stopPropagation();
    const target = ev.currentTarget;

    // Programmatically select the highlight's text. The selection is
    // contained inside the English cue container, which means the
    // SubtitleList's selection-clamp logic (mousedown-pinned root)
    // doesn't interfere — the clamp only runs when selectionRoot is
    // set by a prior mousedown, and a synthetic-selection click
    // doesn't trigger that.
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);

    // Dispatch a synthetic mouseup so SubtitleSelectionBubble's
    // listener (attached to the list container) re-reads the
    // selection and opens. The natural click→mouseup that JUST
    // fired had a collapsed selection (a regular click doesn't drag
    // anything), so the bubble would have been closed; now we
    // manually re-fire mouseup with the new live selection in place.
    const upEvent = new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      view: window,
    });
    target.dispatchEvent(upEvent);

    // Hide the hover tooltip — the editing bubble takes over visually.
    setOpen(false);
  };

  return (
    <span className="relative inline-block">
      <span
        data-highlight="true"
        title={
          saved
            ? hasNote
              ? "点击编辑"
              : "已收藏 · 点击编辑"
            : "草稿（未保存）· 点击继续编辑"
        }
        className={
          // Saved entries: solid amber underline (committed feel).
          // Drafts: custom long-dash underline (App.css
          // `.vocab-draft-underline`, 8px-solid + 6px-gap, clearly
          // reads as "in progress, not finalized"). Same hover/click
          // affordance for both — clicking either kind opens the
          // bubble.
          (saved
            ? "border-b border-amber-400/70"
            : "vocab-draft-underline") + " cursor-pointer"
        }
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={handleClick}
      >
        {word}
      </span>
      {open && hasNote && (
        <span className="absolute left-0 top-full mt-1 z-10 bg-zinc-900 text-zinc-100 border border-zinc-700 rounded px-2 py-1.5 text-xs whitespace-normal w-64 shadow-lg flex flex-col gap-1">
          {meaningZh?.trim() && (
            <span>
              <span className="text-amber-300">📖 </span>
              {meaningZh}
            </span>
          )}
          {usage?.trim() && (
            <span className="text-zinc-300">
              <span className="text-amber-300">💬 </span>
              {usage}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
