import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export interface YtDlpUpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  notes: string;
}

export type YtDlpStatus =
  | { type: "idle" }
  | { type: "checking" }
  | { type: "available"; info: YtDlpUpdateInfo }
  | { type: "none" }
  | { type: "updating" }
  | { type: "done"; version: string }
  | { type: "error"; message: string };

export function shouldPromptYtDlp(info: YtDlpUpdateInfo | null, skipped: string[]): boolean {
  return !!info && info.hasUpdate && !skipped.includes(info.latest);
}

interface Store {
  status: YtDlpStatus;
  set: (s: YtDlpStatus) => void;
}
const useStore = create<Store>((set) => ({
  status: { type: "idle" },
  set: (status) => set({ status }),
}));

let running: Promise<void> | null = null;

async function runCheck(): Promise<void> {
  const { set, status } = useStore.getState();
  if (status.type === "updating") return;
  set({ type: "checking" });
  try {
    const info = await invoke<YtDlpUpdateInfo>("yt_dlp_check_update");
    useStore.getState().set(info.hasUpdate ? { type: "available", info } : { type: "none" });
  } catch (e) {
    useStore.getState().set({ type: "error", message: String(e) });
  }
}

async function runUpdate(): Promise<void> {
  if (running) return running;
  const { status, set } = useStore.getState();
  if (status.type === "updating") return;
  set({ type: "updating" });
  running = (async () => {
    try {
      const res = await invoke<{ version: string }>("yt_dlp_update");
      useStore.getState().set({ type: "done", version: res.version });
    } catch (e) {
      useStore.getState().set({ type: "error", message: String(e) });
    } finally {
      running = null;
    }
  })();
  return running;
}

export function useYtDlpUpdater() {
  const status = useStore((s) => s.status);
  const checkNow = useCallback(() => void runCheck(), []);
  const update = useCallback(() => void runUpdate(), []);
  return { status, checkNow, update };
}
