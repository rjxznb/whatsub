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
import { Bot } from "lucide-react";

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
  /** Whichever collapsed state the current page defaults to ("icon" or "bar"). */
  pageDefaultMode: "icon" | "bar";
  header: ReactNode;
  body: ReactNode;
  inlineConfirms: ReactNode;
  inputBox: ReactNode;
}

const ICON_W = 80;
const ICON_H = 36;
const BAR_W = 600;
const BAR_H = 52;
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
    y: Math.max(0, viewportH() - ICON_H - 24),
  };
}
function defaultBarPos(): Position {
  return {
    x: Math.max(0, viewportW() / 2 - BAR_W / 2),
    y: Math.max(0, viewportH() - BAR_H - 24),
  };
}

function loadPos(key: string, fallback: () => Position): Position {
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
        return { x: p.x, y: p.y };
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
  pageDefaultMode,
  header,
  body,
  inlineConfirms,
  inputBox,
}: Props) {
  const [iconPos, setIconPos] = useState<Position>(() =>
    loadPos(ICON_POS_KEY, defaultIconPos),
  );
  const [barPos, setBarPos] = useState<Position>(() =>
    loadPos(BAR_POS_KEY, defaultBarPos),
  );
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

  // Click-outside-to-collapse (panel only, suppressed while streaming).
  // mousedown beats click — collapse wins the race against any button on the
  // page below registering its click.
  useEffect(() => {
    if (mode !== "panel") return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (streaming) return;
      const node = containerRef.current;
      if (!node) return;
      if (e.target instanceof Node && node.contains(e.target)) return;
      onModeChange(pageDefaultMode);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [mode, streaming, pageDefaultMode, onModeChange]);

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
      }
      if (!drag.moved) return;
      const next = {
        x: drag.startPos.x + dx,
        y: drag.startPos.y + dy,
      };
      const w = drag.mode === "icon" ? ICON_W : BAR_W;
      const h =
        drag.mode === "icon"
          ? ICON_H
          : drag.mode === "bar"
            ? BAR_H
            : panelHeightPx();
      const clamped = clampToViewport(next, w, h);
      if (drag.mode === "icon") setIconPos(clamped);
      else setBarPos(clamped); // bar AND panel share barPos
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const drag = dragRef.current;
      dragRef.current = null;
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
        // Click (no drag): advance the mode by one step.
        if (drag.mode === "icon") onModeChange("bar");
        else if (drag.mode === "bar") onModeChange("panel");
        // panel: no-op (click-outside handles the collapse direction)
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ── icon ───────────────────────────────────────────────────────────
  if (mode === "icon") {
    return (
      <div
        ref={containerRef}
        role="button"
        aria-label="打开 AI 助手"
        aria-expanded={false}
        onMouseDown={onContainerMouseDown}
        className="fixed z-50 select-none cursor-grab active:cursor-grabbing"
        style={{
          top: iconPos.y,
          left: iconPos.x,
          width: ICON_W,
          height: ICON_H,
        }}
      >
        <div className="relative h-full w-full bg-zinc-900/90 ring-1 ring-zinc-700 hover:ring-zinc-600 rounded-lg shadow-lg flex items-center justify-center gap-1.5 backdrop-blur-sm transition-colors">
          <Bot size={14} className="text-zinc-300" />
          <span className="text-xs text-zinc-300 font-medium">AI</span>
          {hasUnread && (
            <span
              data-testid="agent-unread-dot"
              className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-rose-500"
              aria-hidden="true"
            />
          )}
        </div>
      </div>
    );
  }

  // ── bar / panel ────────────────────────────────────────────────────
  const expanded = mode === "panel";
  const h = expanded ? panelHeightPx() : BAR_H;
  // Panel grows UPWARD from the bar's bottom edge: align bottom = barPos.y + BAR_H.
  const top = expanded ? Math.max(0, barPos.y + BAR_H - h) : barPos.y;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="AI 助手"
      aria-expanded={expanded}
      onMouseDown={onContainerMouseDown}
      className="fixed z-50 select-none flex flex-col bg-zinc-900/95 backdrop-blur-xl border border-zinc-800 rounded-lg shadow-2xl overflow-hidden cursor-grab active:cursor-grabbing"
      style={{
        top,
        left: barPos.x,
        width: BAR_W,
        height: h,
        transition: "height 220ms ease-out, top 220ms ease-out",
      }}
    >
      {expanded && (
        <>
          <div className="shrink-0 cursor-default">{header}</div>
          <div className="flex-1 min-h-0 overflow-y-auto cursor-default">
            {body}
          </div>
          {inlineConfirms}
        </>
      )}
      <div className="shrink-0 cursor-default">{inputBox}</div>
    </div>
  );
}
