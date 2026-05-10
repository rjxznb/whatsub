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

// ── Change notifications ────────────────────────────────────────────────
// Components that derive UI from the draft layer (Player.tsx vocab map,
// for the dashed-underline-on-cue-list rendering) need to re-render
// when a draft is saved/cleared. localStorage doesn't fire any
// in-process events for same-tab mutations, so we maintain our own
// listener set and ping it from saveDraft/clearDraft. Subscribe via
// `subscribeDrafts` and bump a version counter in your component to
// trigger downstream re-renders / useMemo recomputes.
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeDrafts(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notifyChange(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.warn("vocabDraft listener threw", e);
    }
  }
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
  notifyChange();
}

export function clearDraft(expression: string): void {
  window.localStorage.removeItem(key(expression));
  notifyChange();
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
