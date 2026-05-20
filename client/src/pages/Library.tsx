import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useLibrary } from "../store/library";
import { useAnalysis } from "../store/analysis";
import { ImportModal } from "../components/ImportModal";
import { ImportChecklistDialog } from "../components/ImportChecklistDialog";
import {
  LibraryTour,
  type LibraryTourStep,
} from "../components/LibraryTour";
import { ContextMenu, type ContextMenuItem } from "../components/ContextMenu";
import { RenameDialog } from "../components/RenameDialog";
import { VideoCard } from "../components/VideoCard";
import { formatTime } from "../utils/time";
import {
  shouldShowImportChecklist,
  markImportChecklistShown,
} from "../utils/importChecklistGate";
import type { LibraryEntry } from "../types/library";

// 公共语料库功能仍在打磨中。flip to true when ready 公开。
// 路由 /corpus 仍然挂着,内部测试直接输地址可以访问。
// 本地开发期间手动 flip 到 true,提交前记得改回 false 再 commit。
const CORPUS_NAV_ENABLED = true;

// Phases where actual work (download / ffmpeg / whisper / LLM stream) is
// happening right now. Library card uses this to distinguish "live run"
// from "library entry stuck in analyzing because user left mid-stream".
const ACTIVE_ANALYSIS_PHASES = new Set([
  "downloading",
  "extracting",
  "transcribing",
  "analyzing",
]);

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
  // Pull these as a tuple so the component re-renders when either changes —
  // we just need to know "which video is the one currently being worked on,
  // and is it active right now?" to pick the card label.
  const activeAnalysisVideoId = useAnalysis((s) => s.videoId);
  const activeAnalysisPhase = useAnalysis((s) => s.phase);
  const [importInitial, setImportInitial] = useState<{ filePath?: string } | null>(null);
  // 仅在「点击 + Import 按钮」时拦截弹出 checklist —— 拖拽本地文件
  // 不走这里(本地文件不需要梯子/cookies)。
  const [showChecklist, setShowChecklist] = useState(false);
  // First-visit guided tour. Drives users from + Import → URL input
  // → 开始解析 button. Persisted in localStorage so it only fires once
  // per user.
  const [tourStep, setTourStep] = useState<LibraryTourStep>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem("libraryTourSeen") ? null : "import";
  });
  function dismissTour() {
    setTourStep(null);
    try {
      window.localStorage.setItem("libraryTourSeen", "1");
    } catch {
      /* localStorage unavailable — tour will re-show next session, harmless */
    }
  }
  const [search, setSearch] = useState("");
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("libraryNavCollapsed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("libraryNavCollapsed", navCollapsed ? "1" : "0");
    } catch {
      /* localStorage unavailable — collapse will reset next session, harmless */
    }
  }, [navCollapsed]);
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
          data-tour="import-button"
          onClick={() => {
            if (shouldShowImportChecklist()) {
              setShowChecklist(true);
            } else {
              setImportInitial({});
            }
          }}
          className="px-3 py-1.5 bg-blue-500 text-black text-sm rounded font-medium"
        >
          + Import
        </button>
        <button
          type="button"
          onClick={() => setNavCollapsed((v) => !v)}
          title={navCollapsed ? "展开导航" : "收起导航"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
        >
          {navCollapsed ? (
            <ChevronsLeft className="h-4 w-4" />
          ) : (
            <ChevronsRight className="h-4 w-4" />
          )}
        </button>
        <div
          className={
            "flex items-center gap-3 overflow-hidden transition-[max-width,opacity] duration-300 ease-out " +
            (navCollapsed ? "max-w-0 opacity-0" : "max-w-[400px] opacity-100")
          }
        >
          <Link
            to="/vocab"
            className="px-3 py-1.5 text-amber-300 hover:text-amber-200 text-sm whitespace-nowrap"
            title="本地词汇本（划字幕收藏的短语）"
          >
            ⭐ 词汇本
          </Link>
          {CORPUS_NAV_ENABLED && (
            <Link
              to="/corpus"
              className="px-3 py-1.5 text-amber-300 hover:text-amber-200 text-sm whitespace-nowrap"
              title="公共语料库（云端）"
            >
              📚 语料库
            </Link>
          )}
          <Link to="/settings" className="px-2 py-1.5 text-zinc-300 hover:text-zinc-100">
            ⚙
          </Link>
        </div>
      </header>

      {visible.length === 0 ? (
        <div className="text-center text-zinc-500 mt-32 text-sm">
          还没有视频。点击右上角 [+ Import] 导入第一个视频。
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 p-6">
          {visible.map((v) => {
            const isLive =
              activeAnalysisVideoId === v.id &&
              ACTIVE_ANALYSIS_PHASES.has(activeAnalysisPhase);
            return (
              <VideoCard
                key={v.id}
                entry={v}
                draggedId={draggedId}
                dropFeedback={dragOverId === v.id ? { mode: "reorder" } : null}
                onContextMenu={handleContextMenu}
                onClick={() => navigate(`/player/${v.id}`)}
                onDragStart={(e) => onDragStart(e, v.id)}
                onDragOver={(e) => onDragOver(e, v.id)}
                onDragLeave={() => onDragLeave(v.id)}
                onDrop={(e) => onDrop(e, v.id)}
                onDragEnd={onDragEnd}
                titleNode={
                  <>
                    {highlightMatch(v.title, search)}
                    {v.durationSec > 0 && (
                      <span className="ml-1 text-[10px] text-zinc-500 font-normal">
                        {formatTime(v.durationSec)}
                      </span>
                    )}
                  </>
                }
                badge={
                  <>
                    {v.status === "analyzing" && (
                      isLive ? (
                        <div className="absolute inset-0 bg-black/50 flex items-center justify-center text-blue-300 text-xs pointer-events-none">
                          解析中...
                        </div>
                      ) : (
                        <div className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center text-amber-300 text-xs gap-0.5 pointer-events-none">
                          <span>未完成解析</span>
                          <span className="text-[10px] text-zinc-300/80">
                            点击继续
                          </span>
                        </div>
                      )
                    )}
                    {v.status === "failed" && (
                      <div className="absolute top-2 right-2 bg-red-500 text-white text-xs rounded-full w-6 h-6 flex items-center justify-center pointer-events-none">
                        !
                      </div>
                    )}
                  </>
                }
              />
            );
          })}
        </div>
      )}

      {tourStep && (
        <LibraryTour
          step={tourStep}
          onAdvance={(next) => setTourStep(next)}
          onDismiss={dismissTour}
        />
      )}

      {showChecklist && (
        <ImportChecklistDialog
          onDismiss={(skipForever) => {
            // Dialog handles the cookie-login flow internally. By the
            // time we get here, either: (a) user clicked X / 继续导入,
            // (b) cookies were saved successfully. In both cases the
            // next step is to open ImportModal so they can paste a URL.
            markImportChecklistShown(skipForever);
            setShowChecklist(false);
            setImportInitial({});
          }}
        />
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
