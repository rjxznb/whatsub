// src/components/agent/ChatBar.tsx
//
// Spotlight-style bottom-center bar (UX revision 2026-05-30).
// Replaces the old ChatWidget (floating button) + ChatPanel (380x560 anchored
// layer) pattern. One component, two states (collapsed 52px / expanded 60vh).
//
// Locked behavior (see spec §6.A):
//   - Click anywhere on the bar while collapsed → expand.
//   - Click anywhere OUTSIDE the bar while expanded → collapse + abort + reject.
//   - Streaming SUPPRESSES the click-outside collapse (protects in-flight chains).
//   - Esc is NOT bound.
//
// Implementation notes:
//   - mousedown (not click) for the outside-detector so the collapse wins the
//     race against any button on the page below registering its click.
//   - InputBox renders in BOTH states (no remount on toggle — preserves text
//     being typed). Only header + body + inline confirms mount on expand.

import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  /** True while a runtime turn is mid-stream. Suppresses click-outside collapse. */
  streaming: boolean;
  /** Header rendered above body when expanded (ConversationHeader). */
  header: ReactNode;
  /** Main body — typically MessageList or EmptyState. */
  body: ReactNode;
  /** Pending MID confirm cards. */
  inlineConfirms: ReactNode;
  /** Always-visible input row. */
  inputBox: ReactNode;
}

const COLLAPSED_HEIGHT = "52px";
const EXPANDED_HEIGHT = "min(60vh, 600px)";

export function ChatBar({
  expanded,
  onExpand,
  onCollapse,
  streaming,
  header,
  body,
  inlineConfirms,
  inputBox,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Click-outside-to-collapse (suppressed during streaming).
  useEffect(() => {
    if (!expanded) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (streaming) return; // protect in-flight chain
      const node = containerRef.current;
      if (!node) return;
      if (e.target instanceof Node && node.contains(e.target)) return;
      onCollapse();
    };
    // mousedown beats click — collapse happens before any button click on the
    // page below registers, so we never get into a "click-outside-then-button-
    // fires" state.
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [expanded, streaming, onCollapse]);

  const onContainerClick = () => {
    if (!expanded) onExpand();
  };

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="AI 助手"
      aria-expanded={expanded}
      onClick={onContainerClick}
      className="fixed left-1/2 -translate-x-1/2 z-50 w-[600px] flex flex-col bg-zinc-900/95 backdrop-blur-xl border border-zinc-800 rounded-lg shadow-2xl overflow-hidden"
      style={{
        bottom: "24px",
        height: expanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT,
        transition: "height 220ms ease-out",
      }}
    >
      {expanded && (
        <>
          <div className="shrink-0">{header}</div>
          <div className="flex-1 min-h-0 overflow-y-auto">{body}</div>
          {inlineConfirms}
        </>
      )}
      <div className="shrink-0">{inputBox}</div>
    </div>
  );
}
