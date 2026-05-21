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
  videoDir?: string;
  analysisStyle?: TranslationStyle;
  /** Unix ms — set when entry was last successfully uploaded to /api/library/sync.
   *  Undefined = never synced (or unsynced via the backend). v1 only YouTube
   *  sources get a value; others stay undefined. */
  syncedAt?: number;
  /** Friendly error message from the LAST sync attempt that failed.
   *  Cleared on next successful sync. Used by SyncButton to render the ✗ state. */
  syncError?: string;
}

export interface LibraryFolder {
  id: string;
  name: string;
  /** Order of videos inside this folder. */
  videoIds: string[];
  createdAt: string;
}

export type LibraryItemRef =
  | { type: "video"; id: string }
  | { type: "folder"; id: string };

export interface Library {
  videos: LibraryEntry[];
  /** Optional in backward-compat read; first save populates it. */
  folders?: LibraryFolder[];
  /** Optional in backward-compat read; first save populates it. */
  topLevelOrder?: LibraryItemRef[];
}
