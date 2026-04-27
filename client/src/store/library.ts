import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Library, LibraryEntry, LibraryStatus } from "../types/library";

interface LibraryState {
  library: Library;
  loaded: boolean;
  reload: () => Promise<void>;
  setStatus: (id: string, status: LibraryStatus, error?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
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
}));

export type { LibraryEntry, Library, LibraryStatus };
