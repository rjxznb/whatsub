import { useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";
import { useSpeech } from "../hooks/useSpeech";
import { StarButton } from "./StarButton";

const CLOSE_DELAY_MS = 150;

interface Props {
  word: string;
  meaningZh?: string;
  note?: string;
  videoId: string;
  videoTitle: string;
  cueTime?: number;
  cueText?: string;
}

export function HighlightWord({
  word,
  meaningZh = "",
  note = "",
  videoId,
  videoTitle,
  cueTime,
  cueText,
}: Props) {
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { speak } = useSpeech();

  const cancelClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const keepOpen = () => {
    cancelClose();
    setOpen(true);
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, CLOSE_DELAY_MS);
  };

  useEffect(() => cancelClose, []);

  return (
    <span
      className="relative inline-block"
      onMouseEnter={keepOpen}
      onMouseLeave={scheduleClose}
    >
      <span
        data-highlight="true"
        className="bg-amber-300 text-black px-0.5 rounded cursor-help font-medium"
        onMouseEnter={keepOpen}
        onMouseLeave={scheduleClose}
        onClick={(event) => {
          event.stopPropagation();
          cancelClose();
          setOpen((value) => !value);
        }}
      >
        {word}
      </span>
      {open && (meaningZh.trim() || note.trim()) && (
        <span
          data-testid="highlight-phrase-card"
          className="absolute left-0 top-full mt-1 z-10 flex w-72 flex-col gap-1.5 whitespace-normal rounded border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-100 shadow-lg"
          onMouseEnter={keepOpen}
          onMouseLeave={scheduleClose}
          onClick={(event) => event.stopPropagation()}
        >
          <span className="flex items-start gap-2">
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-amber-300">{word}</span>
              {meaningZh.trim() && (
                <span className="mt-0.5 block text-zinc-100">{meaningZh}</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                aria-label="朗读短语"
                title="朗读短语"
                className="flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-blue-300"
                onClick={(event) => {
                  event.stopPropagation();
                  speak(word);
                }}
              >
                <Volume2 className="h-3.5 w-3.5" />
              </button>
              <StarButton
                expression={word}
                meaningZh={meaningZh}
                usage={note}
                videoId={videoId}
                videoTitle={videoTitle}
                cueTime={cueTime}
                cueText={cueText}
              />
            </span>
          </span>
          {note.trim() && <span className="leading-relaxed text-zinc-300">{note}</span>}
        </span>
      )}
    </span>
  );
}
