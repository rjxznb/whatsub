import { useCallback } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { exit } from "@tauri-apps/plugin-process";
import { Command } from "@tauri-apps/plugin-shell";
import { create } from "zustand";

// Tauri's updater behaves differently per platform after install completes:
//   - Windows: msiexec restarts the app for us — calling relaunch() would
//     spawn an OLD-exe instance that file-locks msiexec out of the install
//     dir, BREAKING the install. Don't relaunch.
//   - macOS:   updater just replaces the .app bundle on disk and exits the
//     install task; the running process stays on the OLD binary forever
//     unless WE relaunch.
//
// On macOS we used to call plugin-process's relaunch(), which does
// `Command::new(current_exe).spawn()` then `exit(0)`. That spawn bypasses
// Launch Services and on some user setups (Translocation, Gatekeeper, post-
// update file-handle staleness) the new process never actually appears —
// the OLD process exits or gets stuck and the user has to ⌘Q + reopen
// manually.
//
// More reliable pattern: shell out to `open -b com.whatsub.app` (which goes
// through Launch Services, the same path Finder/Dock use), then exit our
// own process. The 500ms delay before exit gives `open` a chance to register
// with LS before we go away. shell-execute scope for `open` is granted in
// capabilities/default.json.
const IS_MAC = /Mac/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "");
const APP_BUNDLE_ID = "com.whatsub.app";

export type UpdateStatus =
  | { type: "idle" }
  | { type: "checking" }
  /** A newer version is available. */
  | { type: "available"; update: Update }
  /** Confirmed up-to-date. */
  | { type: "none" }
  | { type: "downloading"; percent: number }
  | { type: "installing" }
  | { type: "error"; message: string };

/**
 * Module-level zustand store + singleton download promise. We deliberately
 * hoist this state OUT of React's per-component useState so:
 *
 *  1. UpdateChecker (mounted at App root) and Settings → share the same
 *     status. Without this they'd each have their own state and progress
 *     percent shown in one wouldn't appear in the other.
 *
 *  2. Navigating away from Settings mid-download doesn't drop the state.
 *     With useState, unmounting Settings destroyed `status`, the
 *     downloadAndInstall promise's setStatus calls then no-op'd, and
 *     re-entering Settings showed a fresh idle state — making the
 *     "更新到 vX" button reappear. Clicking it called downloadAndInstall
 *     again, which restarts the download from byte 0 because
 *     plugin-updater has no disk cache. (See CLAUDE.md "踩过的坑".)
 *
 *  3. `runningDownload` is a module-level guard so even if two callers
 *     somehow both trigger downloadAndInstall() before the status flips
 *     to "downloading", only one actually drives the plugin-updater task.
 */
interface UpdaterStore {
  status: UpdateStatus;
  set: (next: UpdateStatus | ((cur: UpdateStatus) => UpdateStatus)) => void;
}
const useUpdaterStore = create<UpdaterStore>((set) => ({
  status: { type: "idle" },
  set: (next) =>
    set((state) => ({
      status: typeof next === "function" ? (next as (c: UpdateStatus) => UpdateStatus)(state.status) : next,
    })),
}));

let runningDownload: Promise<void> | null = null;

async function runCheckNow(): Promise<void> {
  const { set } = useUpdaterStore.getState();
  // Don't clobber an in-progress download with a check.
  const cur = useUpdaterStore.getState().status;
  if (cur.type === "downloading" || cur.type === "installing") return;
  set({ type: "checking" });
  try {
    const update = await check();
    set(update ? { type: "available", update } : { type: "none" });
  } catch (e) {
    set({ type: "error", message: String(e) });
  }
}

async function runDownloadAndInstall(): Promise<void> {
  // Idempotent: a second click while one is already in flight is a
  // no-op. Without this the user could navigate away, come back, and
  // accidentally restart the download from byte 0 (plugin-updater
  // has no disk cache so each invocation re-streams the installer).
  if (runningDownload) return await runningDownload;
  const { status } = useUpdaterStore.getState();
  if (status.type === "downloading" || status.type === "installing") return;

  const { set } = useUpdaterStore.getState();
  set((cur) => (cur.type === "available" ? { type: "downloading", percent: 0 } : cur));

  runningDownload = (async () => {
    try {
      // Re-read latest because the "available" Update object we
      // stashed earlier may be stale by now. Cheap manifest re-fetch.
      const update = await check();
      if (!update) {
        set({ type: "none" });
        return;
      }
      let totalBytes = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          set({
            type: "downloading",
            percent: totalBytes > 0 ? (downloaded / totalBytes) * 100 : 0,
          });
        } else if (event.event === "Finished") {
          set({ type: "installing" });
        }
      });
      // After this returns the platform-specific installer is running:
      //   - Windows: msiexec waits for our exe to exit, replaces files, then
      //     auto-relaunches. Tauri handles the exit. We do nothing.
      //   - macOS:   the new .app bundle is now on disk but the OLD process
      //     is still in memory. We launch the new bundle via Launch Services
      //     (`open -b <bundle id>`) — the same code path Finder/Dock use,
      //     so the new instance gets a proper Dock icon, focus, and bundle
      //     context — then exit our own process after a short delay so the
      //     spawned `open` command has time to register the launch request
      //     with LS before our process disappears.
      if (IS_MAC) {
        try {
          await Command.create("open", ["-b", APP_BUNDLE_ID]).spawn();
          await new Promise((r) => setTimeout(r, 500));
          await exit(0);
        } catch (e) {
          set({
            type: "error",
            message: `更新已下载，但自动重启失败：${e}。请手动退出应用并重新打开，新版本下次启动时生效。`,
          });
        }
      }
    } catch (e) {
      set({ type: "error", message: String(e) });
    } finally {
      runningDownload = null;
    }
  })();
  await runningDownload;
}

/**
 * Wraps tauri-plugin-updater so both the auto-check banner and the
 * Settings page's manual "Check for updates" button can drive update
 * flows with the same shape. State is module-level (see above) so it
 * survives navigation and is shared between every caller.
 */
export function useUpdater() {
  const status = useUpdaterStore((s) => s.status);
  const checkNow = useCallback(() => runCheckNow(), []);
  const downloadAndInstall = useCallback(() => runDownloadAndInstall(), []);
  return { status, checkNow, downloadAndInstall };
}
