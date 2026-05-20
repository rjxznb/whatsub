import { convertFileSrc } from "@tauri-apps/api/core";
import type { LibraryEntry, LibraryFolder } from "../types/library";

interface Props {
  folder: LibraryFolder;
  /** All videos in this folder (in order) — caller looks them up by folder.videoIds. */
  videos: LibraryEntry[];
  draggedId: string | null;
  dropFeedback: null | { mode: "reorder" | "merge" | "add" };
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

export function FolderCard({
  folder,
  videos,
  draggedId,
  dropFeedback,
  onClick,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: Props) {
  const isDragged = draggedId === folder.id;
  const cover = videos.slice(0, 4);

  const ring =
    dropFeedback?.mode === "add"
      ? "ring-2 ring-amber-400 scale-105"
      : dropFeedback?.mode === "reorder"
      ? "ring-2 ring-blue-400/60"
      : "";

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        if (draggedId) return;
        onClick(e);
      }}
      onContextMenu={onContextMenu}
      title={folder.name}
      className={
        "relative cursor-pointer select-none rounded-md overflow-hidden bg-zinc-900 border border-zinc-800 hover:border-zinc-600 transition-transform scale-90 " +
        (isDragged ? "opacity-40 " : "") +
        ring
      }
    >
      <div className="aspect-video grid grid-cols-2 grid-rows-2 gap-px bg-zinc-800 p-px">
        {[0, 1, 2, 3].map((i) => {
          const v = cover[i];
          return v && v.thumbnailPath ? (
            <img
              key={i}
              draggable={false}
              src={convertFileSrc(v.thumbnailPath)}
              alt=""
              className="object-cover w-full h-full"
            />
          ) : (
            <div key={i} className="bg-zinc-800" />
          );
        })}
      </div>
      <div className="p-2 flex items-center gap-2">
        <span className="truncate font-medium text-sm text-zinc-100 flex-1">
          📁 {folder.name}
        </span>
        <span className="text-zinc-500 text-xs tabular-nums">{folder.videoIds.length}</span>
      </div>
      {dropFeedback?.mode === "reorder" && (
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-400 pointer-events-none" />
      )}
    </div>
  );
}
