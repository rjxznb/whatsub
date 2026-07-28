import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  Library,
  LibraryEntry,
  LibraryStatus,
  LibraryItemRef,
} from "../types/library";
import { deleteVideoAndInvalidateAnalysis } from "../llm/analysisPersistence";

interface LibraryState {
  library: Library;
  loaded: boolean;
  reload: () => Promise<void>;
  setStatus: (id: string, status: LibraryStatus, error?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  /** Reorder the top-level grid. Accepts the full new ref list. */
  setTopLevelOrder: (refs: LibraryItemRef[]) => Promise<void>;
  reveal: (videoId: string) => Promise<void>;

  // Folder operations
  createFolder: (name?: string) => Promise<string>;
  deleteFolder: (folderId: string) => Promise<void>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  moveVideoToFolder: (
    videoId: string,
    targetFolderId: string | null,
    insertAt?: number
  ) => Promise<void>;
  mergeIntoFolder: (videoIds: string[], name?: string) => Promise<string>;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  library: { videos: [], folders: [], topLevelOrder: [] },
  loaded: false,
  async reload() {
    const lib = await invoke<Library>("library_list");
    // Backward compat: ensure required-shape fields exist locally even if the
    // backend didn't fill them in (older library.json without these keys).
    set({
      library: {
        videos: lib.videos ?? [],
        folders: lib.folders ?? [],
        topLevelOrder:
          lib.topLevelOrder ??
          (lib.videos ?? []).map((v) => ({ type: "video" as const, id: v.id })),
      },
      loaded: true,
    });
  },
  async setStatus(id, status, error) {
    await invoke("library_set_status", { id, status, error: error ?? null });
    await get().reload();
  },
  async remove(id) {
    await deleteVideoAndInvalidateAnalysis(id);
    await get().reload();
  },
  async rename(id, title) {
    await invoke("library_rename", { id, title });
    set((s) => ({
      library: {
        ...s.library,
        videos: s.library.videos.map((v) => (v.id === id ? { ...v, title } : v)),
      },
    }));
  },
  async setTopLevelOrder(refs) {
    set((s) => ({ library: { ...s.library, topLevelOrder: refs } }));
    await invoke("library_set_top_level_order", { refs });
  },
  async reveal(videoId) {
    const path = await invoke<string>("video_source_path", { videoId });
    await invoke("reveal_in_explorer", { path });
  },
  async createFolder(name) {
    const id = await invoke<string>("library_create_folder", { name: name ?? null });
    await get().reload();
    return id;
  },
  async deleteFolder(folderId) {
    await invoke("library_delete_folder", { folderId });
    await get().reload();
  },
  async renameFolder(folderId, name) {
    await invoke("library_rename_folder", { folderId, name });
    set((s) => ({
      library: {
        ...s.library,
        folders: (s.library.folders ?? []).map((f) =>
          f.id === folderId ? { ...f, name } : f
        ),
      },
    }));
  },
  async moveVideoToFolder(videoId, targetFolderId, insertAt) {
    await invoke("library_move_video_to_folder", {
      videoId,
      targetFolderId: targetFolderId ?? null,
      insertAt: insertAt ?? null,
    });
    await get().reload();
  },
  async mergeIntoFolder(videoIds, name) {
    const id = await invoke<string>("library_merge_into_folder", {
      videoIds,
      name: name ?? null,
    });
    await get().reload();
    return id;
  },
}));

export type { LibraryEntry, Library, LibraryStatus };
