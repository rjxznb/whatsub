import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Global background-download queue. Tracks every import_video call
 * launched with `background: true`. The widget mounted in App.tsx
 * reads this store and renders a floating button + dropdown panel so
 * the user can see ongoing work + cancel any specific item.
 *
 * Foreground imports (which already show live inside ImportModal) are
 * deliberately excluded: pipeline-event::Started carries a `background`
 * flag from Rust, and we only enqueue entries when it's true.
 */

export type QueuePhase =
  | "started"
  | "downloading"
  | "extracting"
  | "transcribing"
  | "uploading"
  | "done"
  | "upload_failed"
  | "error";

export interface QueueItem {
  videoId: string;
  /** "url" or "local". Drives label fallback when title isn't known yet. */
  sourceKind: string;
  sourceValue: string;
  /** Human label — initially derived from the URL/filename, can be
   *  upgraded later once the library entry has a real title. */
  label: string;
  phase: QueuePhase;
  percent: number;
  speed?: string | null;
  eta?: string | null;
  total?: string | null;
  error?: string | null;
  /** Optional human-readable phase note set by the Rust pipeline. Currently
   *  used during the post-transcode upload phase to break the previously
   *  silent "正在上传到云端…" stretch into visible sub-steps (video PUT →
   *  audio extract → audio PUT). When set, DownloadQueueWidget renders this
   *  instead of the default percent-based phase text. */
  note?: string | null;
  startedAt: number;
}

interface DownloadQueueState {
  entries: Record<string, QueueItem>;
  /** Replace or upsert an entry. */
  upsert: (videoId: string, item: QueueItem) => void;
  /** Shallow-merge updates into an existing entry; no-op if missing. */
  update: (videoId: string, partial: Partial<QueueItem>) => void;
  /** Remove an entry (after completion, user-cancel, or dismiss). */
  remove: (videoId: string) => void;
  /** Cancel an active import: optimistically drops the entry and fires
   *  cancel_import on the Rust side. */
  cancel: (videoId: string) => Promise<void>;
}

export const useDownloadQueue = create<DownloadQueueState>((set, get) => ({
  entries: {},

  upsert: (videoId, item) =>
    set((state) => ({ entries: { ...state.entries, [videoId]: item } })),

  update: (videoId, partial) =>
    set((state) => {
      const cur = state.entries[videoId];
      if (!cur) return state;
      return { entries: { ...state.entries, [videoId]: { ...cur, ...partial } } };
    }),

  remove: (videoId) =>
    set((state) => {
      if (!(videoId in state.entries)) return state;
      const next = { ...state.entries };
      delete next[videoId];
      return { entries: next };
    }),

  cancel: async (videoId) => {
    get().remove(videoId);
    try {
      await invoke("cancel_import", { videoId });
    } catch (e) {
      console.warn("cancel_import (queue) failed", e);
    }
  },
}));

/** Pipeline event shape that Rust emits. Mirrors `core::progress::PipelineEvent`. */
type Started = {
  stage: "Started";
  video_id: string;
  source_kind?: string;
  source_value?: string;
  background?: boolean;
};
type Downloading = {
  stage: "Downloading";
  video_id: string;
  percent: number;
  speed?: string;
  eta?: string;
  total?: string;
};
type Extracting = { stage: "ExtractingAudio"; video_id: string };
type Transcribing = { stage: "Transcribing"; video_id: string; percent: number };
type Transcribed = {
  stage: "Transcribed";
  video_id: string;
  srt_path: string;
  duration_sec: number;
};
type Failed = { stage: "Failed"; video_id: string; error: string };
type Uploading = { stage: "Uploading"; video_id: string; percent: number; note?: string };
type PipelineEvent =
  | Started
  | Downloading
  | Extracting
  | Transcribing
  | Transcribed
  | Failed
  | Uploading
  | { stage: string; [key: string]: unknown };

/** Derive a short label from URL or filename. Cheap, called once per
 *  Started — no need for memoization. */
function deriveLabel(sourceKind: string, sourceValue: string): string {
  if (sourceKind === "url") {
    try {
      const u = new URL(sourceValue);
      const path = u.pathname.length > 1 ? u.pathname : "";
      const v = u.searchParams.get("v");
      if (v) return `${u.hostname.replace(/^www\./, "")}/watch?v=${v}`;
      return `${u.hostname.replace(/^www\./, "")}${path}`.slice(0, 60);
    } catch {
      return sourceValue.slice(0, 60);
    }
  }
  // Local file: just the basename, no path noise.
  const parts = sourceValue.split(/[\\/]/);
  return parts[parts.length - 1] || sourceValue;
}

/** Pure reducer for pipeline events → download-queue store. Exported for tests. */
export function applyPipelineEvent(ev: PipelineEvent): void {
  const store = useDownloadQueue.getState();
  switch (ev.stage) {
    case "Started": {
      const s = ev as Started;
      if (!s.background) return;
      store.upsert(s.video_id, {
        videoId: s.video_id,
        sourceKind: s.source_kind ?? "url",
        sourceValue: s.source_value ?? "",
        label: deriveLabel(s.source_kind ?? "url", s.source_value ?? ""),
        phase: "started",
        percent: 0,
        startedAt: Date.now(),
      });
      break;
    }
    case "Downloading": {
      const d = ev as Downloading;
      store.update(d.video_id, {
        phase: "downloading",
        percent: d.percent,
        speed: d.speed ?? null,
        eta: d.eta ?? null,
        total: d.total ?? null,
      });
      break;
    }
    case "ExtractingAudio": {
      const x = ev as Extracting;
      store.update(x.video_id, { phase: "extracting", percent: 0 });
      break;
    }
    case "Transcribing": {
      const t = ev as Transcribing;
      store.update(t.video_id, { phase: "transcribing", percent: t.percent });
      break;
    }
    case "Transcribed": {
      const t = ev as Transcribed;
      store.update(t.video_id, { phase: "done", percent: 100 });
      setTimeout(() => {
        useDownloadQueue.getState().remove(t.video_id);
      }, 4000);
      break;
    }
    case "Uploading": {
      // Only update a row a caller (importQueue) already upserted before
      // syncToCloud. Manual card syncs (SyncButton) don't pre-upsert and show
      // their own button spinner, so we intentionally ignore their Uploading
      // events here. A late event after the row was removed is a no-op too —
      // no stray resurrected row.
      const u = ev as Uploading;
      if (store.entries[u.video_id]) {
        store.update(u.video_id, {
          phase: "uploading",
          percent: u.percent,
          error: null,
          // u.note is undefined for transcode progress events (percent < 100);
          // pass null in that case so the previous note clears once we leave
          // a stage. The widget falls back to percent-based phaseText when
          // note is null/undefined.
          note: u.note ?? null,
        });
      }
      break;
    }
    case "Failed": {
      const f = ev as Failed;
      store.update(f.video_id, { phase: "error", error: f.error });
      break;
    }
  }
}

/** One-time global event subscription. Idempotent — called from
 *  App.tsx mount, the second call is a no-op. */
let mounted = false;
let unlisten: UnlistenFn | undefined;
export async function mountDownloadQueueListener(): Promise<void> {
  if (mounted) return;
  mounted = true;
  unlisten = await listen<PipelineEvent>("pipeline-event", (e) => {
    applyPipelineEvent(e.payload);
  });
}

export function unmountDownloadQueueListener(): void {
  unlisten?.();
  unlisten = undefined;
  mounted = false;
}
