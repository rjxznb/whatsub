import { create } from "zustand";
import { materializeFromCloud, friendlySyncError } from "../lib/api/librarySync";
import { useLibrary } from "./library";

/**
 * Tracks in-flight "下载到本地" (materialize cloud entry) operations.
 *
 * Module-level (not CloudSyncManager local state) so the "正在后台下载…"
 * indicator survives the dialog being closed + reopened — the underlying
 * Tauri command keeps running in the background regardless of the dialog, so
 * the UI must reflect that across mounts.
 */
interface MaterializingState {
  /** id → "downloading" | "error" (absent = idle / done). */
  status: Record<string, "downloading" | "error">;
  errors: Record<string, string>;
  /** Start (or no-op if already running) a background materialize for `id`.
   *  On success: silently reloads the library (entry just appears there — no
   *  popup, no sound). On failure: records the error for that id. */
  run: (id: string) => Promise<void>;
}

function without<T>(obj: Record<string, T>, id: string): Record<string, T> {
  const next = { ...obj };
  delete next[id];
  return next;
}

export const useMaterializing = create<MaterializingState>((set, get) => ({
  status: {},
  errors: {},
  async run(id) {
    if (get().status[id] === "downloading") return; // single-flight per id
    set((s) => ({ status: { ...s.status, [id]: "downloading" }, errors: without(s.errors, id) }));
    try {
      await materializeFromCloud(id);
      await useLibrary.getState().reload();
      // Done — drop the indicator; the entry is now in the library. No alert.
      set((s) => ({ status: without(s.status, id), errors: without(s.errors, id) }));
    } catch (err) {
      set((s) => ({
        status: { ...s.status, [id]: "error" },
        errors: { ...s.errors, [id]: friendlySyncError(String(err)) },
      }));
    }
  },
}));
