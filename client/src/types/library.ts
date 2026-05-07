import type { TranslationStyle } from "./settings";

export type LibrarySource =
  | { type: "local"; originalPath: string }
  | { type: "url"; url: string };

export type LibraryStatus = "analyzing" | "ready" | "failed";

export interface LibraryEntry {
  id: string;
  title: string;
  source: LibrarySource;
  durationSec: number;
  thumbnailPath: string;
  createdAt: string;
  status: LibraryStatus;
  lastError: string | null;
  /** Absolute path to the dir holding source.mp4 / transcript.srt / analysis.json.
   *  Frozen at import time. Optional for entries created before this field existed. */
  videoDir?: string;
  /** Translation style chosen at import time. Drives the system prompt for
   *  this entry's analysis. Optional for legacy entries — Player falls back
   *  to settings.translationStyle then to "colloquial". */
  analysisStyle?: TranslationStyle;
}

export interface Library {
  videos: LibraryEntry[];
}
