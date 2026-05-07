import { useCallback, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Tauri's updater behaves differently per platform after install completes:
//   - Windows: msiexec restarts the app for us — calling relaunch() would
//     spawn an OLD-exe instance that file-locks msiexec out of the install
//     dir, BREAKING the install. Don't relaunch.
//   - macOS:   updater just replaces the .app bundle on disk and exits the
//     install task; the running process stays on the OLD binary forever
//     unless WE relaunch. Without this, the user sees the "installing /
//     restart" UI but nothing ever happens.
const IS_MAC = /Mac/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "");

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
 * Wraps tauri-plugin-updater so both the auto-check banner and the
 * Settings page's manual "Check for updates" button can drive update
 * flows with the same shape.
 */
export function useUpdater() {
  const [status, setStatus] = useState<UpdateStatus>({ type: "idle" });

  const checkNow = useCallback(async () => {
    setStatus({ type: "checking" });
    try {
      const update = await check();
      if (update) {
        setStatus({ type: "available", update });
      } else {
        setStatus({ type: "none" });
      }
    } catch (e) {
      setStatus({ type: "error", message: String(e) });
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    setStatus((cur) =>
      cur.type === "available"
        ? { type: "downloading", percent: 0 }
        : cur
    );
    try {
      // Re-read latest because setStatus is async; pull from a local check call
      // would race. Instead use the current closure value.
      // (We rely on the caller to only invoke this when status.type === "available".)
      const update = await check();
      if (!update) {
        setStatus({ type: "none" });
        return;
      }
      let totalBytes = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setStatus({
            type: "downloading",
            percent: totalBytes > 0 ? (downloaded / totalBytes) * 100 : 0,
          });
        } else if (event.event === "Finished") {
          setStatus({ type: "installing" });
        }
      });
      // After this returns the platform-specific installer is running:
      //   - Windows: msiexec waits for our exe to exit, replaces files, then
      //     auto-relaunches. Tauri handles the exit. We do nothing.
      //   - macOS:   the new .app bundle is now on disk but the OLD process
      //     is still in memory. Tauri does NOT exit/relaunch automatically
      //     here despite the docs implying otherwise. We must call
      //     relaunch() ourselves, which exits this process and re-launches
      //     the app from disk (now the new version).
      if (IS_MAC) {
        try {
          await relaunch();
        } catch (e) {
          // If relaunch itself fails (rare), surface a clear "please
          // restart manually" message instead of leaving the user in a
          // permanent "installing..." state.
          setStatus({
            type: "error",
            message: `更新已下载，但自动重启失败：${e}。请手动退出应用并重新打开。`,
          });
        }
      }
    } catch (e) {
      setStatus({ type: "error", message: String(e) });
    }
  }, []);

  return { status, setStatus, checkNow, downloadAndInstall };
}
