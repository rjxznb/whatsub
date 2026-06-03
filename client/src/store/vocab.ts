import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { type VocabEntry, makeVocabId } from "../types/vocab";
import { corpusContribute, corpusDelete, CorpusContributeError } from "../lib/api/corpus";
import { tiptapToPlainText } from "../lib/tiptapText";

/** A bare 11-char id (e.g. "dQw4w9WgXcQ") looks like a YouTube video id. */
function looksLikeYouTubeId(s: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(s);
}

export interface PromoteResult {
  ok: boolean;
  reason?: string;
}

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
  /** Promote a local vocab entry to the cloud personal corpus (creates a
   *  contribution; writes cloudContributionId back locally). Idempotent. */
  promoteToCloud: (id: string) => Promise<PromoteResult>;
  /** Delete the cloud contribution for an entry; keeps the local entry. */
  unpromote: (id: string) => Promise<void>;
  /** Promote many ids (concurrency 3). Returns succeeded/failed counts. */
  promoteMany: (ids: string[]) => Promise<{ succeeded: number; failed: { id: string; reason: string }[] }>;
}

export const useVocabulary = create<VocabState>((set, get) => ({
  entries: [],
  loaded: false,
  async reload() {
    const list = await invoke<VocabEntry[]>("vocab_list");
    set({ entries: list, loaded: true });
  },
  async add(entry) {
    // Shallow-merge so plugin-written fields (source, pageUrl, videoUrl, syncStatus) survive desktop edits — spec §4.1.
    const existing = get().entries.find((e) => e.id === entry.id);
    const merged: VocabEntry = existing ? { ...existing, ...entry } : entry;
    const list = await invoke<VocabEntry[]>("vocab_add", { entry: merged });
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
  async promoteToCloud(id) {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry) return { ok: false, reason: "not_found" };
    if (entry.cloudContributionId) return { ok: true }; // already promoted

    try {
      const result = await corpusContribute({
        phraseRaw: entry.expression,
        contextSentence: entry.cueText ?? entry.expression,
        source: {
          kind: "library",
          title: entry.videoTitle,
          ...(entry.cueTime != null ? { timestampSec: entry.cueTime } : {}),
          libraryEntryId: entry.videoId,
          ...(looksLikeYouTubeId(entry.videoId) ? { youtubeId: entry.videoId } : {}),
          ...(entry.videoUrl ? { url: entry.videoUrl } : {}),
        },
        ...(entry.meaningZh ? { meaningZh: entry.meaningZh } : {}),
        ...(entry.note ? { usageNote: tiptapToPlainText(entry.note) } : {}),
      });
      await get().add({ ...entry, cloudContributionId: result.id, promotedAt: Date.now() });
      return { ok: true };
    } catch (e) {
      const reason = e instanceof CorpusContributeError ? e.reason : String(e);
      return { ok: false, reason };
    }
  },
  async unpromote(id) {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry?.cloudContributionId) return;
    try {
      await corpusDelete(entry.cloudContributionId);
    } catch {
      /* 404 / network → still clear the local link (best effort) */
    }
    await get().add({ ...entry, cloudContributionId: undefined, promotedAt: undefined });
  },
  async promoteMany(ids) {
    const failed: { id: string; reason: string }[] = [];
    let succeeded = 0;
    const queue = [...ids];
    const worker = async () => {
      for (;;) {
        const id = queue.shift();
        if (!id) return;
        const r = await get().promoteToCloud(id);
        if (r.ok) succeeded++;
        else failed.push({ id, reason: r.reason ?? "unknown" });
      }
    };
    // Concurrency 3 to avoid the backend's per-minute rate limit.
    await Promise.all([worker(), worker(), worker()]);
    return { succeeded, failed };
  },
}));
