import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { LibraryEntry } from "../types/library";

interface Props {
  /** The two videos being merged. */
  source: LibraryEntry;
  target: LibraryEntry;
  /** The on-screen rects of the source and target cards at drop time. */
  sourceRect: DOMRect;
  targetRect: DOMRect;
  /** Called when the animation has fully played (≈ 750ms). */
  onDone: () => void;
}

export function MergeAnimationLayer({
  source,
  target,
  sourceRect,
  targetRect,
  onDone,
}: Props) {
  const [phase, setPhase] = useState<"A" | "B" | "done">("A");

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("B"), 300);
    const t2 = setTimeout(() => setPhase("done"), 550);
    const t3 = setTimeout(() => onDone(), 750);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [onDone]);

  const midX = (sourceRect.left + targetRect.left + sourceRect.width) / 2;
  const midY = (sourceRect.top + targetRect.top + sourceRect.height) / 2;

  const cloneStyle = (rect: DOMRect): React.CSSProperties => ({
    position: "fixed",
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    ["--toX" as never]: `${midX - rect.left - rect.width / 2}px`,
    ["--toY" as never]: `${midY - rect.top - rect.height / 2}px`,
    animation:
      phase === "A"
        ? "mergeClonePhaseA 300ms ease-out forwards"
        : "mergeClonePhaseB 250ms ease-out forwards",
    pointerEvents: "none",
    zIndex: 40,
  });

  return (
    <div className="fixed inset-0 pointer-events-none z-40">
      {phase !== "done" && source.thumbnailPath && (
        <img
          src={convertFileSrc(source.thumbnailPath)}
          alt=""
          draggable={false}
          style={cloneStyle(sourceRect)}
        />
      )}
      {phase !== "done" && target.thumbnailPath && (
        <img
          src={convertFileSrc(target.thumbnailPath)}
          alt=""
          draggable={false}
          style={cloneStyle(targetRect)}
        />
      )}
      {phase !== "A" && (
        <div
          aria-hidden
          style={{
            position: "fixed",
            left: midX - 40,
            top: midY - 32,
            width: 80,
            height: 64,
            animation: "mergeFolderPop 450ms cubic-bezier(0.25, 0.8, 0.35, 1.2) forwards",
            zIndex: 41,
          }}
        >
          {/* macOS-blue folder shape: rounded rect + small tab. */}
          <div
            style={{
              position: "absolute",
              top: 8,
              left: 0,
              right: 0,
              bottom: 0,
              borderRadius: 8,
              background: "linear-gradient(180deg, #4aa3ff 0%, #1d6fd1 100%)",
              boxShadow: "0 6px 24px rgba(29, 111, 209, 0.45)",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 8,
              width: 28,
              height: 12,
              borderTopLeftRadius: 6,
              borderTopRightRadius: 6,
              background: "#4aa3ff",
            }}
          />
        </div>
      )}
    </div>
  );
}
