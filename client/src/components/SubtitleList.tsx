import { useEffect, useRef, type ReactNode } from "react";
import type { Subtitle } from "../llm/types";
import { HighlightWord } from "./HighlightWord";
import { formatTime } from "../utils/time";

interface Props {
  subtitles: Subtitle[];
  currentIdx: number;
  onJump: (timeSec: number) => void;
}

export function SubtitleList({ subtitles, currentIdx, onJump }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (currentIdx < 0) return;
    const el = listRef.current?.querySelector(`[data-idx="${currentIdx}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentIdx]);

  return (
    <div ref={listRef} className="overflow-y-auto h-full">
      {subtitles.map((s, i) => (
        <div
          key={i}
          data-idx={i}
          onClick={() => onJump(s.time)}
          className={
            "px-3 py-2 border-b border-zinc-800 cursor-pointer hover:bg-zinc-800/50 " +
            (i === currentIdx ? "bg-blue-500/10 border-l-2 border-l-blue-400 pl-[10px]" : "")
          }
        >
          <div className="text-zinc-500 text-[10px]">
            {formatTime(s.time)} → {formatTime(s.endTime)}
          </div>
          <div className="text-sm leading-relaxed text-zinc-100">
            {renderTextWithHighlights(s)}
          </div>
          <div className="text-zinc-400 text-xs mt-0.5">{s.translation}</div>
        </div>
      ))}
    </div>
  );
}

function renderTextWithHighlights(s: Subtitle): ReactNode {
  if (s.highlightWords.length === 0) return s.text;
  const segments: ReactNode[] = [];
  let cursor = 0;
  const words = [...s.highlightWords].sort(
    (a, b) => s.text.indexOf(a) - s.text.indexOf(b)
  );
  for (const w of words) {
    const idx = s.text.indexOf(w, cursor);
    if (idx === -1) continue;
    if (idx > cursor) segments.push(s.text.slice(cursor, idx));
    segments.push(<HighlightWord key={`${w}-${idx}`} word={w} note={s.keyNotes[w]} />);
    cursor = idx + w.length;
  }
  if (cursor < s.text.length) segments.push(s.text.slice(cursor));
  return segments;
}
