import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { type VocabEntry, makeVocabId } from "../types/vocab";

interface VocabState {
  entries: VocabEntry[];
  loaded: boolean;
  /** Pull current vocabulary.json into memory. */
  reload: () => Promise<void>;
  /** Insert or update by id. */
  add: (entry: VocabEntry) => Promise<void>;
  /** Remove by id. */
  remove: (id: string) => Promise<void>;
  /** Add if missing, remove if present. Returns the resulting saved state. */
  toggle: (entry: Omit<VocabEntry, "id" | "addedAt">) => Promise<boolean>;
  has: (expression: string) => boolean;
  /** Update / clear the note attached to a vocab entry. Pass `note=null` to
   *  remove the note (Rust treats empty string + null both as "remove"). */
  updateNote: (id: string, note: string | null) => Promise<void>;
}

export const useVocabulary = create<VocabState>((set, get) => ({
  entries: [],
  loaded: false,
  async reload() {
    const list = await invoke<VocabEntry[]>("vocab_list");
    set({ entries: list, loaded: true });
  },
  async add(entry) {
    const list = await invoke<VocabEntry[]>("vocab_add", { entry });
    set({ entries: list, loaded: true });
  },
  async remove(id) {
    const list = await invoke<VocabEntry[]>("vocab_remove", { id });
    set({ entries: list, loaded: true });
  },
  async toggle(input) {
    const id = makeVocabId(input.expression);
    if (get().entries.some((e) => e.id === id)) {
      await get().remove(id);
      return false;
    }
    const entry: VocabEntry = {
      ...input,
      id,
      addedAt: new Date().toISOString(),
    };
    await get().add(entry);
    return true;
  },
  has(expression) {
    const id = makeVocabId(expression);
    return get().entries.some((e) => e.id === id);
  },
  async updateNote(id, note) {
    const list = await invoke<VocabEntry[]>("vocab_update_note", { id, note });
    set({ entries: list });
  },
}));
