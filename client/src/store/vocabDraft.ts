import { makeVocabId } from "../types/vocab";

export interface VocabDraft {
  expression: string;
  meaningZh: string;
  usage: string;
  cueText: string;
  cueTime: number;
  videoId: string;
  videoTitle: string;
  updatedAt: string;
}

const PREFIX = "whatsub:vocab-draft:";

function key(expression: string): string {
  return PREFIX + makeVocabId(expression);
}

export function loadDraft(expression: string): VocabDraft | null {
  try {
    const raw = window.localStorage.getItem(key(expression));
    if (!raw) return null;
    return JSON.parse(raw) as VocabDraft;
  } catch {
    return null;
  }
}

export function saveDraft(draft: VocabDraft): void {
  window.localStorage.setItem(key(draft.expression), JSON.stringify(draft));
}

export function clearDraft(expression: string): void {
  window.localStorage.removeItem(key(expression));
}

/** Enumerate every draft currently in localStorage. Used by the
 *  Player to flag draft expressions in the subtitle list with a
 *  dashed underline so the user sees "you started writing notes for
 *  this word but never saved" at a glance. Returns an empty array on
 *  any storage error (private browsing, quota issues) — the dashed
 *  underline degrades gracefully to "no marking". */
export function loadAllDrafts(): VocabDraft[] {
  try {
    const drafts: VocabDraft[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      const raw = window.localStorage.getItem(k);
      if (!raw) continue;
      try {
        drafts.push(JSON.parse(raw) as VocabDraft);
      } catch {
        // Skip malformed entries silently — clearDraft() can clean
        // them up next time the user touches that word.
      }
    }
    return drafts;
  } catch {
    return [];
  }
}
