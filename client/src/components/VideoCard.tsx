import type { ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { LibraryEntry } from "../types/library";

interface Props {
  entry: LibraryEntry;
  /** Currently-being-dragged item id (any type); used to suppress the click→play handler
   *  and apply the dragged state styling. */
  draggedId: string | null;
  /** Visual feedback during drag, decided by the parent. null when this card is not the active drop target. */
  dropFeedback: null | { mode: "reorder" | "merge" | "add" };
  /** Right-context-menu handler bubbled to the parent. */
  onContextMenu: (e: React.MouseEvent, entry: LibraryEntry) => void;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  /** Optional node to render as the card title. Defaults to entry.title plain text. */
  titleNode?: ReactNode;
  /** Optional node rendered below the title as the duration line. */
  durationNode?: ReactNode;
  /** Optional overlay slot used by the parent for "在后台解析" badges,
   *  vocab-attached indicators, etc. */
  badge?: ReactNode;
}

export function VideoCard({
  entry,
  draggedId,
  dropFeedback,
  onContextMenu,
  onClick,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  titleNode,
  durationNode,
  badge,
}: Props) {
  const isDragged = draggedId === entry.id;
  const ring =
    dropFeedback?.mode === "merge"
      ? "ring-2 ring-amber-400"
      : dropFeedback?.mode === "add"
      ? "ring-2 ring-amber-400 scale-105"
      : dropFeedback?.mode === "reorder"
      ? "ring-2 ring-blue-400/60"
      : "";

  return (
    <div
      draggable
      title={entry.title}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={() => {
        if (draggedId) return;
        onClick();
      }}
      onContextMenu={(e) => onContextMenu(e, entry)}
      className={
        "relative cursor-pointer group select-none rounded-md overflow-hidden bg-zinc-900 border border-zinc-800 hover:border-zinc-600 transition-transform " +
        (isDragged ? "opacity-40 " : "") +
        ring
      }
    >
      <div className="aspect-video bg-zinc-800 relative">
        {entry.thumbnailPath && (
          <img
            draggable={false}
            src={convertFileSrc(entry.thumbnailPath)}
            alt=""
            className="w-full h-full object-cover"
          />
        )}
      </div>
      <div className="p-2">
        <div className="text-sm truncate font-medium text-zinc-100">
          {titleNode ?? entry.title}
        </div>
        {durationNode && (
          <div className="mt-1 text-[10px] text-zinc-400">{durationNode}</div>
        )}
      </div>
      {dropFeedback?.mode === "reorder" && (
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-400 pointer-events-none" />
      )}
      {dropFeedback?.mode === "merge" && (
        // Explain the action — same amber as the ring border so they read as
        // one piece. pointer-events-none keeps the drag transparent through it.
        <div className="absolute inset-x-2 top-2 flex justify-center pointer-events-none">
          <div className="px-2.5 py-1 rounded-full bg-amber-400 text-zinc-900 text-[11px] font-semibold flex items-center gap-1 shadow-lg whitespace-nowrap">
            <span className="text-sm leading-none">＋</span>
            <span>合并为新文件夹</span>
          </div>
        </div>
      )}
      {badge}
    </div>
  );
}
