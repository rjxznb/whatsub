import type { ReactNode } from "react";
import type { Subtitle } from "../llm/types";
import type { CaptionStyle } from "../types/settings";

interface Props {
  subtitle: Subtitle | null;
  style: CaptionStyle;
}

/**
 * Cinema-style bilingual subtitle box rendered over the video. Visual style
 * (colors / font scale / opacity / highlight on-off) is driven by props so
 * the gear-menu can re-style in real-time without reading the store here.
 */
export function CaptionOverlay({ subtitle, style }: Props) {
  if (!subtitle) return null;

  const bgRgba = hexToRgba(style.bgColor, style.bgOpacity);
  const textStyle = { color: style.fontColor, opacity: style.fontOpacity };
  const enStyle = { ...textStyle, fontSize: `${1.25 * style.fontScale}rem` };
  const zhStyle = { ...textStyle, fontSize: `${1 * style.fontScale}rem` };

  return (
    <div className="absolute inset-x-0 bottom-20 px-6 flex justify-center pointer-events-none z-10">
      <div
        data-caption-box
        className="max-w-[90%] rounded-md px-4 py-2 text-center backdrop-blur-sm shadow-lg"
        style={{ backgroundColor: bgRgba }}
      >
        <div data-caption-en className="leading-snug font-medium" style={enStyle}>
          {renderEnglish(subtitle, style.highlightsEnabled)}
        </div>
        <div data-caption-zh className="leading-snug mt-1" style={zhStyle}>
          {renderTranslation(subtitle, style.highlightsEnabled)}
        </div>
      </div>
    </div>
  );
}

function renderEnglish(s: Subtitle, withHighlights: boolean): ReactNode {
  if (!withHighlights || s.highlightWords.length === 0) return s.text;
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

function renderTranslation(s: Subtitle, withHighlights: boolean): ReactNode {
  if (!withHighlights) return s.translation;
  const zhPhrases = s.highlightWords
    .map((w) => s.highlightTranslations[w])
    .filter((zh): zh is string => Boolean(zh));
  if (zhPhrases.length === 0) return s.translation;
  const sorted = [...zhPhrases].sort(
    (a, b) => s.translation.indexOf(a) - s.translation.indexOf(b)
  );
  return renderWithSpans(s.translation, sorted, (zh, key) => (
    <span key={key} className="bg-amber-300/30 text-amber-100 px-0.5 rounded">
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

/** Convert "#RRGGBB" + 0..1 opacity to a CSS rgba(...) string. */
function hexToRgba(hex: string, opacity: number): string {
  const clean = hex.replace(/^#/, "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, opacity));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
