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
