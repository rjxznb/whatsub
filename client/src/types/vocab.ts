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
}

export function makeVocabId(expression: string): string {
  return expression.toLowerCase().trim();
}
