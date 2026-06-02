// src/components/agent/CommandIcon.tsx
//
// The ⌘ command-key glyph (from the user-provided command-line.svg), recolored
// to currentColor so it inherits the surrounding text color (matches the app
// theme) and sized via className. Used for the tools button in the chat input.

interface Props {
  className?: string;
}

export function CommandIcon({ className }: Props) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M426.666667 341.333333h170.666666V277.333333a149.333333 149.333333 0 1 1 149.333334 149.333334H682.666667v170.666666h64a149.333333 149.333333 0 1 1-149.333334 149.333334V682.666667h-170.666666v64A149.333333 149.333333 0 1 1 277.333333 597.333333H341.333333v-170.666666H277.333333A149.333333 149.333333 0 1 1 426.666667 277.333333V341.333333zM341.333333 341.333333V277.333333A64 64 0 1 0 277.333333 341.333333H341.333333z m0 341.333334H277.333333A64 64 0 1 0 341.333333 746.666667V682.666667z m341.333334-341.333334h64A64 64 0 1 0 682.666667 277.333333V341.333333z m0 341.333334v64a64 64 0 1 0 64-64H682.666667z m-256-256v170.666666h170.666666v-170.666666h-170.666666z" />
    </svg>
  );
}
