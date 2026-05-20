import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { LibraryEntry, LibraryFolder } from "../types/library";

interface Props {
  folder: LibraryFolder;
  videos: LibraryEntry[];
  /** Original card rect for the open/close animation source. */
  originRect: DOMRect;
  onClose: () => void;
  onVideoClick: (videoId: string) => void;
  onVideoContextMenu: (e: React.MouseEvent, video: LibraryEntry) => void;
}

export function FolderOpenView({
  folder,
  videos,
  originRect,
  onClose,
  onVideoClick,
  onVideoContextMenu,
}: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Trigger transition on next frame so the start state renders first.
    const r = requestAnimationFrame(() => setOpen(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(r);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const targetW = Math.min(window.innerWidth * 0.8, 1100);
  const targetH = Math.min(window.innerHeight * 0.75, 700);
  const targetLeft = (window.innerWidth - targetW) / 2;
  const targetTop = (window.innerHeight - targetH) / 2;

  const cardStyle: React.CSSProperties = open
    ? {
        position: "fixed",
        left: targetLeft,
        top: targetTop,
        width: targetW,
        height: targetH,
        transition: "all 300ms ease-out",
      }
    : {
        position: "fixed",
        left: originRect.left,
        top: originRect.top,
        width: originRect.width,
        height: originRect.height,
        transition: "all 300ms ease-out",
      };

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-md transition-opacity duration-200"
        style={{ opacity: open ? 1 : 0 }}
        onClick={onClose}
      />
      <div
        style={cardStyle}
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800">
          <span className="text-base font-semibold flex-1">📁 {folder.name}</span>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-100 transition-colors w-7 h-7 rounded flex items-center justify-center"
            title="关闭"
          >
            ✕
          </button>
        </div>
        <div
          className="flex-1 overflow-y-auto p-5 grid grid-cols-2 md:grid-cols-3 gap-4 auto-rows-min content-start"
          style={{
            opacity: open ? 1 : 0,
            transition: "opacity 200ms ease-out 150ms",
          }}
        >
          {videos.length === 0 ? (
            <div className="col-span-full text-center text-zinc-500 py-12">空文件夹</div>
          ) : (
            videos.map((v) => (
              <div
                key={v.id}
                className="cursor-pointer rounded overflow-hidden bg-zinc-800 border border-zinc-700 hover:border-zinc-600 transition-colors"
                onClick={() => onVideoClick(v.id)}
                onContextMenu={(e) => onVideoContextMenu(e, v)}
              >
                {v.thumbnailPath && (
                  <img
                    draggable={false}
                    src={convertFileSrc(v.thumbnailPath)}
                    alt=""
                    className="w-full aspect-video object-cover"
                  />
                )}
                <div className="p-2 text-xs truncate">{v.title}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
