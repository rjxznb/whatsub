import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Library, LibraryEntry, LibraryStatus } from "../types/library";

interface LibraryState {
  library: Library;
  loaded: boolean;
  reload: () => Promise<void>;
  setStatus: (id: string, status: LibraryStatus, error?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  reorder: (orderedIds: string[]) => Promise<void>;
  reveal: (videoId: string) => Promise<void>;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  library: { videos: [] },
  loaded: false,
  async reload() {
    const lib = await invoke<Library>("library_list");
    set({ library: lib, loaded: true });
  },
  async setStatus(id, status, error) {
    await invoke("library_set_status", { id, status, error: error ?? null });
    await get().reload();
  },
  async remove(id) {
    await invoke("library_delete", { id });
    await get().reload();
  },
  async rename(id, title) {
    await invoke("library_rename", { id, title });
    // Optimistic local update so the title flips instantly without re-fetching.
    set((s) => ({
      library: {
        videos: s.library.videos.map((v) => (v.id === id ? { ...v, title } : v)),
      },
    }));
  },
  async reorder(orderedIds) {
    // Optimistic reorder; rust persists the same order to library.json.
    set((s) => {
      const byId = new Map(s.library.videos.map((v) => [v.id, v]));
      const newVideos: LibraryEntry[] = [];
      for (const id of orderedIds) {
        const e = byId.get(id);
        if (e) newVideos.push(e);
      }
      // Append any missing entries at the end (defensive).
      for (const v of s.library.videos) {
        if (!orderedIds.includes(v.id)) newVideos.push(v);
      }
      return { library: { videos: newVideos } };
    });
    await invoke("library_reorder", { orderedIds });
  },
  async reveal(videoId) {
    const path = await invoke<string>("video_source_path", { videoId });
    await invoke("reveal_in_explorer", { path });
  },
}));

export type { LibraryEntry, Library, LibraryStatus };
