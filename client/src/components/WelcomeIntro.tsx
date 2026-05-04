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
// "Welcome to" drops in immediately when whatSub lands — physically simulated
// fall + 3 progressively smaller rebounds, ~1s end-to-end. Width grows in
// step with the FIRST impact so whatSub finishes shifting right by the time
// Welcome stops bouncing visibly.
const PHASE_DROP_PAUSE_END = PHASE_FLY_END;
const PHASE_DROP_END = 230;
// Cards rise as the bounce settles for one continuous motion — they
// start just before the bounce visually finishes.
const PHASE_CARDS_START = PHASE_DROP_END - 10;
const PHASE_CARDS_END = 260;
const PHASE_IDLE = 265;

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
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
// Real-physics bounce: free-fall under constant gravity from height 1, then
// each impact reflects with velocity scaled by RESTITUTION (energy loss
// per bounce). Returns the height above the floor (0..1) at normalized
// time t (0..1, where t=1 is "fully settled").
//
// Why physics rather than Penner's easeOutBounce: the canonical Penner
// curve has fixed bounce-fraction breakpoints (.75, .9375, .984375) that
// look slightly artificial — the rebound timing isn't actually consistent
// with gravity. With real physics, fall + bounce intervals scale by the
// same factor as the heights, so the rhythm matches what your eye expects
// from a real falling object.
const RESTITUTION = 0.38;          // velocity retained per impact (rubber ball ≈ 0.4-0.5)
const G = 2;                       // gravity (px/time² in normalized units)
const T_FALL = Math.sqrt(2 / G);   // time of initial fall from height 1
// Total motion time = initial fall + sum of all subsequent bounce arcs.
// Each bounce arc takes 2*v_impact*e^n / G, so the sum is geometric.
const T_TOTAL = T_FALL * (1 + (2 * RESTITUTION) / (1 - RESTITUTION));

function physicsBounce(t: number): number {
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  const tRaw = t * T_TOTAL;

  // Initial free-fall from height 1
  if (tRaw < T_FALL) {
    return 1 - 0.5 * G * tRaw * tRaw;
  }

  // Subsequent bounces — each starts at the floor, peaks at e²×previous
  // peak, then returns to the floor. Iterate until energy is negligible.
  let phaseStart = T_FALL;
  let vImpact = G * T_FALL;
  for (let n = 0; n < 12; n++) {
    const vUp = RESTITUTION * vImpact;
    if (vUp < 0.005) return 0;
    const arcTime = (2 * vUp) / G;
    const arcEnd = phaseStart + arcTime;
    if (tRaw < arcEnd) {
      const localT = tRaw - phaseStart;
      return Math.max(0, vUp * localT - 0.5 * G * localT * localT);
    }
    phaseStart = arcEnd;
    vImpact = vUp;
  }
  return 0;
}

// Fraction of normalized drop time that has elapsed by the first floor
// impact — used to drive the layout-width animation so whatSub finishes
// sliding right exactly when Welcome lands (subsequent rebounds are pure
// vertical motion, no horizontal layout change).
const FIRST_IMPACT_FRACTION = T_FALL / T_TOTAL;
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

  // Measure "Welcome to " width at the title font size once Caveat has
  // actually loaded — needed so the drop animation can lerp the layout
  // width 0→baseW continuously (rather than display:none → auto, which
  // would snap whatSub right by ~half the welcome width on the appear
  // frame). Stored in px at TITLE_FONT_PX; we scale per-frame by the
  // current animFontSize / TITLE_FONT_PX ratio.
  const welcomeMeasureRef = useRef<HTMLSpanElement>(null);
  const [welcomeBaseW, setWelcomeBaseW] = useState(0);
  useEffect(() => {
    let cancelled = false;
    document.fonts.ready.then(() => {
      if (cancelled) return;
      if (welcomeMeasureRef.current) {
        setWelcomeBaseW(welcomeMeasureRef.current.getBoundingClientRect().width);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Snapshot the inline "hey," box right before fly begins so we can
  // render a fixed-positioned ghost in the same spot during fly. Without
  // this, "hey," visually flies upward with whatSub (it lives inside the
  // headline container that gets translate+scaled), which conflicts with
  // the intent of "let hey fade away in place while whatSub leaves."
  const heyMeasureRef = useRef<HTMLSpanElement>(null);
  const [heyGhost, setHeyGhost] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
    fontSize: number;
  } | null>(null);
  useEffect(() => {
    // Measure once hey is fully typed and stable, well before fly. We
    // pick the middle of hold so layout is settled and the breathe-scale
    // wobble has averaged out enough that the snapshot matches what's
    // visible.
    const MEASURE_AT = (PHASE_HEY_END + PHASE_HOLD_END) / 2;
    if (frame >= MEASURE_AT && !heyGhost && heyMeasureRef.current) {
      const rect = heyMeasureRef.current.getBoundingClientRect();
      const cs = getComputedStyle(heyMeasureRef.current);
      setHeyGhost({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        fontSize: parseFloat(cs.fontSize),
      });
    }
  }, [frame, heyGhost]);

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

  // "Welcome to " drops in AFTER fly fully settles (PHASE_DROP_PAUSE_END).
  // Two synchronized progresses:
  //   widthT (easeOutCubic) — smoothly grows the layout width from 0 to
  //     the measured baseline width; the inline-flex container expands as
  //     this happens, which gracefully shifts whatSub to the right rather
  //     than snapping it the moment Welcome appears.
  //   bounceT (easeOutBounce) — drives a translateY drop from above. The
  //     bounce curve has 3 successively smaller rebounds, so the word
  //     visibly settles like it has weight.
  // Opacity ramps in fast (full by ~25% of drop) so the word is solid by
  // the time it reaches the floor and starts bouncing.
  const dropRawT = clamp01(
    (frame - PHASE_DROP_PAUSE_END) / (PHASE_DROP_END - PHASE_DROP_PAUSE_END)
  );
  // Width finishes growing at the first impact — after that we're just
  // bouncing in place, no more horizontal layout change. easeOutCubic on
  // the time-stretched first-impact window so whatSub eases into its new
  // x position rather than ending the slide abruptly.
  const welcomeWidthT = easeOutCubic(clamp01(dropRawT / FIRST_IMPACT_FRACTION));
  // Vertical position from the physics simulator: 1 = release height
  // above the baseline, 0 = settled at baseline.
  const heightAboveFloor = physicsBounce(dropRawT);
  const welcomeOpacity = clamp01(dropRawT * 4);
  const welcomeVisible = dropRawT > 0;
  // Drop distance scales with current font size so it always falls from
  // roughly one line-height above the baseline.
  const welcomeDropPx = -heightAboveFloor * 1.4 * animFontSize;
  // Pre-scale the measured base width by current font size (responsive
  // headline grows on wide viewports, so the slot must too).
  const welcomeFontScale = animFontSize / TITLE_FONT_PX;
  const welcomeAnimWidth = welcomeBaseW * welcomeFontScale * welcomeWidthT;

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
      {/* Hidden measurement node for "Welcome to " at the title font size.
          Read once after document.fonts.ready resolves so the drop animation
          knows the natural width to lerp the layout slot up to. */}
      <span
        ref={welcomeMeasureRef}
        style={{
          position: "fixed",
          top: -9999,
          left: -9999,
          visibility: "hidden",
          pointerEvents: "none",
          fontFamily: "Caveat, cursive",
          fontSize: TITLE_FONT_PX,
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: "-0.01em",
          whiteSpace: "pre",
        }}
      >
        {WELCOME_TEXT}
      </span>

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
        {/* Welcome to — outer span owns the layout width (animated 0→full
            via welcomeAnimWidth) so the inline-flex container expands
            continuously and shifts whatSub right without snapping.
            Inner span owns the visual: drop from above + bounce + fade.
            overflow:hidden clips the dropping inner span so it doesn't
            spill above the headline while it's still falling. */}
        {welcomeVisible && (
          <span
            style={{
              display: "inline-block",
              width: welcomeAnimWidth,
              overflow: "hidden",
              whiteSpace: "pre",
              verticalAlign: "baseline",
            }}
          >
            <span
              style={{
                display: "inline-block",
                opacity: welcomeOpacity,
                transform: `translateY(${welcomeDropPx}px)`,
                whiteSpace: "pre",
              }}
            >
              {WELCOME_TEXT}
            </span>
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
            {/* hey, — pre-fly: rendered inline so the headline is
                "hey, whatSub" centered as a unit. fly: hidden but its slot
                width collapses 0→full×(1-flyT) so whatSub eases left into
                the container's center; the actual visible "hey," is
                rendered below as a fixed-position ghost so it stays put
                while the headline flies up. heyMeasureRef captures its
                pre-fly geometry mid-hold for the ghost. */}
            {heyVisible && (
              <span
                ref={heyMeasureRef}
                style={{
                  // Pre-fly hey, is fully visible. During fly we hide it
                  // (visibility, not display, so the slot still occupies
                  // space we can collapse smoothly) and the ghost overlay
                  // takes over the visible role.
                  visibility: flyT > 0 ? "hidden" : "visible",
                  // Width: pre-fly = auto (fits text). During fly we lerp
                  // from the hey-glyph-width-at-current-fontsize down to 0.
                  // We use em (a fraction of current fontSize) so the slot
                  // scales with animFontSize as the headline shrinks,
                  // keeping the collapse proportional rather than getting
                  // visually stuck at a stale px width.
                  width:
                    flyT > 0 && heyGhost
                      ? `${(heyGhost.width / heyGhost.fontSize) * (1 - flyT)}em`
                      : "auto",
                  marginRight: `${0.18 * (1 - flyT)}em`,
                  display: "inline-block",
                  overflow: "hidden",
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

      {/* hey, ghost — fixed at its pre-fly position, fades in place while
          the headline container flies up. Same font / size / weight /
          letter-spacing / lineHeight as the inline measurement so the
          ghost is pixel-identical to where hey, sat in the headline; the
          eye sees a single continuous element that fades, not a swap. */}
      {flyT > 0 && heyGhost && (
        <span
          style={{
            position: "fixed",
            left: heyGhost.left,
            top: heyGhost.top,
            width: heyGhost.width,
            height: heyGhost.height,
            fontFamily: "Caveat, cursive",
            fontSize: heyGhost.fontSize,
            fontWeight: 700,
            color: INK,
            lineHeight: 1,
            letterSpacing: "-0.01em",
            whiteSpace: "pre",
            opacity: heyOpacity,
            pointerEvents: "none",
            zIndex: 11,
          }}
        >
          {HEY_TEXT}
        </span>
      )}

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
