import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { materializeFromCloud, friendlySyncError } from "../lib/api/librarySync";
import { deleteVideoAndInvalidateAnalysis } from "../llm/analysisPersistence";
import { useLibrary } from "./library";

/**
 * Tracks in-flight "下载到本地" (materialize cloud entry) operations.
 *
 * Module-level (not CloudSyncManager local state) so the "正在后台下载…"
 * indicator survives the dialog being closed + reopened — the underlying
 * Tauri command keeps running in the background regardless of the dialog, so
 * the UI must reflect that across mounts.
 */

export interface MaterializeEntry {
  id: string;
  title: string;
  sourceUrl: string;
  durationSec: number | null;
  thumbUrl: string | null;
}

interface MaterializingState {
  /** id → "downloading" | "error" (absent = idle / done). */
  status: Record<string, "downloading" | "error">;
  errors: Record<string, string>;
  /** Start (or no-op if already running) a background materialize for the
   *  given cloud entry. New flow:
   *  1. Upsert a placeholder Analyzing entry → reload library (card appears immediately)
   *  2. Run the heavy download/transcode/write step
   *  3. Reload library again (card flips to Ready) + clear status
   *  On failure: records error, removes the placeholder card so no broken card lingers. */
  run: (entry: MaterializeEntry) => Promise<void>;
}

function without<T>(obj: Record<string, T>, id: string): Record<string, T> {
  const next = { ...obj };
  delete next[id];
  return next;
}

export const useMaterializing = create<MaterializingState>((set, get) => ({
  status: {},
  errors: {},
  async run(entry) {
    const { id } = entry;
    if (get().status[id] === "downloading") return; // single-flight per id
    set((s) => ({ status: { ...s.status, [id]: "downloading" }, errors: without(s.errors, id) }));
    try {
      // Step 1: insert a placeholder Analyzing entry so the card appears immediately.
      await invoke("library_upsert_placeholder", {
        id,
        title: entry.title,
        sourceUrl: entry.sourceUrl,
        durationSec: entry.durationSec ?? 0,
        thumbUrl: entry.thumbUrl ?? null,
      });
      // Reload: the Library grid now shows the card with the "正在下载…" overlay.
      await useLibrary.getState().reload();

      // Step 2: heavy download + transcript/analysis write + flip to Ready.
      await materializeFromCloud(id);

      // Step 3: reload again (card is now a normal playable card) + clear status.
      await useLibrary.getState().reload();
      set((s) => ({ status: without(s.status, id), errors: without(s.errors, id) }));
    } catch (err) {
      // On error: show the error indicator and remove the placeholder so no
      // broken Analyzing card lingers in the library.
      set((s) => ({
        status: { ...s.status, [id]: "error" },
        errors: { ...s.errors, [id]: friendlySyncError(String(err)) },
      }));
      try {
        await deleteVideoAndInvalidateAnalysis(id);
        await useLibrary.getState().reload();
      } catch {
        // best-effort cleanup — ignore secondary errors
      }
    }
  },
}));
