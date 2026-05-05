import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { WhisperModelSize } from "../types/settings";

// Global whisper-model download manager. The Rust task runs in Tauri's
// tokio runtime independent of any React component, but if the download
// state lives in a component's `useState`, navigating away from that
// component (e.g. Settings → Library) drops the listener and the user
// stops seeing live progress — even though bytes are still streaming
// to disk. Hoisting the state into a Zustand store fixes this:
//
//   - The invoke() promise is awaited inside the store action, which
//     outlives any single component render
//   - The `pipeline-event` listener is set up once on first use and
//     stays live for the entire app session
//   - Any page that wants to render progress just subscribes to the
//     store; navigating away/back is a no-op
//
// Resume / pause semantics match the previous component-local impl:
// pause() flips a Tauri-managed AtomicBool that the Rust loop checks
// per chunk, leaving a `.partial` file on disk that resumes via
// HTTP Range header on the next start().

type Phase = "idle" | "downloading" | "paused";

interface ModelDownloadState {
  phase: Phase;
  /** Tier currently being downloaded or paused mid-download. Null only
   *  while phase is "idle". */
  activeSize: WhisperModelSize | null;
  /** 0–100 percent. Updated by the global pipeline-event listener as
   *  Rust streams bytes into `.partial`. */
  pct: number;
  /** Last hard-error message (non-cancellation). Cleared on each
   *  successful start() call. */
  error: string | null;
  start: (size: WhisperModelSize) => Promise<void>;
  pause: () => Promise<void>;
}

let unlisten: UnlistenFn | null = null;

async function ensureListener(
  set: (partial: Partial<ModelDownloadState>) => void
): Promise<void> {
  if (unlisten) return;
  unlisten = await listen<{ stage: string; progress?: number }>(
    "pipeline-event",
    (e) => {
      if (
        e.payload.stage === "ModelDownload" &&
        typeof e.payload.progress === "number"
      ) {
        set({ pct: e.payload.progress });
      }
    }
  );
}

export const useModelDownload = create<ModelDownloadState>((set) => ({
  phase: "idle",
  activeSize: null,
  pct: 0,
  error: null,
  start: async (size) => {
    await ensureListener((p) => set(p));
    set({ phase: "downloading", activeSize: size, pct: 0, error: null });
    try {
      await invoke("whisper_model_download", { size });
      // Successful completion. Don't clear activeSize — the consumer
      // can read it to know which tier just finished, and the next
      // start() will overwrite it.
      set({ phase: "idle", pct: 100 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Rust returns AppError::Other("cancelled") on user-initiated pause.
      // Treat as a paused state so the UI can offer "继续" instead of a
      // hard error.
      if (msg.toLowerCase().includes("cancelled")) {
        set({ phase: "paused" });
      } else {
        set({ phase: "idle", error: msg });
      }
    }
  },
  pause: async () => {
    await invoke("whisper_model_download_cancel");
    // start()'s in-flight invoke rejects shortly after with
    // "cancelled" — its catch flips phase to "paused".
  },
}));
