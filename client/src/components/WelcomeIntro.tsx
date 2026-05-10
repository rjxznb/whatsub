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
// Cursor appears 2 frames after the startup-chime click in the audio
// (click is at 0–0.04s ≈ frame 1.2; +2f puts cursor at frame 3 ≈ 100ms).
// Pre-frame-3, the screen is fully black so the click reads as "the app
// turning on", then the cursor materializes — feels like cause→effect.
const PHASE_CURSOR_APPEAR = 3;
const PHASE_HEY_START = 53;
const PHASE_HEY_END = 75;
const PHASE_WHAT_START = 105;
const PHASE_WHAT_END = 119;
// Beat between "t" landing and "'" punching in — same rationale as the qmark
// gap below: without a beat the apostrophe blurs into the "t" event and reads
// as one keystroke. 6 frames (~200ms) lets the eye register "what" before
// the apostrophe pops in to form the contraction "what'".
const PHASE_APOS_APPEAR = PHASE_WHAT_END + 6;
const PHASE_SUB_START = 131;
const PHASE_SUB_END = 145;
// Beat between "b" landing and "?" punching in. Without this gap the two
// appear on the same frame (Sub finishes typing → qmark renders) which
// reads as a single event and makes the cursor jump right by width("b") +
// width("?") at once. ~270ms (8 frames @ 30fps) gives the eye time to
// register "Sub" + blinking cursor before "?" pops in and the cursor
// shifts one character right — the natural typewriter rhythm.
const PHASE_QMARK_APPEAR = PHASE_SUB_END + 8;
const PHASE_HOLD_END = 185;
// Fly = 30 frames (1.0s). Drives BOTH whatSub's translate-up + scale-down
// AND hey's linear opacity/width fade — shorten this and both speed up
// proportionally. easeOutExpo already front-loads the motion so most of
// whatSub's visible travel completes in the first ~10 frames; the rest is
// the asymptotic tail. 30 frames feels snappy without clipping the tail.
const PHASE_FLY_END = 215;
// "Welcome to" drops in immediately when whatSub lands — physically simulated
// fall + 3 visibly distinct rebounds (each smaller than the last). Total
// drop+bounce duration is ~1.5s so the initial drop reads as weighted (not
// rushed) and each successive bounce has enough screen time to register.
// Width grows in step with the FIRST impact so whatSub finishes shifting
// right by the time Welcome stops bouncing visibly.
const PHASE_DROP_PAUSE_END = PHASE_FLY_END;
const PHASE_DROP_END = 260;
// Cards rise as the bounce settles for one continuous motion — they
// start just before the bounce visually finishes.
const PHASE_CARDS_START = PHASE_DROP_END - 10;
const PHASE_CARDS_END = 290;
const PHASE_IDLE = 295;

// ---- Audio cue ----
// Single startup chime, fires at frame 0 the instant the intro mounts.
// Source file lives in client/public/audio/ and is served from the static
// root, so the path is "/audio/<file>" (relative URL, no host prefix).
const AUDIO_STARTUP: string = "/audio/startup_audio.mp3";
// Single keystroke "click" sample fired when the apostrophe snaps in. The
// startup chime above bakes in the typing sounds for "hey, what" + "Sub" +
// "?" but doesn't have a click for the apostrophe (it was added later), so
// we layer this one extra keystroke on top at PHASE_APOS_APPEAR.
const AUDIO_APOS_KEY: string = "/audio/key_apos.mp3";

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
// Typographic apostrophe (U+2019), not the straight ASCII '. Caveat is a
// cursive font and the curly form blends with the handwritten letterforms;
// it's also the proper Unicode for English contractions like "what's".
const APOS_TEXT = "’";
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
// 0.6 = 60% velocity retained per impact, giving 3 visibly distinct bounce
// peaks (height proportions 1.0 / 0.36 / 0.13 / 0.047). Lower values like
// 0.38 made the 2nd bounce already invisible at headline-font scale.
const RESTITUTION = 0.6;
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

  // Snapshot the inline "hey," and "?" boxes right before fly begins so we
  // can render fixed-positioned ghosts in the same spot during fly. Without
  // this, both would visually fly upward with whatSub (they live inside the
  // headline container that gets translate+scaled), which conflicts with
  // the intent of "let the greeting bookends fade away in place while
  // whatSub leaves alone for the title slot."
  type Ghost = {
    left: number;
    top: number;
    width: number;
    height: number;
    fontSize: number;
  };
  const heyMeasureRef = useRef<HTMLSpanElement>(null);
  const [heyGhost, setHeyGhost] = useState<Ghost | null>(null);
  const qmarkMeasureRef = useRef<HTMLSpanElement>(null);
  const [qmarkGhost, setQmarkGhost] = useState<Ghost | null>(null);
  // Apostrophe gets the same fade-in-place treatment as the bookends — its
  // slot collapses during fly so what + Sub close back together, and a
  // fixed-position ghost held at its pre-fly screen coordinates fades out
  // visually. Final title therefore reads "Welcome to whatSub" (without
  // the apostrophe), matching the post-fly look the user wanted.
  const aposMeasureRef = useRef<HTMLSpanElement>(null);
  const [aposGhost, setAposGhost] = useState<Ghost | null>(null);
  useEffect(() => {
    // Measure as late in hold as possible — we MUST capture after PHASE_SUB_END
    // (so the inline-flex content is the full "hey, whatSub?" and hey's
    // position is at its final pre-fly resting place, not partway through
    // Sub's typing where the container is narrower and hey sits further
    // right). PHASE_HOLD_END - 3 gives a small buffer so the capture lands
    // a few frames before fly starts, with the layout fully settled.
    const MEASURE_AT = PHASE_HOLD_END - 3;
    if (frame < MEASURE_AT) return;
    const snap = (el: HTMLSpanElement): Ghost => {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        fontSize: parseFloat(cs.fontSize),
      };
    };
    if (!heyGhost && heyMeasureRef.current) setHeyGhost(snap(heyMeasureRef.current));
    if (!qmarkGhost && qmarkMeasureRef.current) setQmarkGhost(snap(qmarkMeasureRef.current));
    if (!aposGhost && aposMeasureRef.current) setAposGhost(snap(aposMeasureRef.current));
  }, [frame, heyGhost, qmarkGhost, aposGhost]);

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
      // Continuous float frame counter (no Math.floor) — lets every lerp /
      // ease / physics-bounce interpolation run at the browser's full RAF
      // rate (60Hz on most displays, 120Hz on ProMotion) instead of being
      // visibly stepped at 30Hz. The PHASE_* constants are still "30fps
      // units" so their numeric meaning doesn't change. The few places
      // that need integer frames (typing character count) Math.floor at
      // the use site, not here.
      const f = elapsed / (1000 / 30);
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

  // ---- Startup chime ----
  // Preload + auto-play once on mount. The intro's animation starts at the
  // same instant this component mounts, so there's no need to gate on the
  // frame counter — fire as soon as the Audio element is constructed.
  // catch() swallows browser autoplay-policy rejections (rare in Tauri's
  // WebView2 / WKWebView, which allow autoplay for local content).
  useEffect(() => {
    if (!AUDIO_STARTUP) return;
    const a = new Audio(AUDIO_STARTUP);
    a.preload = "auto";
    void a.play().catch((err) => {
      console.warn("WelcomeIntro startup audio play blocked:", err);
    });
    return () => {
      // Stop the chime if the user navigates away mid-intro (e.g. dev-mode
      // resize remount), otherwise it'd keep playing as an orphaned element.
      a.pause();
      a.currentTime = 0;
    };
  }, []);

  // Keystroke for the apostrophe. Triggers exactly once when the frame
  // counter crosses PHASE_APOS_APPEAR. We schedule it via setTimeout from
  // mount (rather than watching the frame state) so the audio fires on the
  // wall-clock at the right moment — the RAF frame counter can drift a few
  // ms under load and we don't want the click to lag visibly behind the
  // glyph appearing. apostrophePlayedRef guards against StrictMode's
  // double-mount in dev so the click doesn't double-trigger.
  const apostrophePlayedRef = useRef(false);
  useEffect(() => {
    if (!AUDIO_APOS_KEY) return;
    if (apostrophePlayedRef.current) return;
    const delayMs = (PHASE_APOS_APPEAR / 30) * 1000;
    const timer = setTimeout(() => {
      apostrophePlayedRef.current = true;
      const a = new Audio(AUDIO_APOS_KEY);
      a.preload = "auto";
      void a.play().catch((err) => {
        console.warn("WelcomeIntro apostrophe key audio play blocked:", err);
      });
    }, delayMs);
    return () => clearTimeout(timer);
  }, []);

  // ---- Typing progress ----
  const heyChars =
    clamp01((frame - PHASE_HEY_START) / (PHASE_HEY_END - PHASE_HEY_START)) * HEY_TEXT.length;
  const heyTyped = sliceTo(HEY_TEXT, Math.floor(heyChars));

  const whatChars =
    clamp01((frame - PHASE_WHAT_START) / (PHASE_WHAT_END - PHASE_WHAT_START)) * WHAT_TEXT.length;
  const whatTyped = sliceTo(WHAT_TEXT, Math.floor(whatChars));

  // Apostrophe between "what" and "Sub". Single character — snap-in like the
  // "?" rather than a typing window, the typewriter rhythm comes from the
  // 6-frame beat after "t" lands (PHASE_APOS_APPEAR).
  const aposTyped = frame >= PHASE_APOS_APPEAR ? APOS_TEXT : "";

  const subChars =
    clamp01((frame - PHASE_SUB_START) / (PHASE_SUB_END - PHASE_SUB_START)) * SUB_TEXT.length;
  const subTyped = sliceTo(SUB_TEXT, Math.floor(subChars));

  // The "?" caps the brand line — punches in 8 frames AFTER Sub finishes
  // typing (PHASE_QMARK_APPEAR), so it doesn't blur into the same event
  // as "b" landing. The cursor naturally trails the qmark span (rendered
  // last in the inline-flex row) so once "?" appears the cursor is on
  // its right. Single character — we snap it in rather than running a
  // typing window. Color is white (INK), overriding Sub's ACCENT since
  // the ? lives in its own span.
  const qmarkTyped = frame >= PHASE_QMARK_APPEAR ? "?" : "";

  const lineOpacity = easeOutExpo(clamp01((frame - (PHASE_HEY_START - 4)) / 10));
  const hasStartedTyping = frame >= PHASE_HEY_START;
  const cursorColor = frame >= PHASE_SUB_START ? ACCENT : INK;
  // Breathe amplitude tapers linearly to 0 over the last 15 frames of hold so
  // the transition to the flat scale=1.0 fly state is continuous. Without
  // this, breatheScale dropped from ~1.002 to 1.0 in a single frame at
  // PHASE_HOLD_END — that 0.2% scale snap shifted whatSub by ~0.6px (since
  // it sits ~300px off the headline's center), visible as a tiny position
  // jump at the moment fly starts.
  const breatheTaper = clamp01((PHASE_HOLD_END - frame) / 15);
  const breatheScale =
    frame < PHASE_HOLD_END
      ? 1 + Math.sin((frame / 30) * 1.2) * 0.004 * breatheTaper
      : 1;

  // ---- Fly transition ----
  // Land at finalTitlePx (responsive, derived from viewport width) so the
  // post-fly idle state matches what the user resizes to without snapping
  // — if the user resizes mid-fly the target moves smoothly with them.
  // Linear (not eased) — whatSub moves at constant speed in a straight
  // line to the title slot. Previous easeOutExpo gave a "thrown object"
  // feel that front-loaded the motion; user wanted plainer/uniform.
  const flyT = clamp01((frame - PHASE_HOLD_END) / (PHASE_FLY_END - PHASE_HOLD_END));
  // True only while Sub is geometrically transitioning between the giant
  // centered headline and the static title slot — i.e. the fly window AND
  // the bookend-fade window. Outside this window Sub sits still in either
  // its pre-fly or post-fly position and is safe to hover. Using a frame
  // window rather than `flyT > 0` because flyT clamps to 1 at fly end and
  // never returns to 0, which would leave hover permanently disabled.
  const isFlying = frame >= PHASE_HOLD_END && frame < PHASE_FLY_END;
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

  // hey + "?" have TWO independent timelines during fly:
  //
  //   heyT (fast)        — visual opacity fade. Completes in the first
  //                        HEY_FADE_FRACTION of fly so the bookends visually
  //                        vanish quickly (cosmetic only).
  //   heyLayoutT (slow)  — slot width collapse + inline visibility flip.
  //                        Synced with flyT, linear over the full fly window.
  //
  // Why two: whatSub's screen position depends on the inline-flex layout —
  // as hey/? slots collapse, the centered container re-centers and whatSub
  // shifts left. If layout collapse ran on heyT (faster than flyT), whatSub's
  // path would have a kink (rapid NW first, then pure N) instead of a single
  // straight diagonal from start to title slot. Tying layout collapse to
  // flyT keeps whatSub's velocity constant on BOTH axes — a clean straight
  // line — while opacity still gets to fade out faster (purely visual, no
  // geometric impact).
  //
  // The HEY_FADE_FRACTION knob: lower for snappier visual disappearance
  // (0.35 = first 35% of fly), 1.0 to fade in lockstep with the layout.
  const HEY_FADE_FRACTION = 0.5;
  const heyT = clamp01(
    (frame - PHASE_HOLD_END) /
      ((PHASE_FLY_END - PHASE_HOLD_END) * HEY_FADE_FRACTION),
  );
  const heyOpacity = 1 - heyT;
  const heyLayoutT = flyT;
  // Keep the inline span mounted until the slot is fully collapsed.
  // Previously this was gated on heyOpacity, which unmounted the span
  // mid-fly and snapped whatSub left by the residual slot width in one
  // frame. Gating on layout instead means unmount only happens once the
  // slot is already 0 width — layout-neutral.
  const heyVisible = heyLayoutT < 0.99;

  // Pre-fly bookend slot widths in ABSOLUTE PIXELS. Using px (not em)
  // keeps the slot-collapse a single linear (1 - flyT) factor instead of
  // compounding with animFontSize's own (1 - flyT) shrink — that compound
  // produces a quadratic px-width over flyT, which translates to a CURVED
  // path for whatSub on the horizontal axis (the inline-flex re-centering
  // around the shrinking content). Px-fixed slot widths give linear-in-
  // flyT collapse, matching the linear vertical animTop, so whatSub
  // traces a single straight line from origin to title slot.
  const heySlotPx = heyGhost ? heyGhost.width : 0;
  const heySlotMarginPx = heyGhost ? 0.18 * heyGhost.fontSize : 0;
  const qmarkSlotPx = qmarkGhost ? qmarkGhost.width : 0;
  const aposSlotPx = aposGhost ? aposGhost.width : 0;

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
          // willChange + backfaceVisibility promote this to its own
          // composite layer so the browser GPU-translates a cached glyph
          // texture per frame instead of re-painting + re-compositing the
          // whole row. Without these, macOS WKWebView leaves glyph trail
          // artifacts during the fly transform animation (a known
          // CALayer-invalidation bug specific to Safari/WKWebView; Chromium
          // / Edge WebView2 don't have it).
          willChange: "transform, opacity",
          backfaceVisibility: "hidden",
          // Padding gives the WKWebView composite layer extra texture
          // around the inline content so Caveat's glyph overflow
          // (descender on "y", right curl on "?", trailing tail on "b")
          // has room to render WITHIN the layer bounds. Without it, the
          // composite layer is sized exactly to the layout bounding rect
          // and ink that draws past that rect gets clipped (Mac-only —
          // Chromium auto-pads composite layers for ink overflow, but
          // WKWebView doesn't). Padding is symmetric so translate(-50%,
          // -50%) re-centers the (now padded) box around viewport center
          // — the visible text position is unchanged.
          // Bumped from 0.4em → 0.8em horizontal because Caveat's "?"
          // right curl extends ~0.5em past its advance box at the
          // headline font size, and the previous 0.4em was still
          // catching the tip on Mac at certain animation frames.
          padding: "0.3em 0.8em",
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
          frame >= PHASE_CURSOR_APPEAR && (
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
          )
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
                  // takes over the visible role. heyLayoutT (= flyT) drives
                  // both the visibility flip and the collapse so the slot
                  // shrinks at the SAME rate whatSub is travelling vertically
                  // — that's what keeps whatSub's path a single straight
                  // diagonal line rather than two segments with a kink.
                  visibility: heyLayoutT > 0 ? "hidden" : "visible",
                  // Width: pre-fly = auto (fits text at current fontSize,
                  // ≈ heySlotPx since fontSize is still headlinePx). During
                  // fly we collapse linearly in PIXELS — see heySlotPx
                  // declaration above for why px (not em).
                  width:
                    heyLayoutT > 0 && heyGhost
                      ? `${heySlotPx * (1 - heyLayoutT)}px`
                      : "auto",
                  // marginRight: pre-capture (heyGhost still null), use the
                  // em-based formula so the gap between "hey," and "what"
                  // exists from frame 0 onward — without this fallback,
                  // heySlotMarginPx is 0 pre-capture, the gap is 0, and at
                  // the moment heyGhost gets captured (frame 170) the gap
                  // pops up to 23px, shoving whatSub ~11px to the right
                  // visibly. Once heyGhost exists, switch to px-based for
                  // the linear-collapse trajectory math (em would multiply
                  // by animFontSize, breaking the straight-line path).
                  // 0.18em and heySlotMarginPx are equal at fontSize =
                  // headlinePx (which holds throughout pre-fly), so the
                  // switch at capture time is layout-neutral.
                  marginRight: heyGhost
                    ? `${heySlotMarginPx * (1 - heyLayoutT)}px`
                    : `${0.18 * (1 - heyLayoutT)}em`,
                  display: "inline-block",
                  // Caveat is a cursive font where descenders (y, p, g) and
                  // right-bearings (?, !) extend past the metric advance
                  // box. overflow: hidden would cut those off pre-fly. We
                  // don't need clipping during fly either since the inline
                  // text is visibility:hidden then — the ghost takes over
                  // the visible role.
                  overflow: "visible",
                  whiteSpace: "pre",
                }}
              >
                {heyTyped}
              </span>
            )}
            <span>{whatTyped}</span>
            {/* Apostrophe — sits between "what" and "Sub" as part of the
                "what'Sub" contraction (INK / white so it reads as part of
                "what's"). During fly we collapse the slot 1→0 in lockstep
                with the bookends and hide the inline glyph; a fixed-position
                ghost (rendered below) takes over the visible role and fades
                in place. Final title therefore reads "Welcome to whatSub"
                without the apostrophe — same disappearance pattern as
                "hey," and "?". */}
            {heyVisible && (
              <span
                ref={aposMeasureRef}
                style={{
                  color: INK,
                  display: "inline-block",
                  visibility: heyLayoutT > 0 ? "hidden" : "visible",
                  width:
                    heyLayoutT > 0 && aposGhost
                      ? `${aposSlotPx * (1 - heyLayoutT)}px`
                      : "auto",
                  overflow: "visible",
                  whiteSpace: "pre",
                }}
              >
                {aposTyped}
              </span>
            )}
            {/* Hovering "Sub" pops it with a soft white halo — playful
                affordance to invite a click without actually doing
                anything. inline-block so transform applies; transform
                doesn't disturb sibling layout (no reflow).

                During fly we disable the hover effect entirely. Two
                reasons: (a) once flying, Sub is in motion and inviting a
                click is misleading; (b) on macOS WKWebView, stacking the
                hover scale-up + text-shadow on top of the parent's
                animating transform causes glyph trail artifacts (the
                compositor leaves stale glyph layers behind). Idle Sub
                still gets the playful hover. */}
            {/* Hover is enabled when Sub is visually parked — i.e. before
                fly starts (typing/hold) AND after fly fully settles (idle).
                The earlier `flyT > 0` gate disabled hover the moment fly
                began but, since flyT clamps to 1 forever, never re-enabled
                it post-idle, so the playful hover the comment promises was
                effectively dead at the static title. We instead tie the
                gate to whether a layout transition is in flight. */}
            <span
              style={{
                color: ACCENT,
                display: "inline-block",
                pointerEvents: isFlying ? "none" : "auto",
              }}
              className={
                isFlying
                  ? "cursor-default"
                  : "cursor-pointer transition-transform duration-300 ease-out hover:scale-125 hover:[text-shadow:0_0_24px_rgba(255,255,255,0.85),0_0_48px_rgba(255,255,255,0.4)]"
              }
            >
              {subTyped}
            </span>
            {/* "?" caps the brand line in white — same Caveat font as the
                rest (inherited from the headline container). Sits between
                Sub and the cursor so the cursor naturally blinks just
                right of the question mark once it appears.

                Disappears just like "hey,": pre-fly visible, during fly
                visibility:hidden + slot collapses 1→0 (so whatSub
                re-centers as the right bookend collapses too), and a
                fixed-position ghost rendered below fades opacity in place. */}
            {heyVisible && (
              <span
                ref={qmarkMeasureRef}
                style={{
                  color: INK,
                  display: "inline-block",
                  // Both controls switch on heyLayoutT (= flyT) so the right
                  // bookend collapses in lockstep with the left, keeping
                  // whatSub centered (relative to the shrinking content
                  // width) at a constant horizontal velocity through fly.
                  visibility: heyLayoutT > 0 ? "hidden" : "visible",
                  // Px-based collapse — same reason as hey: keeps
                  // whatSub's horizontal motion linear in flyT.
                  width:
                    heyLayoutT > 0 && qmarkGhost
                      ? `${qmarkSlotPx * (1 - heyLayoutT)}px`
                      : "auto",
                  // overflow: visible (not hidden) — same reason as hey:
                  // Caveat's "?" curves out past the advance box, and
                  // overflow: hidden would chop the right half off.
                  overflow: "visible",
                  whiteSpace: "pre",
                }}
              >
                {qmarkTyped}
              </span>
            )}
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
          eye sees a single continuous element that fades, not a swap.
          Render gate is heyT (not flyT) so it stays consistent with the
          inline visibility flip — both flip at exactly the same frame. */}
      {heyT > 0 && heyGhost && (
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

      {/* "?" ghost — twin of the hey ghost above, captured at the same
          pre-fly frame and fading via the same heyOpacity timeline so the
          two greeting bookends disappear in lockstep visually.
          paddingRight + overflow:visible give the WKWebView composite
          layer extra room on the right so Caveat's "?" curl doesn't
          get clipped at the layer edge — the explicit `width` here is
          the glyph's advance box, which excludes ink overflow. */}
      {heyT > 0 && qmarkGhost && (
        <span
          style={{
            position: "fixed",
            left: qmarkGhost.left,
            top: qmarkGhost.top,
            width: qmarkGhost.width,
            height: qmarkGhost.height,
            paddingRight: "0.5em",
            overflow: "visible",
            fontFamily: "Caveat, cursive",
            fontSize: qmarkGhost.fontSize,
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
          ?
        </span>
      )}

      {/* Apostrophe ghost — same fade-in-place treatment as hey/qmark.
          Pinned at its pre-fly screen coordinates while the headline flies
          up, so visually it stays put and dissolves rather than tagging
          along with whatSub. */}
      {heyT > 0 && aposGhost && (
        <span
          style={{
            position: "fixed",
            left: aposGhost.left,
            top: aposGhost.top,
            width: aposGhost.width,
            height: aposGhost.height,
            fontFamily: "Caveat, cursive",
            fontSize: aposGhost.fontSize,
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
          {APOS_TEXT}
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
