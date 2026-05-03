import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Onboarding shell + welcome intro animation, fused into a single component
 * so the handoff from animation → cards is a continuous timeline rather than
 * a "WelcomeIntro unmounts / FirstRunGate mounts" snap (which earlier broke
 * because the two stages had different backgrounds and the headline jumped
 * a few px even with shared positioning constants).
 *
 * One RAF-driven frame counter feeds both the headline animation and the
 * cards' fade-in. The cards (passed as children) sit silently with
 * opacity:0 from frame 0; once the headline lands, they slide up + fade in.
 *
 * Timeline (frames @ 30fps):
 *   0–30    pre-typing (cursor only, centered on screen)
 *   30–110  type "hey, " then "whatSub" (Sub turns blue)
 *   110–150 hold the brand
 *   150–200 fly: "hey," collapses, whatSub flies to title slot + shrinks,
 *                "Welcome " types in letter-by-letter ahead of it
 *   190–230 cards fade-in + slide up (overlaps end of fly for continuity)
 *   230+    idle — fully static onboarding screen, ready for input
 *
 * Removing introPlayedThisSession etc. from the parent: this component
 * itself is mounted whenever onboarding is incomplete, and the animation
 * runs on every mount. Going from typing → cards never unmounts anything,
 * so React state in the cards (typed-but-untested API key, mid-download)
 * is preserved naturally across the visual transition.
 */

// ---- Brand tokens ----
const BG = "#000000";
const INK = "#FFFFFF";
const ACCENT = "#3B9BFF";
// Same vignette gets used by every phase including the static idle frame —
// no background swap means no visual seam at the moment the cards appear.
const BG_GRADIENT =
  "radial-gradient(ellipse at center, rgba(40,40,50,0.35) 0%, rgba(0,0,0,1) 70%)";

// ---- Timeline (frames @ 30fps) ----
const PHASE_HEY_START = 30;
const PHASE_HEY_END = 52;
const PHASE_WHAT_START = 82;
const PHASE_WHAT_END = 96;
const PHASE_SUB_START = 96;
const PHASE_SUB_END = 110;
const PHASE_HOLD_END = 150;
const PHASE_FLY_END = 200;
// Cards start 10 frames before fly fully ends so the rise overlaps the
// headline's final settle — feels like one continuous motion rather than
// "headline done … then cards appear".
const PHASE_CARDS_START = PHASE_FLY_END - 10;
const PHASE_CARDS_END = 230;
const PHASE_IDLE = 235;

// Final headline position — referenced by the welcome span layout. Kept as
// exports purely so a future caller could echo them; FirstRunGate no longer
// renders its own static title, so consistency between two render paths is
// no longer a maintenance burden.
export const TITLE_CENTER_TOP_PX = 90;
// Title font-size at the smallest supported viewport. Larger viewports
// scale up to MAX_TITLE_FONT_PX, then the cards take over the growth
// budget. See computeTitlePx / computeCardsMaxW below.
export const TITLE_FONT_PX = 60;
const MAX_TITLE_FONT_PX = 110;
// Width threshold below which the title sits at TITLE_FONT_PX. Above it,
// the title grows linearly until MAX_TITLE_FONT_PX, then stops; cards
// only start growing once the title's hit its cap so the user perceives
// a clear "title first, then cards" sequence as the window enlarges.
const TITLE_GROWTH_VW_PER_PX = 18; // 18 viewport-px → 1 title-px
const CARDS_GROWTH_VW_PER_PX = 1.6;
const MIN_CARDS_MAX_W = 960;
const MAX_CARDS_MAX_W = 1600;

function computeTitlePx(vw: number): number {
  // Below ~1080px viewport: minimum size. Above: grows 1px per
  // TITLE_GROWTH_VW_PER_PX px of viewport width, capped at the max.
  const baseline = 1080;
  if (vw <= baseline) return TITLE_FONT_PX;
  const grown = TITLE_FONT_PX + (vw - baseline) / TITLE_GROWTH_VW_PER_PX;
  return Math.min(MAX_TITLE_FONT_PX, grown);
}

function computeCardsMaxW(vw: number): number {
  // Cards stay narrow until the title has finished growing. We compute
  // the viewport width at which computeTitlePx hits its cap, then start
  // growing the card slot from there.
  const titleCapVw = 1080 + (MAX_TITLE_FONT_PX - TITLE_FONT_PX) * TITLE_GROWTH_VW_PER_PX;
  if (vw <= titleCapVw) return MIN_CARDS_MAX_W;
  const grown = MIN_CARDS_MAX_W + (vw - titleCapVw) / CARDS_GROWTH_VW_PER_PX;
  return Math.min(MAX_CARDS_MAX_W, grown);
}

const HEY_TEXT = "hey, ";
const WHAT_TEXT = "what";
const SUB_TEXT = "Sub";
const WELCOME_TEXT = "Welcome to ";

// Apple's easeOutExpo (same curve the Remotion reference uses).
function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}
function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function sliceTo(text: string, n: number): string {
  return text.slice(0, Math.max(0, Math.min(text.length, n)));
}

interface Props {
  /** The onboarding cards (and any framing markup) to fade in beneath the
   *  headline once it's settled. Rendered from frame 0 with opacity:0 so
   *  layout is stable from the start. */
  children: ReactNode;
}

export function WelcomeIntro({ children }: Props) {
  const [frame, setFrame] = useState(0);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // Live viewport tracking — re-rendered on resize so the headline stays
  // centered during the intro and the static title + cards scale according
  // to computeTitlePx / computeCardsMaxW. Initial value reads window so
  // first paint has the right metrics (no resize-flicker on mount).
  const [vp, setVp] = useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1280,
    h: typeof window !== "undefined" ? window.innerHeight : 800,
  }));
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onResize() {
      setVp({ w: window.innerWidth, h: window.innerHeight });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const centerY = vp.h / 2;
  // Pre-fly headline size scales with viewport height (so the giant
  // typing text fills the screen proportionally). The fly-end target uses
  // the responsive computeTitlePx so what the user sees while typing fades
  // smoothly into the size they'll see in the static idle state.
  const headlinePx = Math.round(vp.h * 0.16);
  const cursorPx = Math.round(headlinePx * 0.85);
  const finalTitlePx = computeTitlePx(vp.w);
  const cardsMaxW = computeCardsMaxW(vp.w);

  useEffect(() => {
    // Reset on (re-)mount so React StrictMode's double-invoke doesn't jump
    // ahead based on a stale start timestamp from the previous mount.
    startRef.current = null;
    function loop(t: number) {
      if (startRef.current === null) startRef.current = t;
      const elapsed = t - startRef.current;
      const f = Math.floor(elapsed / (1000 / 30));
      setFrame(f);
      // Stop once we hit the static idle frame — the cursor is already
      // invisible by then so there's nothing left to animate.
      if (f < PHASE_IDLE) {
        rafRef.current = requestAnimationFrame(loop);
      }
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // ---- Typing progress ----
  const heyChars =
    clamp01((frame - PHASE_HEY_START) / (PHASE_HEY_END - PHASE_HEY_START)) * HEY_TEXT.length;
  const heyTyped = sliceTo(HEY_TEXT, Math.floor(heyChars));

  const whatChars =
    clamp01((frame - PHASE_WHAT_START) / (PHASE_WHAT_END - PHASE_WHAT_START)) * WHAT_TEXT.length;
  const whatTyped = sliceTo(WHAT_TEXT, Math.floor(whatChars));

  const subChars =
    clamp01((frame - PHASE_SUB_START) / (PHASE_SUB_END - PHASE_SUB_START)) * SUB_TEXT.length;
  const subTyped = sliceTo(SUB_TEXT, Math.floor(subChars));

  const lineOpacity = easeOutExpo(clamp01((frame - (PHASE_HEY_START - 4)) / 10));
  const hasStartedTyping = frame >= PHASE_HEY_START;
  const cursorColor = frame >= PHASE_SUB_START ? ACCENT : INK;
  const breatheScale =
    frame < PHASE_HOLD_END ? 1 + Math.sin((frame / 30) * 1.2) * 0.004 : 1;

  // ---- Fly transition ----
  // Land at finalTitlePx (responsive, derived from viewport width) so the
  // post-fly idle state matches what the user resizes to without snapping
  // — if the user resizes mid-fly the target moves smoothly with them.
  const flyT = easeOutExpo(clamp01((frame - PHASE_HOLD_END) / (PHASE_FLY_END - PHASE_HOLD_END)));
  const animTop = lerp(centerY, TITLE_CENTER_TOP_PX, flyT);
  const animFontSize = lerp(headlinePx, finalTitlePx, flyT);
  const animCursorPx = lerp(cursorPx, Math.round(finalTitlePx * 0.85), flyT);

  // "Welcome" types in letter-by-letter once fly is well underway. Starting
  // at flyT=0.2 means the first letter lands as the headline approaches its
  // resting place — feels like the word is being written *as* it arrives,
  // not waiting until after the move completes.
  const welcomeStartT = 0.2;
  const welcomeT = clamp01((flyT - welcomeStartT) / (1 - welcomeStartT));
  const welcomeChars = welcomeT * WELCOME_TEXT.length;
  // Math.ceil so a fractional progress shows the in-progress letter the
  // moment it begins (no "blank" half-frames between letters).
  const welcomeTyped = sliceTo(WELCOME_TEXT, Math.ceil(welcomeChars));
  const welcomeVisible = welcomeTyped.length > 0;

  // hey, opacity dips ahead of width-collapse; we let inline-flex naturally
  // recenter around it via `display: none` when fully faded, which is
  // imperceptible since opacity is already 0 by then.
  const heyOpacity = clamp01(1 - flyT * 1.6);
  const heyVisible = heyOpacity > 0.01;

  // Cursor fades out across fly. Past fly-end it's invisible regardless of
  // blink, so we don't keep the blink ticking once flying.
  const cursorOpacity = clamp01(1 - flyT * 1.5);
  const blinkPhase = frame % 30;
  const blinkOpacity = flyT > 0 ? 1 : blinkPhase < 15 ? 1 : 0;

  // ---- Cards entrance ----
  // EaseOutExpo so the cards "lift" decisively without a long tail.
  const cardsT = easeOutExpo(
    clamp01((frame - PHASE_CARDS_START) / (PHASE_CARDS_END - PHASE_CARDS_START))
  );
  const cardsOpacity = cardsT;
  const cardsTranslateY = lerp(24, 0, cardsT);

  return (
    <div
      style={{
        position: "relative",
        minHeight: "100vh",
        backgroundColor: BG,
        backgroundImage: BG_GRADIENT,
        color: INK,
        // Prevent the headline's pre-fly center placement from triggering
        // page scroll on small viewports during the brief moment it's at
        // y=50% with a giant font-size.
        overflow: "hidden",
      }}
    >
      {/* Headline. Absolutely positioned so we can lerp top/font-size cleanly,
          breathing scale wraps it during typing/hold only. */}
      <div
        style={{
          position: "absolute",
          // Above the cards container — once intro settles the cards div
          // flips to pointer-events:auto and (due to its full-viewport
          // height with paddingTop) overlays the headline area, which
          // would otherwise swallow hover events targeting the Sub span.
          zIndex: 10,
          top: animTop,
          left: "50%",
          transform: `translate(-50%, -50%) scale(${breatheScale})`,
          transformOrigin: "center center",
          fontFamily: "Caveat, cursive",
          fontSize: animFontSize,
          fontWeight: 700,
          color: INK,
          lineHeight: 1,
          letterSpacing: "-0.01em",
          whiteSpace: "nowrap",
          display: "flex",
          alignItems: "baseline",
          // The whole row is centered via translate(-50%), so as Welcome
          // letters appear and hey/whatSub change width, the row stays
          // visually centered without any layout-snap.
        }}
      >
        {/* Welcome — typed letter by letter ahead of whatSub during fly. */}
        {welcomeVisible && (
          <span
            style={{
              marginRight: "0.05em",
              whiteSpace: "pre",
              display: "inline-block",
            }}
          >
            {welcomeTyped}
          </span>
        )}

        {!hasStartedTyping ? (
          <span
            style={{
              display: "inline-block",
              width: Math.max(4, Math.round(animCursorPx * 0.05)),
              height: animCursorPx,
              marginLeft: 4,
              marginBottom: -Math.round(animCursorPx * 0.12),
              background: cursorColor,
              opacity: blinkOpacity,
              borderRadius: 2,
            }}
          />
        ) : (
          <span
            style={{
              opacity: lineOpacity,
              display: "inline-flex",
              alignItems: "baseline",
            }}
          >
            {/* hey, fades + collapses; we drop it from the layout once it's
                fully invisible so the inline-flex re-centers cleanly. */}
            {heyVisible && (
              <span
                style={{
                  opacity: heyOpacity,
                  marginRight: heyOpacity > 0.05 ? "0.18em" : 0,
                  display: "inline-block",
                  whiteSpace: "pre",
                }}
              >
                {heyTyped}
              </span>
            )}
            <span>{whatTyped}</span>
            {/* Hovering "Sub" pops it with a soft white halo — playful
                affordance to invite a click without actually doing
                anything. inline-block so transform applies; transform
                doesn't disturb sibling layout (no reflow). */}
            <span
              style={{ color: ACCENT, display: "inline-block" }}
              className="cursor-pointer transition-transform duration-300 ease-out hover:scale-125 hover:[text-shadow:0_0_24px_rgba(255,255,255,0.85),0_0_48px_rgba(255,255,255,0.4)]"
            >
              {subTyped}
            </span>
            {cursorOpacity > 0.01 && (
              <span
                style={{
                  display: "inline-block",
                  width: Math.max(4, Math.round(animCursorPx * 0.05)),
                  height: animCursorPx,
                  marginLeft: 4,
                  marginBottom: -Math.round(animCursorPx * 0.12),
                  background: cursorColor,
                  opacity: cursorOpacity * blinkOpacity,
                  borderRadius: 2,
                }}
              />
            )}
          </span>
        )}
      </div>

      {/* Cards container — pre-mounted from frame 0 with opacity:0 so the
          cards' internal state (settings hooks, model probe results) starts
          warming up immediately and is fully ready by the time it's visible.
          pointer-events guarded until nearly opaque to avoid stray clicks
          mid-fade. paddingTop scales with the responsive title size so the
          cards stay clear of the headline at every viewport. */}
      <div
        className="flex items-start justify-center px-8 pb-8"
        style={{
          paddingTop: TITLE_CENTER_TOP_PX + finalTitlePx + 24,
          opacity: cardsOpacity,
          transform: `translateY(${cardsTranslateY}px)`,
          pointerEvents: cardsOpacity > 0.95 ? "auto" : "none",
        }}
      >
        <div className="w-full" style={{ maxWidth: cardsMaxW }}>
          {children}
        </div>
      </div>
    </div>
  );
}
