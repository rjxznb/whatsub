// src/components/AutoScrollIcon.tsx
//
// Double-chevron (») glyph from the user-provided 跳转到底.svg, recolored to
// currentColor (inherits the surrounding text color) and sized via className.
// Used for the 自动跳转 toggle on the player's subtitle tab.

interface Props {
  className?: string;
}

export function AutoScrollIcon({ className }: Props) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} fill="currentColor" aria-hidden="true">
      <path d="M461.376 945.216a47.808 47.808 0 0 1 1.344-67.84l380.032-365.312L462.72 146.688a48 48 0 0 1 66.368-69.376l416 400.064a48.256 48.256 0 0 1 0 69.312l-416 399.872a47.744 47.744 0 0 1-67.776-1.344z m-384 0a47.808 47.808 0 0 1 1.344-67.84l380.032-365.312L78.72 146.688a48 48 0 0 1 66.432-69.376l416 400.064a48.256 48.256 0 0 1 0 69.312l-416 399.872a47.808 47.808 0 0 1-67.84-1.344z" />
    </svg>
  );
}
