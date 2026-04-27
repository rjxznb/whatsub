import { useState } from "react";

interface Props {
  word: string;
  note?: string;
}

export function HighlightWord({ word, note }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <span
        className="bg-amber-300 text-black px-0.5 rounded cursor-help font-medium"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
      >
        {word}
      </span>
      {open && note && (
        <span className="absolute left-0 top-full mt-1 z-10 bg-zinc-900 text-zinc-100 border border-zinc-700 rounded px-2 py-1 text-xs whitespace-normal w-64 shadow-lg">
          {note}
        </span>
      )}
    </span>
  );
}
