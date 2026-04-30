import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useLibrary } from "../store/library";
import { ImportModal } from "../components/ImportModal";
import { ContextMenu, type ContextMenuItem } from "../components/ContextMenu";
import { RenameDialog } from "../components/RenameDialog";
import { formatTime } from "../utils/time";
import type { LibraryEntry } from "../types/library";

const VIDEO_EXT_RE = /\.(mp4|mkv|mov|webm|avi|m4v)$/i;

/**
 * Wrap every case-insensitive occurrence of `query` in `text` with a yellow span,
 * preserving the original casing of the matched substring.
 */
function highlightMatch(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = q.toLowerCase();
  const segments: ReactNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lowerText.indexOf(lowerQuery, cursor);
    if (idx === -1) {
      segments.push(text.slice(cursor));
      break;
    }
    if (idx > cursor) segments.push(text.slice(cursor, idx));
    segments.push(
      <mark
        key={idx}
        className="bg-yellow-300 text-black px-0.5 rounded-sm"
      >
        {text.slice(idx, idx + q.length)}
      </mark>
    );
    cursor = idx + q.length;
  }
  return segments;
}

interface MenuState {
  x: number;
  y: number;
  entry: LibraryEntry;
}

export function Library() {
  const navigate = useNavigate();
  const { library, reload, remove, rename, reorder, reveal } = useLibrary();
  const [importInitial, setImportInitial] = useState<{ filePath?: string } | null>(null);
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<LibraryEntry | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [fileHover, setFileHover] = useState(false);

  useEffect(() => {
    reload();
  }, [reload]);

  // Listen for files dragged from the OS onto the window. Tauri 2 emits a single
  // event stream covering enter/over/drop/leave with absolute paths.
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    win
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter") {
          // Highlight only when the drag includes at least one video file.
          const hasVideo = p.paths.some((path: string) => VIDEO_EXT_RE.test(path));
          setFileHover(hasVideo);
        } else if (p.type === "leave") {
          setFileHover(false);
        } else if (p.type === "drop") {
          setFileHover(false);
          const videoPath = p.paths.find((path: string) => VIDEO_EXT_RE.test(path));
          if (videoPath) {
            setImportInitial({ filePath: videoPath });
          }
        }
        // "over" fires repeatedly while dragging over the window; we already set
        // hover state on "enter" so nothing to do here.
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const visible = library.videos.filter((v) =>
    v.title.toLowerCase().includes(search.toLowerCase())
  );

  function handleContextMenu(e: React.MouseEvent, entry: LibraryEntry) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  }

  function buildMenuItems(entry: LibraryEntry): ContextMenuItem[] {
    return [
      { label: "重命名", onClick: () => setRenaming(entry) },
      {
        label: "在文件夹中显示",
        onClick: () => {
          reveal(entry.id).catch((e) => alert(`打开文件夹失败：${e}`));
        },
      },
      {
        label: "删除",
        danger: true,
        onClick: () => {
          if (confirm(`确定删除「${entry.title}」？\n这会同时删除视频文件和分析结果，不可恢复。`)) {
            remove(entry.id).catch((e) => alert(`删除失败：${e}`));
          }
        },
      },
    ];
  }

  function onDragStart(e: React.DragEvent, id: string) {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = "move";
    // Set a payload so the drop event fires.
    e.dataTransfer.setData("text/plain", id);
  }

  function onDragOver(e: React.DragEvent, id: string) {
    if (!draggedId || draggedId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverId(id);
  }

  function onDragLeave(id: string) {
    setDragOverId((cur) => (cur === id ? null : cur));
  }

  function onDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    const sourceId = draggedId;
    setDraggedId(null);
    setDragOverId(null);
    if (!sourceId || sourceId === targetId) return;

    // Build new order: remove source, insert before target.
    const ids = library.videos.map((v) => v.id);
    const filtered = ids.filter((id) => id !== sourceId);
    const targetIdx = filtered.indexOf(targetId);
    if (targetIdx === -1) return;
    const newOrder = [
      ...filtered.slice(0, targetIdx),
      sourceId,
      ...filtered.slice(targetIdx),
    ];
    reorder(newOrder).catch((e) => {
      console.error("reorder failed", e);
      reload();
    });
  }

  function onDragEnd() {
    setDraggedId(null);
    setDragOverId(null);
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 px-6 py-3 border-b border-zinc-800">
        <h1 className="text-lg font-semibold flex-1">Library</h1>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索..."
          className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-sm w-64"
        />
        <button
          onClick={() => setImportInitial({})}
          className="px-3 py-1.5 bg-blue-500 text-black text-sm rounded font-medium"
        >
          + Import
        </button>
        <Link
          to="/vocab"
          className="px-3 py-1.5 text-amber-300 hover:text-amber-200 text-sm"
          title="我的词汇本"
        >
          ⭐ 词汇本
        </Link>
        <Link to="/settings" className="px-2 py-1.5 text-zinc-300 hover:text-zinc-100">
          ⚙
        </Link>
      </header>

      {visible.length === 0 ? (
        <div className="text-center text-zinc-500 mt-32 text-sm">
          还没有视频。点击右上角 [+ Import] 导入第一个视频。
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 p-6">
          {visible.map((v) => {
            const isDragged = draggedId === v.id;
            const isDragOver = dragOverId === v.id;
            return (
              <div
                key={v.id}
                draggable
                title={v.title}
                onDragStart={(e) => onDragStart(e, v.id)}
                onDragOver={(e) => onDragOver(e, v.id)}
                onDragLeave={() => onDragLeave(v.id)}
                onDrop={(e) => onDrop(e, v.id)}
                onDragEnd={onDragEnd}
                onClick={() => {
                  if (!draggedId) navigate(`/player/${v.id}`);
                }}
                onContextMenu={(e) => handleContextMenu(e, v)}
                className={
                  "bg-zinc-900 border rounded-md overflow-hidden cursor-pointer select-none transition " +
                  (isDragged
                    ? "opacity-40 border-zinc-700"
                    : isDragOver
                    ? "border-blue-400 ring-2 ring-blue-400/30"
                    : "border-zinc-800 hover:border-zinc-600")
                }
              >
                <div className="aspect-video bg-zinc-800 relative pointer-events-none">
                  {v.thumbnailPath && (
                    <img
                      src={convertFileSrc(v.thumbnailPath)}
                      className="w-full h-full object-cover"
                      draggable={false}
                    />
                  )}
                  {v.status === "analyzing" && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center text-blue-300 text-xs">
                      解析中...
                    </div>
                  )}
                  {v.status === "failed" && (
                    <div className="absolute top-2 right-2 bg-red-500 text-white text-xs rounded-full w-6 h-6 flex items-center justify-center">
                      !
                    </div>
                  )}
                </div>
                <div className="p-3 pointer-events-none">
                  <div className="text-sm font-medium truncate">
                    {highlightMatch(v.title, search)}
                  </div>
                  {v.durationSec > 0 && (
                    <div className="mt-1 text-[10px] text-zinc-500">
                      {formatTime(v.durationSec)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {importInitial && (
        <ImportModal
          initialFilePath={importInitial.filePath}
          onClose={() => setImportInitial(null)}
        />
      )}

      {fileHover && (
        <div className="fixed inset-0 bg-blue-500/10 border-4 border-dashed border-blue-400 rounded-lg flex items-center justify-center z-40 pointer-events-none">
          <div className="bg-zinc-900 border border-blue-400 rounded-lg px-6 py-4 shadow-xl">
            <div className="text-blue-300 font-semibold text-lg">松开以导入视频</div>
            <div className="text-zinc-400 text-xs mt-1">
              将自动跳转到「导入视频」对话框
            </div>
          </div>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}

      {renaming && (
        <RenameDialog
          initialTitle={renaming.title}
          onConfirm={(newTitle) => {
            rename(renaming.id, newTitle).catch((e) => alert(`重命名失败：${e}`));
          }}
          onClose={() => setRenaming(null)}
        />
      )}
    </div>
  );
}
