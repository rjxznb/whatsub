export interface VocabEntry {
  /** Stable dedupe key — `expression.toLowerCase().trim()`. */
  id: string;
  expression: string;
  meaningZh: string;
  usage: string;
  /** Source video this phrase was first starred from. */
  videoId: string;
  videoTitle: string;
  /** ISO timestamp. */
  addedAt: string;
  /** Time (seconds) of the first cue that contained this expression — used for
   *  deep-linking back to the moment in the video. Optional (older entries
   *  saved before this field existed will not have it). */
  cueTime?: number;
  cueText?: string;
  /** User-authored note attached to this vocab card. Stored as TipTap JSON
   *  document (serialized as a string in vocabulary.json so the schema stays
   *  free-form). Empty/undefined when the user hasn't added a note. */
  note?: string;
  /** ms timestamp of the last note edit. Used for sort + showing "上次编辑" hint. */
  noteUpdatedAt?: number;
}

export function makeVocabId(expression: string): string {
  return expression.toLowerCase().trim();
}
