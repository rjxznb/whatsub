import { useCallback, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

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
      // Restart the app to apply the new binary.
      await relaunch();
    } catch (e) {
      setStatus({ type: "error", message: String(e) });
    }
  }, []);

  return { status, setStatus, checkNow, downloadAndInstall };
}
