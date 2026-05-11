import { Globe } from "lucide-react";

/**
 * Inline brand glyphs for the cookie-source preset buttons. We keep
 * these as simplified SVG marks (not pixel-perfect logo reproductions)
 * to stay clear of trademark reproduction concerns while remaining
 * obviously recognizable as the named site. For sites without a
 * dedicated mark (custom URLs the user pastes) we fall through to a
 * generic Globe icon from lucide.
 *
 * Sizing: a fixed 16×16 box matches the button text height
 * comfortably. Color comes from the path/fill attributes per brand —
 * Tailwind utility classes won't affect inline SVGs unless we use
 * `currentColor`, which we only do for the monochrome marks
 * (X / TikTok) so they pick up the surrounding text color.
 */
export function SiteIcon({
  siteKey,
  size = 16,
}: {
  siteKey: string;
  size?: number;
}) {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    xmlns: "http://www.w3.org/2000/svg",
    "aria-hidden": true,
  } as const;

  switch (siteKey) {
    case "youtube":
      return (
        <svg {...props}>
          <rect x="1.5" y="5" width="21" height="14" rx="3.5" fill="#FF0000" />
          <path d="M10 9.2 15.5 12 10 14.8z" fill="white" />
        </svg>
      );

    case "bilibili":
      return (
        <svg {...props}>
          {/* Cat-ear antennas */}
          <path
            d="M5 3l3 3M19 3l-3 3"
            stroke="#00A1D6"
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />
          <rect x="2.5" y="5.5" width="19" height="14" rx="3" fill="#00A1D6" />
          {/* Eyes */}
          <rect x="6.5" y="11" width="3.5" height="3.5" rx="1" fill="white" />
          <rect x="14" y="11" width="3.5" height="3.5" rx="1" fill="white" />
        </svg>
      );

    case "instagram":
      return (
        <svg {...props}>
          <defs>
            <linearGradient
              id="ig-grad"
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" stopColor="#FEDA77" />
              <stop offset="40%" stopColor="#F58529" />
              <stop offset="70%" stopColor="#DD2A7B" />
              <stop offset="100%" stopColor="#8134AF" />
            </linearGradient>
          </defs>
          <rect
            x="2"
            y="2"
            width="20"
            height="20"
            rx="5.5"
            fill="url(#ig-grad)"
          />
          <circle
            cx="12"
            cy="12"
            r="4.5"
            fill="none"
            stroke="white"
            strokeWidth="2"
          />
          <circle cx="17.5" cy="6.5" r="1.2" fill="white" />
        </svg>
      );

    case "x":
      // Bold X letterform — currentColor so it inherits text color
      // (white on the dark theme; legible on light if the user ever
      // tweaks the surrounding background).
      return (
        <svg {...props}>
          <path
            d="M18.5 3h2.7l-6 6.9 7 9.1h-5.5l-4.4-5.7-5 5.7H4.6L11 11.5 4.3 3h5.6l4 5.3z"
            fill="currentColor"
          />
        </svg>
      );

    case "tiktok": {
      // TikTok's signature trick is a magenta+cyan offset of the
      // music-note glyph. We render two slightly-offset notes plus a
      // top one in white for the layered chromatic-aberration look.
      return (
        <svg {...props}>
          <g transform="translate(1.2 0.6)">
            <path
              d="M13 3.5v9a3.5 3.5 0 11-3.5-3.5"
              stroke="#25F4EE"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
            />
          </g>
          <g transform="translate(-1.2 -0.6)">
            <path
              d="M13 3.5v9a3.5 3.5 0 11-3.5-3.5"
              stroke="#FE2C55"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
            />
          </g>
          <path
            d="M13 3.5v9a3.5 3.5 0 11-3.5-3.5M13 3.5c0 2.2 1.8 4 4 4"
            stroke="currentColor"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      );
    }

    default:
      // Custom URL — generic globe glyph in the current text color.
      return <Globe size={size} aria-hidden />;
  }
}
