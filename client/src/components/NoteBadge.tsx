import { useState } from "react";

/**
 * Compact "this card has a note" indicator. Renders as a thick blue
 * L-shaped corner bracket — like a door-frame reinforcement — wrapping
 * the top-right corner of a vocab card. Click → onPullOff fires (parent
 * re-opens the note bubble for editing).
 *
 * Replaces an earlier "luggage tag on a swinging string" version with
 * spring physics + drag-to-tear-off. That was deemed too playful for
 * the app's overall restrained tone — same information, with zero
 * decorative noise.
 *
 * Visually: two blue strokes meeting at the corner, one along the top
 * edge of the card and one along the right edge, both ~3px thick. Done
 * via a single `<div>` with `border-top` + `border-right` only —
 * cheaper to render than two separate elements and makes the bracket
 * inherit the card's `border-radius` cleanly.
 *
 * Mount animation: scale from 0 → 1 with origin at the top-right
 * corner, so the bracket visibly "draws into" the corner when the note
 * bubble's fold-out finishes (rather than snapping in). Both close
 * (bubble → corner fold) and post-close indicator-emerge are animated,
 * matching the spec "收起和展开是有动画的".
 */

interface Props {
  /** Open the editor. Named `onPullOff` for back-compat with the previous
   *  drag-to-tear interaction model — call site (`Vocab.tsx`) and the
   *  empty-state demo card both pass `openEditor` here. */
  onPullOff: () => void;
}

// Bracket dimensions — how far each leg extends from the corner.
// Hover bumps both, so the bracket grips slightly more of the corner.
const BRACKET_REST = 22;
const BRACKET_HOVER = 28;
const STROKE_REST = 3;
const STROKE_HOVER = 4;

export function NoteBadge({ onPullOff }: Props) {
  const [hovering, setHovering] = useState(false);
  const size = hovering ? BRACKET_HOVER : BRACKET_REST;
  const stroke = hovering ? STROKE_HOVER : STROKE_REST;

  return (
    <button
      type="button"
      aria-label="查看笔记"
      title="查看 / 编辑笔记"
      onClick={(e) => {
        // Don't bubble up — the card itself doesn't react to clicks
        // (only double-click), but stopPropagation keeps any future
        // single-click handler from firing alongside.
        e.stopPropagation();
        onPullOff();
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      className="absolute animate-note-indicator-enter"
      style={{
        // Negative offsets so the strokes sit ON TOP of the card's own
        // border, replacing it visually at the corner — gives the
        // "reinforced corner bracket" reading the user described
        // ("门框那个角"). The card's borderRadius is `rounded-md` (6px),
        // which we mirror via borderTopRightRadius below so the bracket
        // curves into the corner rather than meeting at a hard right
        // angle.
        top: -1,
        right: -1,
        width: size,
        height: size,
        borderTop: `${stroke}px solid #3b82f6`,
        borderRight: `${stroke}px solid #3b82f6`,
        borderTopRightRadius: 6,
        // Hover: subtle outward glow on the stroke to read as
        // "interactive" without disturbing the card layout.
        boxShadow: hovering
          ? "0 0 10px rgba(59, 130, 246, 0.55)"
          : "none",
        transition:
          "width 200ms ease-out, height 200ms ease-out, " +
          "border-top-width 200ms ease-out, border-right-width 200ms ease-out, " +
          "box-shadow 200ms ease-out",
        cursor: "pointer",
        // Reset native button chrome since we're treating this as a
        // pure visual indicator that happens to be clickable.
        padding: 0,
        background: "transparent",
        outline: "none",
        // The L-shape is hollow — only the strokes are interactive
        // hit-targets visually, but the bounding box still counts as
        // clickable. This is intentional: makes the corner easy to
        // click without having to land precisely on a 3px line.
      }}
    />
  );
}
