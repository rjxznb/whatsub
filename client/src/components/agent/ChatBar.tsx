// src/components/agent/ChatBar.tsx
//
// Three-state Spotlight-style ChatBar (Task 33, 2026-05-30):
//
//   icon  — small ~80x36 pill button (Bot + "AI") with optional unread dot.
//   bar   — 600px input row (~52px tall). Existing collapsed UX.
//   panel — full conversation (header + body + confirms + input).
//
// State machine:
//   icon  → bar    : click anywhere on the icon
//   bar   → panel  : click anywhere on the bar (excluding the textarea/buttons)
//   panel → page-default : click outside (suppressed while streaming) OR ✕
//
// `pageDefaultMode` is "icon" on /player/* (keep video real estate clean)
// and "bar" everywhere else. AgentRoot computes it from useLocation().
//
// Draggable in ALL states. mousedown on the container records the start;
// mousemove updates position with viewport clamping; mouseup either:
//   - persists the new position to localStorage (delta > 5px), or
//   - treats the gesture as a click → advances the mode.
// Interactive descendants (button/textarea/input/select/[role=menu]) are
// exempt — they handle their own clicks without starting a drag.
//
// Two independent positions persist (top-left corner, viewport px):
//   agentIconPos  : the icon
//   agentBarPos   : the bar AND panel (panel grows upward from bar bottom)

import { useEffect, useRef, useState, type ReactNode } from "react";
import whatsubIcon from "../../assets/whatsub-icon.png";
import { useVoiceMode } from "../../store/voiceMode";

export type ChatBarMode = "icon" | "bar" | "panel";

interface Position {
  x: number;
  y: number;
}

interface Props {
  mode: ChatBarMode;
  onModeChange: (mode: ChatBarMode) => void;
  /** True while a runtime turn is mid-stream. Suppresses click-outside collapse. */
  streaming: boolean;
  /** Show the unread dot on the icon when collapsed. */
  hasUnread: boolean;
  header: ReactNode;
  body: ReactNode;
  inlineConfirms: ReactNode;
  inputBox: ReactNode;
}

const ICON_W = 40;
const ICON_H = 40;
const BAR_W = 600;
// Bar's single-line minimum height. With InputBox's py-1.5 (12px total
// vertical padding) wrapping the h-9 button (36px), inner content = 48px,
// plus the bar's 2px box-border = 50px. Multi-line still grows: textarea
// auto-resize caps at 96px, bar follows up to ~110px.
const BAR_H = 50;
const STRETCH_MS = 280;
const DRAG_THRESHOLD_PX = 5;
const ICON_POS_KEY = "agentIconPos";
const BAR_POS_KEY = "agentBarPos";

function viewportW(): number {
  return typeof window === "undefined" ? 1024 : window.innerWidth;
}
function viewportH(): number {
  return typeof window === "undefined" ? 768 : window.innerHeight;
}

function defaultIconPos(): Position {
  return {
    x: Math.max(0, viewportW() - ICON_W - 20),
    y: Math.max(0, viewportH() - ICON_H - 48),
  };
}
function defaultBarPos(): Position {
  return {
    x: Math.max(0, viewportW() / 2 - BAR_W / 2),
    // 80px bottom margin (was 48, originally 24): some users still saw the
    // bar partially cut off because Tauri can over-report innerHeight in
    // certain window configurations. 80px gives a generous clearance; users
    // who want it lower can drag and the new position persists.
    y: Math.max(0, viewportH() - BAR_H - 80),
  };
}

function loadPos(
  key: string,
  fallback: () => Position,
  w: number,
  h: number,
): Position {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const p = JSON.parse(raw);
      if (
        p &&
        typeof p.x === "number" &&
        typeof p.y === "number" &&
        Number.isFinite(p.x) &&
        Number.isFinite(p.y)
      ) {
        // Defensive clamp: a saved position from an earlier session with a
        // larger viewport (or a bug in a previous code version) can put the
        // bar partly off-screen on this run. Force it inside the current
        // viewport before using.
        return clampToViewport({ x: p.x, y: p.y }, w, h);
      }
    }
  } catch {
    /* corrupt JSON / quota — fall through to default */
  }
  return fallback();
}

function savePos(key: string, p: Position) {
  try {
    localStorage.setItem(key, JSON.stringify(p));
  } catch {
    /* quota / unavailable — drop silently */
  }
}

function clampToViewport(p: Position, w: number, h: number): Position {
  const maxX = Math.max(0, viewportW() - w);
  const maxY = Math.max(0, viewportH() - h);
  return {
    x: Math.max(0, Math.min(maxX, p.x)),
    y: Math.max(0, Math.min(maxY, p.y)),
  };
}

/** Panel height: 60vh capped at 600px. */
function panelHeightPx(): number {
  return Math.min(viewportH() * 0.6, 600);
}

export function ChatBar({
  mode,
  onModeChange,
  streaming,
  hasUnread,
  header,
  body,
  inlineConfirms,
  inputBox,
}: Props) {
  const [iconPos, setIconPos] = useState<Position>(() =>
    loadPos(ICON_POS_KEY, defaultIconPos, ICON_W, ICON_H),
  );
  const [barPos, setBarPos] = useState<Position>(() =>
    loadPos(BAR_POS_KEY, defaultBarPos, BAR_W, BAR_H),
  );

  // Re-clamp on viewport resize so a previously-fine position doesn't end up
  // off-screen after the user resizes the Tauri window.
  useEffect(() => {
    const onResize = () => {
      setIconPos((p) => clampToViewport(p, ICON_W, ICON_H));
      setBarPos((p) => clampToViewport(p, BAR_W, BAR_H));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);
  // Drag state lives in a ref so the document-level mousemove closure sees
  // synchronous updates (we mirror selected fields into React state where
  // necessary, but the active gesture must not rely on re-renders).
  const dragRef = useRef<{
    startMouse: Position;
    startPos: Position;
    moved: boolean;
    mode: ChatBarMode;
  } | null>(null);
  // Mirrored into state so the CSS-transition gate can re-render. We disable
  // transitions while dragging — otherwise the bar lags behind the cursor.
  const [dragging, setDragging] = useState(false);

  // "Stretch left" animation when transitioning OUT of icon mode. We render
  // the bar at the icon's geometry on the FIRST frame, then snap to the bar's
  // real (persisted) geometry on the next frame so the CSS transition
  // interpolates top + left + width + height — visually the bar slides + grows
  // from where the icon was to its bar/panel location.
  //
  // Critically, barPos is NOT mutated — only the transient `stretchFrom`
  // overrides geometry during the animation. After the animation clears, the
  // bar renders at its persisted (or default) barPos as if no override
  // happened.
  const [stretchFrom, setStretchFrom] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  // The reverse collapse animation (bar/panel → icon) was removed: a stale
  // timer could survive a mid-animation dep change (e.g., page navigation
  // adjusting iconPos), leaving the bar's chrome stuck mounted at icon size
  // — visually a gray square instead of the whatsub logo. Collapsing to icon
  // is now a plain JSX swap (snap), which is bulletproof. The forward
  // stretch (icon → bar/panel) animation below stays.
  const prevModeRef = useRef<ChatBarMode>(mode);
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = mode;

    // Expand: icon → bar/panel
    if (mode !== "icon" && prev === "icon") {
      setStretchFrom({ x: iconPos.x, y: iconPos.y, w: ICON_W, h: ICON_H });
      let r2: number | null = null;
      const r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setStretchFrom(null));
      });
      return () => {
        cancelAnimationFrame(r1);
        if (r2 != null) cancelAnimationFrame(r2);
      };
    }
  }, [mode, iconPos.x, iconPos.y]);

  // Click-outside-to-collapse — STEP DOWN by one level, not jump to default.
  // Suppressed during streaming (panel only — bar mode doesn't stream so no
  // suppression needed there).
  //   panel → bar (history closes, input row remains so the user can keep
  //                typing if they were mid-thought)
  //   bar   → icon (fully collapse to the floating logo)
  //   icon  → no-op (can't collapse further; click-outside is irrelevant)
  // mousedown beats click — collapse wins the race against any button on the
  // page below registering its click.
  useEffect(() => {
    if (mode === "icon") return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (mode === "panel" && streaming) return;
      const node = containerRef.current;
      if (!node) return;
      if (e.target instanceof Node && node.contains(e.target)) return;
      onModeChange(mode === "panel" ? "bar" : "icon");
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [mode, streaming, onModeChange]);

  // Drag start: only fires when mousedown lands on the container's
  // non-interactive area. Buttons + textarea + input + select +
  // [role=menu] descendants short-circuit so they behave normally.
  const onContainerMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, textarea, input, select, [role=menu]")) return;

    const currentPos = mode === "icon" ? iconPos : barPos;
    dragRef.current = {
      startMouse: { x: e.clientX, y: e.clientY },
      startPos: { ...currentPos },
      moved: false,
      mode,
    };

    const onMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = ev.clientX - drag.startMouse.x;
      const dy = ev.clientY - drag.startMouse.y;
      if (
        !drag.moved &&
        (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX)
      ) {
        drag.moved = true;
        setDragging(true);  // disable CSS transition so the bar tracks the cursor
      }
      if (!drag.moved) return;
      const next = {
        x: drag.startPos.x + dx,
        y: drag.startPos.y + dy,
      };
      let clamped: Position;
      if (drag.mode === "icon") {
        clamped = clampToViewport(next, ICON_W, ICON_H);
      } else if (drag.mode === "bar") {
        clamped = clampToViewport(next, BAR_W, BAR_H);
      } else {
        // panel: barPos.y represents the bar's top, but the rendered panel
        // anchors its BOTTOM to barPos.y + BAR_H. To keep the panel fully
        // inside the viewport while dragging vertically:
        //   panel top    = barPos.y + BAR_H - h ≥ 0
        //     → barPos.y ≥ h - BAR_H
        //   panel bottom = barPos.y + BAR_H ≤ viewportH
        //     → barPos.y ≤ viewportH - BAR_H
        // Using BAR_W for horizontal (bar and panel share width).
        const panelH = panelHeightPx();
        const yMin = Math.max(0, panelH - BAR_H);
        const yMax = Math.max(yMin, viewportH() - BAR_H);
        clamped = {
          x: Math.max(0, Math.min(viewportW() - BAR_W, next.x)),
          y: Math.max(yMin, Math.min(yMax, next.y)),
        };
      }
      if (drag.mode === "icon") setIconPos(clamped);
      else setBarPos(clamped); // bar AND panel share barPos
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const drag = dragRef.current;
      dragRef.current = null;
      setDragging(false);  // re-enable CSS transitions
      if (!drag) return;
      if (drag.moved) {
        // Persist final position. Read the freshest state via setters'
        // functional form (closures hold stale refs after async listeners).
        if (drag.mode === "icon") {
          setIconPos((p) => {
            savePos(ICON_POS_KEY, p);
            return p;
          });
        } else {
          setBarPos((p) => {
            savePos(BAR_POS_KEY, p);
            return p;
          });
        }
      } else {
        // Click (no drag): icon opens voice; bar expands to panel.
        if (drag.mode === "icon") useVoiceMode.getState().openVoice();
        else if (drag.mode === "bar") onModeChange("panel");
        // panel: no-op (click-outside handles the collapse direction)
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ── icon ───────────────────────────────────────────────────────────
  // Bare logo, no chrome — relies on drop-shadow to stay visible on bright
  // video backgrounds. Hover lift via scale-110.
  if (mode === "icon") {
    return (
      <div
        ref={containerRef}
        role="button"
        aria-label="打开 AI 助手"
        aria-expanded={false}
        title="AI 助手 · 找 YouTube 视频 / 解释字幕 / 加生词 / 同步管理库&#10;点击展开输入框 · 长按拖动移动位置"
        onMouseDown={onContainerMouseDown}
        className="fixed z-50 select-none cursor-grab active:cursor-grabbing"
        style={{
          top: iconPos.y,
          left: iconPos.x,
          width: ICON_W,
          height: ICON_H,
        }}
      >
        <img
          src={whatsubIcon}
          alt="打开 AI 助手"
          width={ICON_W}
          height={ICON_H}
          draggable={false}
          className="block h-full w-full rounded drop-shadow-lg hover:scale-110 transition-transform"
        />
        {hasUnread && (
          <span
            data-testid="agent-unread-dot"
            className="absolute top-0 right-0 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-zinc-900"
            aria-hidden="true"
          />
        )}
      </div>
    );
  }

  // ── bar / panel ────────────────────────────────────────────────────
  const expanded = mode === "panel";
  const h = expanded ? panelHeightPx() : BAR_H;
  // Panel grows UPWARD from the bar's bottom edge: align bottom = barPos.y + BAR_H.
  const realTop = expanded ? Math.max(0, barPos.y + BAR_H - h) : barPos.y;

  // During the icon → bar/panel "stretch left" animation, we render at the
  // icon's geometry on the first frame, then transition (left + top + width +
  // min-height) to the bar/panel's real geometry. Dragging suppresses the
  // transition so the bar tracks the cursor 1:1 without lag.
  //
  // CRITICAL: stretch animation uses MIN-HEIGHT, never an explicit `height`.
  // Why: if we used `height: 40` during stretch and then removed it (set
  // to undefined for bar mode), CSS can't animate height→auto cleanly —
  // WebView2 lingers at the explicit value, then snaps to a content-driven
  // value that uses the textarea's UA-default size (~45px), making the bar
  // 60+ instead of 50. Typing later triggers the textarea's useLayoutEffect
  // which finally collapses everything to the right size — the user
  // experiences this as "bar suddenly shrinks on first keystroke".
  // Using min-height instead lets us animate a real numeric→numeric value
  // (40 → 50) without ever leaving the auto-height regime.
  // Geometry resolution priority:
  //   1. stretchFrom: we're expanding FROM icon — frame-1 at iconPos, then
  //      transition to bar/panel geometry
  //   2. expanded (panel): use barPos + explicit panel height
  //   3. else (bar steady): use barPos + min-height
  const renderTop = stretchFrom ? stretchFrom.y : realTop;
  const renderLeft = stretchFrom ? stretchFrom.x : barPos.x;
  const renderWidth = stretchFrom ? stretchFrom.w : BAR_W;
  const isPanel = expanded && !stretchFrom;
  const sizingStyle: React.CSSProperties = isPanel
    ? { height: h }                                 // panel: explicit
    : { minHeight: stretchFrom?.h ?? BAR_H };       // bar / stretch: min-height

  const transitionCss = dragging
    ? "none"
    : `top ${STRETCH_MS}ms cubic-bezier(0.22, 1, 0.36, 1), left ${STRETCH_MS}ms cubic-bezier(0.22, 1, 0.36, 1), width ${STRETCH_MS}ms cubic-bezier(0.22, 1, 0.36, 1), height ${STRETCH_MS}ms cubic-bezier(0.22, 1, 0.36, 1), min-height ${STRETCH_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="AI 助手"
      aria-expanded={expanded}
      onMouseDown={onContainerMouseDown}
      className="fixed z-50 select-none flex flex-col bg-zinc-900/95 backdrop-blur-xl border border-zinc-800 rounded-lg shadow-2xl overflow-hidden cursor-grab active:cursor-grabbing"
      style={{
        top: renderTop,
        left: renderLeft,
        width: renderWidth,
        ...sizingStyle,
        transition: transitionCss,
      }}
    >
      <div className="flex flex-col h-full w-full">
        {expanded && (
          <>
            <div className="shrink-0 cursor-default">{header}</div>
            <div className="flex-1 min-h-0 overflow-y-auto cursor-default">
              {body}
            </div>
            {inlineConfirms}
          </>
        )}
        <div
          className="shrink-0 cursor-default"
          onFocusCapture={() => {
            // Clicking into the textarea (or any focusable child of inputBox)
            // is the most natural "I want to chat" gesture from the bar —
            // flip to panel so the user sees history above their cursor.
            if (mode === "bar") onModeChange("panel");
          }}
        >
          {inputBox}
        </div>
      </div>
    </div>
  );
}
