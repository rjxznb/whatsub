import { useState } from "react";

interface Props {
  word: string;
  meaningZh?: string;
  usage?: string;
}

/**
 * Inline span for an expression the user has saved to their vocab book.
 * Visually distinguished from LLM keyNote highlights (HighlightWord) by being
 * a thin yellow underline rather than a solid yellow background — keeps the
 * subtitle reading flow clean while still flagging "you've collected this".
 *
 * Hover/click reveals a small tooltip with the saved meaning and usage,
 * mirroring HighlightWord's UX so the two highlight kinds feel like one
 * family.
 */
export function VocabHighlight({ word, meaningZh, usage }: Props) {
  const [open, setOpen] = useState(false);
  const hasNote = Boolean((meaningZh && meaningZh.trim()) || (usage && usage.trim()));
  return (
    <span className="relative inline-block">
      <span
        data-highlight="true"
        title={hasNote ? undefined : "已收藏"}
        className="border-b border-amber-400/70 cursor-help"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
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
