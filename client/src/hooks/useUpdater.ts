import { useCallback, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { exit } from "@tauri-apps/plugin-process";
import { Command } from "@tauri-apps/plugin-shell";

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
          setStatus({
            type: "error",
            message: `更新已下载，但自动重启失败：${e}。请手动退出应用并重新打开，新版本下次启动时生效。`,
          });
        }
      }
    } catch (e) {
      setStatus({ type: "error", message: String(e) });
    }
  }, []);

  return { status, setStatus, checkNow, downloadAndInstall };
}
