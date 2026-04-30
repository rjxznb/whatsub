import type { ReactNode } from "react";
import type { Subtitle } from "../llm/types";

interface Props {
  subtitle: Subtitle | null;
}

/**
 * Cinema-style bilingual subtitle box rendered over the video.
 * Highlights are colored but inert — no hover tooltip — to stay out of the
 * way during viewing. The right-side SubtitleList remains the place for
 * inspection.
 */
export function CaptionOverlay({ subtitle }: Props) {
  if (!subtitle) return null;
  return (
    <div className="absolute inset-x-0 bottom-20 px-6 flex justify-center pointer-events-none z-10">
      <div className="max-w-[90%] rounded-md bg-black/70 px-4 py-2 text-center backdrop-blur-sm shadow-lg">
        <div className="text-white text-xl leading-snug font-medium">
          {renderEnglish(subtitle)}
        </div>
        <div className="text-zinc-200 text-base leading-snug mt-1">
          {renderTranslation(subtitle)}
        </div>
      </div>
    </div>
  );
}

function renderEnglish(s: Subtitle): ReactNode {
  if (s.highlightWords.length === 0) return s.text;
  const words = [...s.highlightWords].sort(
    (a, b) => s.text.indexOf(a) - s.text.indexOf(b)
  );
  return renderWithSpans(s.text, words, (w, key) => (
    <span
      key={key}
      className="bg-amber-300 text-black px-0.5 rounded font-semibold"
    >
      {w}
    </span>
  ));
}

function renderTranslation(s: Subtitle): ReactNode {
  const zhPhrases = s.highlightWords
    .map((w) => s.highlightTranslations[w])
    .filter((zh): zh is string => Boolean(zh));
  if (zhPhrases.length === 0) return s.translation;
  const sorted = [...zhPhrases].sort(
    (a, b) => s.translation.indexOf(a) - s.translation.indexOf(b)
  );
  return renderWithSpans(s.translation, sorted, (zh, key) => (
    <span
      key={key}
      className="bg-amber-300/30 text-amber-100 px-0.5 rounded"
    >
      {zh}
    </span>
  ));
}

function renderWithSpans(
  text: string,
  phrases: string[],
  wrap: (phrase: string, key: string) => ReactNode
): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const p of phrases) {
    if (!p) continue;
    const idx = text.indexOf(p, cursor);
    if (idx === -1) continue;
    if (idx > cursor) out.push(text.slice(cursor, idx));
    out.push(wrap(p, `${p}-${idx}`));
    cursor = idx + p.length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
