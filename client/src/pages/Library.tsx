import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { FolderCard } from "../components/FolderCard";
import { FolderOpenView } from "../components/FolderOpenView";
import { MergeAnimationLayer } from "../components/MergeAnimationLayer";
import { overlapRatio, resolveDropMode, type DropMode } from "../utils/overlap";
import { formatTime } from "../utils/time";
import {
  shouldShowImportChecklist,
  markImportChecklistShown,
} from "../utils/importChecklistGate";
import type { LibraryEntry, LibraryFolder } from "../types/library";

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

type MenuState =
  | { type: "video"; entry: LibraryEntry; x: number; y: number }
  | { type: "folder"; folder: LibraryFolder; x: number; y: number }
  | { type: "videoInFolder"; entry: LibraryEntry; folderId: string; x: number; y: number }
  | { type: "empty"; x: number; y: number };

export function Library() {
  const navigate = useNavigate();
  const {
    library,
    reload,
    remove,
    rename,
    reveal,
    setTopLevelOrder,
    createFolder,
    deleteFolder,
    renameFolder,
    moveVideoToFolder,
    mergeIntoFolder,
  } = useLibrary();
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

  // Overlap-based drag state.
  //
  // The dragstart → first-dragover gap is too short for React's setState to
  // propagate. If we only used useState, the first dragover handler reads a
  // stale `drag === null` from its closure, returns early without calling
  // preventDefault, and the browser permanently marks the drag as "禁止"
  // (no drop target). Using a ref lets dragover read the latest value
  // synchronously the same tick dragstart writes it.
  //
  // The mirrored `dragSt` useState exists only so child cards re-render with
  // the `draggedId` prop and apply the opacity-40 styling. Visual-only.
  const dragRef = useRef<null | {
    ref: { type: "video" | "folder"; id: string };
    startRect: DOMRect;
    startClient: { x: number; y: number };
  }>(null);
  const [dragSt, setDragSt] = useState<string | null>(null);
  const dragOverRef = useRef<null | { targetId: string; mode: DropMode }>(null);
  const [dragOver, setDragOver] = useState<null | { targetId: string; mode: DropMode }>(null);

  // Folder UI state (T11 wires open animation; T10 wires merge animation)
  const [openFolder, setOpenFolder] = useState<null | { id: string; rect: DOMRect }>(null);
  const [merge, setMerge] = useState<null | {
    source: string;
    target: string;
    sourceRect: DOMRect;
    targetRect: DOMRect;
  }>(null);
  const [renamingFolder, setRenamingFolder] = useState<null | { id: string; currentName: string }>(null);

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
    setMenu({ type: "video", entry, x: e.clientX, y: e.clientY });
  }

  function handleFolderContextMenu(e: React.MouseEvent, folder: LibraryFolder) {
    e.preventDefault();
    setMenu({ type: "folder", folder, x: e.clientX, y: e.clientY });
  }

  function videoMenuItems(entry: LibraryEntry): ContextMenuItem[] {
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

  function buildMenuItemsFor(menu: MenuState): ContextMenuItem[] {
    switch (menu.type) {
      case "video":
        return videoMenuItems(menu.entry);
      case "videoInFolder":
        return [
          {
            label: "移出文件夹",
            onClick: async () => {
              try {
                await moveVideoToFolder(menu.entry.id, null);
              } catch (err) {
                console.error("move out of folder failed", err);
                await reload();
              }
            },
          },
          ...videoMenuItems(menu.entry),
        ];
      case "folder":
        return [
          {
            label: "重命名",
            onClick: () =>
              setRenamingFolder({ id: menu.folder.id, currentName: menu.folder.name }),
          },
          {
            label: "删除文件夹",
            onClick: async () => {
              try {
                await deleteFolder(menu.folder.id);
              } catch (err) {
                console.error("delete folder failed", err);
                await reload();
              }
            },
          },
        ];
      case "empty":
        return [
          {
            label: "新建文件夹",
            onClick: async () => {
              try {
                const id = await createFolder();
                setRenamingFolder({ id, currentName: "新建文件夹" });
              } catch (err) {
                console.error("create folder failed", err);
                await reload();
              }
            },
          },
        ];
    }
  }

  function onDragStart(e: React.DragEvent, ref: { type: "video" | "folder"; id: string }) {
    const card = e.currentTarget as HTMLElement;
    const startRect = card.getBoundingClientRect();
    dragRef.current = {
      ref,
      startRect,
      startClient: { x: e.clientX, y: e.clientY },
    };
    setDragSt(ref.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", `${ref.type}:${ref.id}`);
  }

  function onDragOver(
    e: React.DragEvent,
    target: { type: "video" | "folder"; id: string }
  ) {
    const drag = dragRef.current;
    if (!drag || drag.ref.id === target.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const dx = e.clientX - drag.startClient.x;
    const dy = e.clientY - drag.startClient.y;
    const dragRect = new DOMRect(
      drag.startRect.left + dx,
      drag.startRect.top + dy,
      drag.startRect.width,
      drag.startRect.height
    );
    const targetRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const overlap = overlapRatio(dragRect, targetRect);
    const mode = resolveDropMode(drag.ref.type, target.type, overlap);
    dragOverRef.current = { targetId: target.id, mode };
    setDragOver({ targetId: target.id, mode });
  }

  function onDragLeave(id: string) {
    if (dragOverRef.current?.targetId === id) dragOverRef.current = null;
    setDragOver((cur) => (cur?.targetId === id ? null : cur));
  }

  function onDragEnd() {
    dragRef.current = null;
    dragOverRef.current = null;
    setDragSt(null);
    setDragOver(null);
  }

  async function onDrop(
    e: React.DragEvent,
    target: { type: "video" | "folder"; id: string }
  ) {
    e.preventDefault();
    const drag = dragRef.current;
    const dragOverNow = dragOverRef.current;
    if (!drag || !dragOverNow || drag.ref.id === target.id) {
      dragRef.current = null;
      dragOverRef.current = null;
      setDragSt(null);
      setDragOver(null);
      return;
    }
    const { mode } = dragOverNow;
    const source = drag.ref;
    // Capture rects before clearing state (for merge animation use later).
    const sourceRect = drag.startRect;
    const targetRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragRef.current = null;
    dragOverRef.current = null;
    setDragSt(null);
    setDragOver(null);

    switch (mode) {
      case "reorder": {
        const refs = (library.topLevelOrder ?? []).filter(
          (r) => !(r.type === source.type && r.id === source.id)
        );
        const targetIdx = refs.findIndex(
          (r) => r.type === target.type && r.id === target.id
        );
        if (targetIdx === -1) return;
        const sourceRef =
          source.type === "video"
            ? { type: "video" as const, id: source.id }
            : { type: "folder" as const, id: source.id };
        const newRefs = [
          ...refs.slice(0, targetIdx),
          sourceRef,
          ...refs.slice(targetIdx),
        ];
        try {
          await setTopLevelOrder(newRefs);
        } catch (err) {
          console.error("reorder failed", err);
          await reload();
        }
        break;
      }
      case "add": {
        try {
          await moveVideoToFolder(source.id, target.id);
        } catch (err) {
          console.error("move to folder failed", err);
          await reload();
        }
        break;
      }
      case "merge": {
        setMerge({
          source: source.id,
          target: target.id,
          sourceRect,
          targetRect,
        });
        break;
      }
    }
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

      {visible.length === 0 && search.trim().length === 0 && (library.topLevelOrder ?? []).length === 0 ? (
        <div className="text-center text-zinc-500 mt-32 text-sm">
          还没有视频。点击右上角 [+ Import] 导入第一个视频。
        </div>
      ) : (
        <div
          className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 p-6"
          onContextMenu={(e) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            setMenu({ type: "empty", x: e.clientX, y: e.clientY });
          }}
        >
          {search.trim().length > 0
            ? // Search mode: flatten, ignore folder grouping.
              visible.map((v) => {
                const isLive =
                  activeAnalysisVideoId === v.id &&
                  ACTIVE_ANALYSIS_PHASES.has(activeAnalysisPhase);
                return (
                  <VideoCard
                    key={"v-" + v.id}
                    entry={v}
                    draggedId={dragSt}
                    dropFeedback={null}
                    onContextMenu={handleContextMenu}
                    onClick={() => navigate(`/player/${v.id}`)}
                    onDragStart={(e) => onDragStart(e, { type: "video", id: v.id })}
                    onDragOver={(e) => onDragOver(e, { type: "video", id: v.id })}
                    onDragLeave={() => onDragLeave(v.id)}
                    onDrop={(e) => onDrop(e, { type: "video", id: v.id })}
                    onDragEnd={onDragEnd}
                    titleNode={highlightMatch(v.title, search)}
                    durationNode={v.durationSec > 0 ? <>{formatTime(v.durationSec)}</> : undefined}
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
              })
            : (library.topLevelOrder ?? []).map((ref) => {
                if (ref.type === "video") {
                  const v = library.videos.find((x) => x.id === ref.id);
                  if (!v) return null;
                  const isLive =
                    activeAnalysisVideoId === v.id &&
                    ACTIVE_ANALYSIS_PHASES.has(activeAnalysisPhase);
                  return (
                    <VideoCard
                      key={"v-" + v.id}
                      entry={v}
                      draggedId={dragSt}
                      dropFeedback={
                        dragOver?.targetId === v.id ? { mode: dragOver.mode } : null
                      }
                      onContextMenu={handleContextMenu}
                      onClick={() => navigate(`/player/${v.id}`)}
                      onDragStart={(e) => onDragStart(e, { type: "video", id: v.id })}
                      onDragOver={(e) => onDragOver(e, { type: "video", id: v.id })}
                      onDragLeave={() => onDragLeave(v.id)}
                      onDrop={(e) => onDrop(e, { type: "video", id: v.id })}
                      onDragEnd={onDragEnd}
                      titleNode={highlightMatch(v.title, search)}
                      durationNode={v.durationSec > 0 ? <>{formatTime(v.durationSec)}</> : undefined}
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
                } else {
                  const f = (library.folders ?? []).find((x) => x.id === ref.id);
                  if (!f) return null;
                  const inside = f.videoIds
                    .map((vid) => library.videos.find((v) => v.id === vid))
                    .filter((v): v is LibraryEntry => Boolean(v));
                  return (
                    <FolderCard
                      key={"f-" + f.id}
                      folder={f}
                      videos={inside}
                      draggedId={dragSt}
                      dropFeedback={
                        dragOver?.targetId === f.id ? { mode: dragOver.mode } : null
                      }
                      onClick={(e) => {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setOpenFolder({ id: f.id, rect });
                      }}
                      onContextMenu={(e) => handleFolderContextMenu(e, f)}
                      onDragStart={(e) => onDragStart(e, { type: "folder", id: f.id })}
                      onDragOver={(e) => onDragOver(e, { type: "folder", id: f.id })}
                      onDragLeave={() => onDragLeave(f.id)}
                      onDrop={(e) => onDrop(e, { type: "folder", id: f.id })}
                      onDragEnd={onDragEnd}
                    />
                  );
                }
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

      {merge && (() => {
        const src = library.videos.find((v) => v.id === merge.source);
        const tgt = library.videos.find((v) => v.id === merge.target);
        if (!src || !tgt) return null;
        return (
          <MergeAnimationLayer
            source={src}
            target={tgt}
            sourceRect={merge.sourceRect}
            targetRect={merge.targetRect}
            onDone={async () => {
              try {
                // Order: target first, source second — target was the "base" being dropped onto.
                const folderId = await mergeIntoFolder([merge.target, merge.source]);
                setMerge(null);
                setRenamingFolder({ id: folderId, currentName: "新建文件夹" });
              } catch (err) {
                console.error("merge failed", err);
                await reload();
                setMerge(null);
              }
            }}
          />
        );
      })()}

      {openFolder && (() => {
        const f = (library.folders ?? []).find((x) => x.id === openFolder.id);
        if (!f) return null;
        const inside = f.videoIds
          .map((vid) => library.videos.find((v) => v.id === vid))
          .filter((v): v is LibraryEntry => Boolean(v));
        return (
          <FolderOpenView
            folder={f}
            videos={inside}
            originRect={openFolder.rect}
            onClose={() => setOpenFolder(null)}
            onVideoClick={(id) => {
              setOpenFolder(null);
              navigate(`/player/${id}`);
            }}
            onVideoContextMenu={(e, v) => {
              e.preventDefault();
              setMenu({ type: "videoInFolder", entry: v, folderId: f.id, x: e.clientX, y: e.clientY });
            }}
          />
        );
      })()}

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
          onClose={() => setMenu(null)}
          items={buildMenuItemsFor(menu)}
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

      {renamingFolder && (
        <RenameDialog
          title="重命名文件夹"
          initialTitle={renamingFolder.currentName}
          onConfirm={async (name) => {
            try {
              await renameFolder(renamingFolder.id, name);
            } catch (err) {
              console.error("rename folder failed", err);
              await reload();
            }
          }}
          onClose={() => setRenamingFolder(null)}
        />
      )}
    </div>
  );
}
