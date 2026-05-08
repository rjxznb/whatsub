import { useEffect, useRef, useState } from "react";

/**
 * Visual indicator + draggable handle for a vocab card's saved note.
 *
 * Visual: amber luggage tag dangling off the card by a blue string.
 * The string visibly enters a "punched hole" on the card's top-right
 * corner and exits through the tag's own hole — both holes are real
 * <circle>s/<div>s, not just decorative cutouts.
 *
 * Interaction model:
 *   1. Idle: tag rests at REST position, hanging on the string.
 *   2. Hover: tag's edges glow white (drop-shadow filter pulse).
 *   3. PointerDown + drag: tag follows mouse cursor in real time, the
 *      string re-curves to connect card-hole → cursor.
 *   4. Release with drag distance < PULL_THRESHOLD: spring physics pulls
 *      the tag back to REST with damped oscillation (looks like a real
 *      tag swinging on a string and settling).
 *   5. Drag distance > PULL_THRESHOLD at any point during drag: tag
 *      "snaps off the string" → onPullOff() fires (parent uses this to
 *      open the note bubble). The tag visually flies off-screen briefly
 *      before unmounting.
 *
 * Physics: standard explicit-Euler spring-damper with stiffness K and
 * damping ratio (D, applied as exponential decay per frame for stability
 * across variable RAF rates). Position + velocity in two `useRef`s; only
 * a forced re-render per frame keeps React's view in sync.
 */

interface Props {
  onPullOff: () => void;
}

// SVG-coordinate constants. The SVG is 70×70 px with viewBox 0 0 70 70,
// so SVG units == device pixels (1:1) — drag math in client coords just
// works without a CTM inversion.
const STRING_START = { x: 6, y: 6 };
const REST = { x: 32, y: 42 };
const TAG_RENDER_SIZE = 36;
// The provided tag.svg has its inner hole circle centered at
// (358.9, 364.1) within a 0..1024 viewBox. At 36px render size:
const TAG_HOLE_X = (358.9 / 1024) * TAG_RENDER_SIZE;
const TAG_HOLE_Y = (364.1 / 1024) * TAG_RENDER_SIZE;
const TAG_REST_ROTATION = 26;
// Pull-off threshold: distance (in SVG/px units) from REST beyond which
// the tag "tears off the string" and triggers onPullOff. 110 = roughly
// 1.5× the tag's own size, requires a deliberate yank — accidental
// micro-drags / hover-jiggle / quick swipes won't trigger.
const PULL_THRESHOLD = 110;

// Spring constants. STIFFNESS = how fast it returns; DAMPING_RATE = how
// quickly oscillation dies (smaller = more bounce). Values tuned for a
// "playful tag that wobbles a few times before settling".
const STIFFNESS = 0.18;
const DAMPING = 0.82; // velocity multiplier each frame

export function NoteBadge({ onPullOff }: Props) {
  // Position + velocity live in refs so the RAF loop can mutate at
  // 60 Hz without forcing a render per frame. We trigger re-renders
  // explicitly via setRenderCounter when we want React to re-paint.
  const posRef = useRef({ ...REST });
  const velRef = useRef({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  // Stable rotation that decays back to TAG_REST_ROTATION when not dragged.
  // While dragging, we tilt the tag toward the drag direction so it
  // looks like the cord is angling under tension.
  const rotRef = useRef(TAG_REST_ROTATION);

  const [hovering, setHovering] = useState(false);
  const [pulledOff, setPulledOff] = useState(false);
  const [, force] = useState(0);
  function rerender() {
    force((n) => n + 1);
  }

  // ── Convert client (page) pixel coords → SVG-internal coords ──────
  // SVG viewBox 0..70 mapped to a 70×70 px container at 1:1, so the
  // conversion is just (clientX - svg.left, clientY - svg.top). If we
  // ever change the SVG to render at a different CSS size we'd need
  // to scale, but for now keep it simple.
  function clientToSvg(clientX: number, clientY: number): { x: number; y: number } {
    if (!svgRef.current) return { x: 0, y: 0 };
    const r = svgRef.current.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  // ── Physics RAF loop ────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    function step(now: number) {
      // Normalize dt to 60fps frame units. Cap at 2 to prevent huge
      // catch-up steps after tab inactivity from yeeting the tag
      // across the screen.
      const dt = Math.min((now - last) / 16.67, 2);
      last = now;

      if (!draggingRef.current && !pulledOff) {
        // Spring toward REST
        const dx = posRef.current.x - REST.x;
        const dy = posRef.current.y - REST.y;
        const ax = -STIFFNESS * dx;
        const ay = -STIFFNESS * dy;
        velRef.current.x = (velRef.current.x + ax * dt) * Math.pow(DAMPING, dt);
        velRef.current.y = (velRef.current.y + ay * dt) * Math.pow(DAMPING, dt);
        posRef.current.x += velRef.current.x * dt;
        posRef.current.y += velRef.current.y * dt;

        // Rotation also springs back to rest
        const dr = rotRef.current - TAG_REST_ROTATION;
        rotRef.current = TAG_REST_ROTATION + dr * Math.pow(0.92, dt);

        // Snap to rest when motion is below perceptible threshold
        if (
          Math.abs(dx) < 0.4 &&
          Math.abs(dy) < 0.4 &&
          Math.abs(velRef.current.x) < 0.05 &&
          Math.abs(velRef.current.y) < 0.05 &&
          Math.abs(dr) < 0.5
        ) {
          posRef.current = { ...REST };
          velRef.current = { x: 0, y: 0 };
          rotRef.current = TAG_REST_ROTATION;
        }
      }
      rerender();
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [pulledOff]);

  // ── Drag handlers ────────────────────────────────────────────────────
  function onPointerDown(e: React.PointerEvent) {
    if (pulledOff) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const cursor = clientToSvg(e.clientX, e.clientY);
    dragOffsetRef.current = {
      x: cursor.x - posRef.current.x,
      y: cursor.y - posRef.current.y,
    };
    draggingRef.current = true;
    velRef.current = { x: 0, y: 0 };
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!draggingRef.current) return;
    const cursor = clientToSvg(e.clientX, e.clientY);
    posRef.current.x = cursor.x - dragOffsetRef.current.x;
    posRef.current.y = cursor.y - dragOffsetRef.current.y;

    // Tilt the tag toward the drag direction — a string under tension
    // pulls the tag's hole toward the line of pull.
    const dx = posRef.current.x - STRING_START.x;
    const dy = posRef.current.y - STRING_START.y;
    rotRef.current = (Math.atan2(dy, dx) * 180) / Math.PI - 90 + TAG_REST_ROTATION * 0.4;

    // Pull-off check happens DURING drag — once the user has yanked
    // the tag past the threshold we trigger the action immediately,
    // even before they release. Snappier feel than waiting for release.
    const pullX = posRef.current.x - REST.x;
    const pullY = posRef.current.y - REST.y;
    if (Math.hypot(pullX, pullY) > PULL_THRESHOLD) {
      draggingRef.current = false;
      setPulledOff(true);
      // Tiny delay before onPullOff so user sees the tag fly off briefly.
      setTimeout(() => onPullOff(), 220);
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    // Velocity stays at 0 — release simulates "letting go gently",
    // not throwing. The spring will pull the tag home.
  }

  // ── Compute current rendered values ──────────────────────────────────
  const pos = posRef.current;
  const rot = rotRef.current;

  // Stretch length (for visual feedback near threshold). We tint the
  // string yellow→red as user pulls past 70% of the threshold.
  const pullDist = Math.hypot(pos.x - REST.x, pos.y - REST.y);
  const pullRatio = Math.min(1, pullDist / PULL_THRESHOLD);
  const stringColor =
    pullRatio < 0.7
      ? "#3b82f6" // blue, default
      : interpColor("#3b82f6", "#ef4444", (pullRatio - 0.7) / 0.3);

  // Bezier control point — approximate "rope sag". Halfway between
  // start/end horizontally, slightly below the midpoint vertically so
  // the string looks like it has slack.
  const cx = (STRING_START.x + pos.x) / 2;
  const cy = (STRING_START.y + pos.y) / 2 + 4;

  // Pull-off animation: tag flies further out + fades.
  const pulledOffStyle: React.CSSProperties = pulledOff
    ? {
        transition: "transform 220ms cubic-bezier(0.55, 0, 0.55, 0.2), opacity 220ms",
        transform: `translate(${pos.x + (pos.x - REST.x) * 0.4}px, ${pos.y + (pos.y - REST.y) * 0.4}px) rotate(${rot}deg) translate(${-TAG_HOLE_X}px, ${-TAG_HOLE_Y}px)`,
        opacity: 0,
      }
    : {};

  // Hover glow: animate the drop-shadow's blur/alpha.
  const tagFilter = hovering
    ? "drop-shadow(0 0 6px rgba(255, 255, 255, 0.85)) drop-shadow(0 2px 3px rgba(0, 0, 0, 0.45))"
    : "drop-shadow(0 2px 3px rgba(0, 0, 0, 0.45))";

  return (
    <>
      {/* (a) Hole on the card */}
      <div
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          top: 6,
          right: 8,
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: "#0a0a0a",
          boxShadow:
            "inset 0 1.5px 2px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(82, 82, 91, 0.7)",
        }}
      />

      {/* (b) + (c) String + tag SVG. Positioned so SVG(STRING_START.x,
                   STRING_START.y) overlaps the card hole's center.
                   See math derivation below.
        Card hole center in card-coords (parent-right, top):
          x = right:8 + width:10/2 = 13 from right
          y = top:6 + height:10/2 = 11 from top
        SVG container width = 70, viewBox 0..70.
        We want SVG (6, 6) → (right:13, top:11) on the card.
        SVG (0, 0) needs to be at (right:13 - 6, top:11 - 6) = (right:19, top:5)
        With CSS `right: V`, element's right edge sits at parent_right - V,
        so element's left edge = parent_right - V - 70.
        We want left edge = parent_right - 19 - 70 + 70 = parent_right - 19
        → V = 19 - 70 = -51 (i.e. SVG's right edge extends 51px past card right) */}
      <svg
        ref={svgRef}
        viewBox="0 0 70 70"
        width={70}
        height={70}
        xmlns="http://www.w3.org/2000/svg"
        className="absolute"
        style={{
          top: 5,
          right: -51,
          overflow: "visible",
          touchAction: "none",
          // Only the tag region is interactive — the SVG itself doesn't
          // intercept clicks on the string area.
          pointerEvents: "none",
        }}
      >
        {/* String */}
        <path
          d={`M ${STRING_START.x} ${STRING_START.y} Q ${cx} ${cy} ${pos.x} ${pos.y}`}
          stroke={stringColor}
          strokeWidth={1.8}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.92}
          style={{ pointerEvents: "none" }}
        />

        {/* Tag — interactive hit target */}
        <g
          transform={`translate(${pos.x} ${pos.y}) rotate(${rot}) translate(${-TAG_HOLE_X} ${-TAG_HOLE_Y})`}
          style={{
            pointerEvents: "auto",
            cursor: pulledOff ? "default" : "grab",
            ...pulledOffStyle,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
        >
          <image
            href="/icons/tag.svg"
            x={0}
            y={0}
            width={TAG_RENDER_SIZE}
            height={TAG_RENDER_SIZE}
            style={{
              filter: tagFilter,
              transition: "filter 200ms ease-out",
              pointerEvents: "none",
            }}
          />
          {/* Invisible larger hit target so the tag is easier to grab.
              Sized just bigger than the visible artwork; SVG <rect> with
              fill:transparent still receives pointer events. */}
          <rect
            x={2}
            y={2}
            width={TAG_RENDER_SIZE - 4}
            height={TAG_RENDER_SIZE - 4}
            fill="transparent"
            style={{ pointerEvents: "auto" }}
          />
        </g>
      </svg>
    </>
  );
}

/** Linear interp between two hex colors. Used for the string color
 *  feedback as the user drags past the safe-zone. */
function interpColor(a: string, b: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${[r, g, bl].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
