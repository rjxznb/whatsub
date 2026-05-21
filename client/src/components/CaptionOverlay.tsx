import { useState, type ReactNode } from "react";
import type { Subtitle } from "../llm/types";
import type { CaptionStyle } from "../types/settings";

interface Props {
  subtitle: Subtitle | null;
  style: CaptionStyle;
  /** Called on mouseup after a drag with the new pixel offsets relative to
   *  the caption box's default position. Optional — when omitted, the box
   *  cannot be moved. */
  onPositionChange?: (offsetX: number, offsetY: number) => void;
}

/**
 * Cinema-style bilingual subtitle box rendered over the video. Visual style
 * (colors / font scale / opacity / highlight on-off) is driven by props so
 * the gear-menu can re-style in real-time without reading the store here.
 * The box itself is draggable: mousedown + drag updates a transient local
 * offset; on release the final offset is forwarded via onPositionChange
 * for the caller to persist.
 */
export function CaptionOverlay({ subtitle, style, onPositionChange }: Props) {
  // Transient pixel delta during an active drag. While set, this overrides
  // the offsetX/Y from props. On mouseup we forward to onPositionChange and
  // clear this — the parent then re-renders with the new style offsets.
  const [dragDelta, setDragDelta] = useState<null | { x: number; y: number }>(null);

  if (!subtitle) return null;

  const bgRgba = hexToRgba(style.bgColor, style.bgOpacity);
  const textStyle = { color: style.fontColor, opacity: style.fontOpacity };
  const enStyle = { ...textStyle, fontSize: `${1.25 * style.fontScale}rem` };
  const zhStyle = { ...textStyle, fontSize: `${1 * style.fontScale}rem` };

  const offsetX = dragDelta?.x ?? style.offsetX;
  const offsetY = dragDelta?.y ?? style.offsetY;

  function onMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (!onPositionChange) return;
    e.preventDefault();
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startOffsetX = style.offsetX;
    const startOffsetY = style.offsetY;
    let currentX = startOffsetX;
    let currentY = startOffsetY;

    const onMove = (ev: MouseEvent) => {
      currentX = startOffsetX + (ev.clientX - startMouseX);
      currentY = startOffsetY + (ev.clientY - startMouseY);
      setDragDelta({ x: currentX, y: currentY });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      onPositionChange(currentX, currentY);
      setDragDelta(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div className="absolute inset-x-0 bottom-20 px-6 flex justify-center pointer-events-none z-20">
      <div
        data-caption-box
        className={
          "max-w-[90%] rounded-md px-4 py-2 text-center shadow-lg " +
          // backdrop-blur is independent of the bg color alpha — at bgOpacity 0
          // the blur was still active, making the video behind look "through a
          // lens". Turn the blur off when the user has explicitly chosen a
          // fully transparent background so the video stays crisp.
          (style.bgOpacity > 0 ? "backdrop-blur-sm " : "") +
          (onPositionChange
            ? "pointer-events-auto cursor-move select-none"
            : "")
        }
        style={{
          backgroundColor: bgRgba,
          transform: `translate(${offsetX}px, ${offsetY}px)`,
        }}
        onMouseDown={onMouseDown}
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
