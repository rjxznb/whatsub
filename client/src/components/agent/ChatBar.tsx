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
import {
  useAgentPanel,
  clampNum,
  PANEL_MIN_W,
  PANEL_MAX_W,
  PANEL_MIN_H,
  PANEL_MAX_H,
  INPUT_MIN_H,
  INPUT_MAX_H,
} from "../../store/agentPanel";

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
// Drop the icon within this many px of the left/right edge to "dock" it: the
// icon hides and only a thin highlight line remains; hover pops it back out.
const DOCK_SNAP_PX = 14;
const ICON_POS_KEY = "agentIconPos";
const BAR_POS_KEY = "agentBarPos";
const ICON_DOCK_KEY = "agentIconDock";

type DockEdge = "left" | "right" | null;

function loadDock(): DockEdge {
  try {
    const v = localStorage.getItem(ICON_DOCK_KEY);
    if (v === "left" || v === "right") return v;
  } catch {
    /* ignore */
  }
  return null;
}

function saveDock(edge: DockEdge) {
  try {
    if (edge) localStorage.setItem(ICON_DOCK_KEY, edge);
    else localStorage.removeItem(ICON_DOCK_KEY);
  } catch {
    /* ignore */
  }
}

/** Which edge (if any) the icon should dock to given its resting x. */
function dockEdgeFor(x: number): DockEdge {
  if (x <= DOCK_SNAP_PX) return "left";
  if (x >= viewportW() - ICON_W - DOCK_SNAP_PX) return "right";
  return null;
}

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

  // User-adjustable panel geometry (corner resize) + input-row height (divider
  // drag). Only used in panel mode; bar/icon use their fixed sizes.
  const panelW = useAgentPanel((s) => s.width);
  const panelH = useAgentPanel((s) => s.height);
  const inputHeight = useAgentPanel((s) => s.inputHeight);
  // Disables the size CSS-transition while actively resizing so the panel
  // tracks the cursor 1:1 (same reason `dragging` disables it for moves).
  const [resizing, setResizing] = useState(false);
  // When set, the icon is collapsed to a thin highlight line at that edge;
  // hover pops it out, dragging it away undocks.
  const [dockedEdge, setDockedEdge] = useState<DockEdge>(() => loadDock());

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
      // Popovers we own (e.g. the tools list) are portaled to <body> — OUTSIDE
      // this container — so a click on them isn't `node.contains`. Treat them as
      // inside, else clicking a popover row would collapse the panel.
      if (e.target instanceof Element && e.target.closest("[data-agent-popover]"))
        return;
      // Click-outside collapses straight to the icon (the resting state);
      // "bar" is no longer an intermediate stop.
      onModeChange("icon");
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [mode, streaming, onModeChange]);

  // Drag start: only fires when mousedown lands on the container's
  // non-interactive area. Buttons + textarea + input + select +
  // [role=menu] descendants short-circuit so they behave normally.
  const onContainerMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // `[data-no-drag]` = the conversation body: mousedown there is a
    // text-selection gesture, not a panel-drag (drag the panel by its header).
    if (target.closest("button, textarea, input, select, [role=menu], [data-no-drag]"))
      return;

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
        // Panel uses its (resizable) width/height from the store.
        const yMin = Math.max(0, panelH - BAR_H);
        const yMax = Math.max(yMin, viewportH() - BAR_H);
        clamped = {
          x: Math.max(0, Math.min(viewportW() - panelW, next.x)),
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
            // Dragged to an edge → dock (collapse to a highlight line).
            const edge = dockEdgeFor(p.x);
            setDockedEdge(edge);
            saveDock(edge);
            return p;
          });
        } else {
          setBarPos((p) => {
            savePos(BAR_POS_KEY, p);
            return p;
          });
        }
      } else {
        // Click (no drag): icon/bar expand to the text panel. (Voice is its
        // own Siri-style overlay, opened with Shift+V or the panel's mic.)
        if (drag.mode === "icon" || drag.mode === "bar") onModeChange("panel");
        // panel: no-op (click-outside handles the collapse direction)
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // Resize the panel from its top-right corner. Width grows right (from
  // barPos.x), height grows up (bottom is anchored at barPos.y + BAR_H), so the
  // upper bounds keep top ≥ 0 and right ≤ viewport. stopPropagation prevents the
  // container's move-drag from also starting.
  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = panelW;
    const startH = panelH;
    setResizing(true);
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const maxW = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, viewportW() - barPos.x));
      const maxH = Math.max(PANEL_MIN_H, Math.min(PANEL_MAX_H, barPos.y + BAR_H));
      useAgentPanel
        .getState()
        .setSize(clampNum(startW + dx, PANEL_MIN_W, maxW), clampNum(startH - dy, PANEL_MIN_H, maxH));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setResizing(false);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // Resize the input row by dragging the divider: UP grows the input (and
  // shrinks the conversation body above), DOWN shrinks it. Capped so the input
  // can't crowd out the body.
  const onDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = inputHeight;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const maxH = Math.max(INPUT_MIN_H, Math.min(INPUT_MAX_H, panelH - 160));
      useAgentPanel.getState().setInputHeight(clampNum(startH - dy, INPUT_MIN_H, maxH));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // Drag/click for the DOCKED (popped-out) icon: a real drag UNdocks and moves
  // it back into the canvas; a plain click opens the panel.
  const onDockedIconMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startMouse = { x: e.clientX, y: e.clientY };
    const startX = dockedEdge === "left" ? 0 : viewportW() - ICON_W;
    const startPos = { x: startX, y: iconPos.y };
    let moved = false;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startMouse.x;
      const dy = ev.clientY - startMouse.y;
      if (
        !moved &&
        (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX)
      ) {
        moved = true;
        setDragging(true);
        setDockedEdge(null); // undock as soon as a real drag begins
        saveDock(null);
      }
      if (!moved) return;
      setIconPos(
        clampToViewport({ x: startPos.x + dx, y: startPos.y + dy }, ICON_W, ICON_H),
      );
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setDragging(false);
      if (moved) {
        setIconPos((p) => {
          savePos(ICON_POS_KEY, p);
          return p;
        });
      } else {
        onModeChange("panel");
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ── icon: docked to an edge ──────────────────────────────────────────
  // Collapsed to a thin blue highlight line; hovering pops the icon out,
  // dragging the popped icon away undocks it.
  if (mode === "icon" && dockedEdge) {
    const side = dockedEdge;
    const dockStyle: React.CSSProperties = {
      top: iconPos.y,
      width: 12,
      height: ICON_H,
    };
    if (side === "left") dockStyle.left = 0;
    else dockStyle.right = 0;
    return (
      <div
        data-agent-chatbar
        className="fixed z-50 group select-none"
        style={dockStyle}
        onMouseDown={onDockedIconMouseDown}
        role="button"
        aria-label="打开 AI 助手"
        title="AI 助手 · 悬停展开 · 拖拽拉出"
      >
        {/* highlight line — the only thing visible at rest */}
        <span
          aria-hidden
          data-testid="agent-dock-line"
          className={
            "absolute top-0 h-full w-1.5 bg-blue-500 shadow-[0_0_10px_2px_rgba(59,130,246,0.75)] " +
            "transition-opacity duration-200 group-hover:opacity-0 " +
            (side === "left" ? "left-0 rounded-r-full" : "right-0 rounded-l-full")
          }
        />
        {/* icon — hidden off the edge, slides in on hover */}
        <div
          className={
            "absolute top-0 transition-transform duration-200 ease-out " +
            "cursor-grab active:cursor-grabbing " +
            (side === "left"
              ? "left-0 -translate-x-[52px] group-hover:translate-x-0"
              : "right-0 translate-x-[52px] group-hover:translate-x-0")
          }
          style={{ width: ICON_W, height: ICON_H }}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full bg-blue-500/50 blur-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 scale-150"
          />
          <img
            src={whatsubIcon}
            alt="打开 AI 助手"
            width={ICON_W}
            height={ICON_H}
            draggable={false}
            className="relative block h-full w-full rounded drop-shadow-lg"
          />
          {hasUnread && (
            <span
              data-testid="agent-unread-dot"
              className="absolute top-0 right-0 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-zinc-900"
              aria-hidden="true"
            />
          )}
        </div>
      </div>
    );
  }

  // ── icon ───────────────────────────────────────────────────────────
  // Bare logo, no chrome — relies on drop-shadow to stay visible on bright
  // video backgrounds. Hover lift via scale-110.
  if (mode === "icon") {
    return (
      <div
        ref={containerRef}
        data-agent-chatbar
        role="button"
        aria-label="打开 AI 助手"
        aria-expanded={false}
        title="AI 助手 · 找 YouTube 视频 / 解释字幕 / 加生词 / 同步管理库&#10;点击展开输入框 · 长按拖动移动位置"
        onMouseDown={onContainerMouseDown}
        className="fixed z-50 select-none cursor-grab active:cursor-grabbing group"
        style={{
          top: iconPos.y,
          left: iconPos.x,
          width: ICON_W,
          height: ICON_H,
        }}
      >
        {/* hover halo */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full bg-blue-500/50 blur-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 scale-150"
        />
        <img
          src={whatsubIcon}
          alt="打开 AI 助手"
          width={ICON_W}
          height={ICON_H}
          draggable={false}
          className="relative block h-full w-full rounded drop-shadow-lg group-hover:scale-110 transition-transform"
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
  const h = expanded ? panelH : BAR_H;
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
  const renderWidth = stretchFrom ? stretchFrom.w : expanded ? panelW : BAR_W;
  const isPanel = expanded && !stretchFrom;
  const sizingStyle: React.CSSProperties = isPanel
    ? { height: h }                                 // panel: explicit
    : { minHeight: stretchFrom?.h ?? BAR_H };       // bar / stretch: min-height

  const transitionCss = dragging || resizing
    ? "none"
    : `top ${STRETCH_MS}ms cubic-bezier(0.22, 1, 0.36, 1), left ${STRETCH_MS}ms cubic-bezier(0.22, 1, 0.36, 1), width ${STRETCH_MS}ms cubic-bezier(0.22, 1, 0.36, 1), height ${STRETCH_MS}ms cubic-bezier(0.22, 1, 0.36, 1), min-height ${STRETCH_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;

  return (
    <div
      ref={containerRef}
      data-agent-chatbar
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
            {/* Conversation history: selectable text (overrides the panel's
                select-none) and excluded from panel-drag via data-no-drag. */}
            <div
              data-no-drag
              className="flex-1 min-h-0 overflow-y-auto cursor-auto select-text"
            >
              {body}
            </div>
            {inlineConfirms}
          </>
        )}
        <div
          className="shrink-0 cursor-default relative"
          style={expanded ? { height: inputHeight } : undefined}
          onFocusCapture={() => {
            // Clicking into the textarea (or any focusable child of inputBox)
            // is the most natural "I want to chat" gesture from the bar —
            // flip to panel so the user sees history above their cursor.
            if (mode === "bar") onModeChange("panel");
          }}
        >
          {/* Resize by dragging the input card's TOP EDGE directly (the old
              separator line was removed). Invisible at rest; a faint pill hints
              on hover. Panel only — bar mode has no resizable input height. */}
          {expanded && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="拖动上沿调整输入框高度"
              onMouseDown={onDividerMouseDown}
              className="group absolute top-0 left-0 right-0 z-10 h-2.5 flex items-center justify-center cursor-ns-resize"
            >
              <span className="h-0.5 w-8 rounded-full bg-transparent group-hover:bg-zinc-600 transition-colors" />
            </div>
          )}
          {inputBox}
        </div>
      </div>
      {/* Top-right corner handle to resize the whole panel (panel only; hidden
          during the icon→panel stretch so it doesn't flash mid-animation). */}
      {isPanel && (
        <div
          onMouseDown={onResizeMouseDown}
          title="拖动调整窗口大小"
          aria-label="调整窗口大小"
          className="group absolute top-0 right-0 h-4 w-4 z-10 flex items-start justify-end p-[3px] cursor-nesw-resize"
        >
          <span className="block h-2 w-2 rounded-tr-sm border-t-2 border-r-2 border-zinc-600 group-hover:border-zinc-400 transition-colors" />
        </div>
      )}
    </div>
  );
}
