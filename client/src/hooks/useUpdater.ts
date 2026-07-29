import { useCallback } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { exit } from "@tauri-apps/plugin-process";
import { Command } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
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
// More reliable pattern: spawn a tightly-scoped shell helper that waits one
// second, exit our process immediately, then let the helper invoke
// `open -b com.whatsub.app` through Launch Services. Waiting until the old
// process exits is required by the single-instance plugin.
const IS_MAC = /Mac/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "");
const APP_BUNDLE_ID = "com.whatsub.app";

/** Launch Services restart delayed until the old single-instance owner exits. */
export function macRestartCommand(): { name: string; args: string[] } {
  return {
    name: "restart-whatsub",
    args: ["-c", `sleep 1; open -b ${APP_BUNDLE_ID}`],
  };
}

export type UpdateStatus =
  | { type: "idle" }
  | { type: "checking" }
  /** A newer version is available. */
  | { type: "available"; update: Update }
  /** Confirmed up-to-date. */
  | { type: "none" }
  | { type: "downloading"; percent: number }
  | { type: "installing" }
  /** `stage` distinguishes a failed manifest check from a failed
   *  download/install — the UI used to label BOTH "检查失败", which sent users
   *  hunting for a network problem when the check had actually succeeded and
   *  it was the install that blew up. */
  | { type: "error"; message: string; stage?: "check" | "install" };

/** Reported by the Rust `update_location` command. */
interface UpdateLocationInfo {
  path: string;
  updatable: boolean;
  reason?: string | null;
}

/** macOS can't replace the .app bundle when it lives on a read-only mount.
 *  Nothing in-app can fix it — the user has to move the bundle — so the copy
 *  says exactly that instead of surfacing `os error 30`. */
const READ_ONLY_HELP =
  "无法自动更新：whatsub 正在从只读位置运行。请退出应用，把 whatsub 拖到「应用程序」文件夹，" +
  "从那里重新打开后再更新。";

const REASON_HELP: Record<string, string> = {
  dmg:
    "无法自动更新：whatsub 正在从磁盘映像(.dmg)里直接运行，磁盘映像是只读的。" +
    "请把 whatsub 拖到「应用程序」文件夹，弹出磁盘映像，从「应用程序」里打开后再更新。",
  translocated:
    "无法自动更新：macOS 的安全隔离(App Translocation)正在只读副本中运行 whatsub。" +
    "请退出应用，把 whatsub 拖到「应用程序」文件夹，从那里重新打开后再更新。",
  unwritable: READ_ONLY_HELP,
};

/** True when an install error is the read-only-filesystem failure. Matches the
 *  errno text Tauri surfaces (`os error 30` = EROFS) as well as the plain
 *  English phrasing, so a message-format change upstream can't silently turn
 *  this back into an opaque error. */
export function isReadOnlyFsError(msg: string): boolean {
  return /os error 30\b/i.test(msg) || /read-only file system/i.test(msg);
}

/** Actionable copy for a blocked update location, or null when it's fine. */
export function blockedMessage(info: UpdateLocationInfo | null): string | null {
  if (!info || info.updatable) return null;
  return REASON_HELP[info.reason ?? ""] ?? READ_ONLY_HELP;
}

async function readUpdateLocation(): Promise<UpdateLocationInfo | null> {
  try {
    return await invoke<UpdateLocationInfo>("update_location");
  } catch {
    // Older binary / command unavailable — fail open and let the install
    // attempt surface its own error.
    return null;
  }
}

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
    set({ type: "error", message: String(e), stage: "check" });
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
      // Pre-flight the install location BEFORE downloading. macOS replaces the
      // .app bundle in place, so a read-only mount (running from the .dmg, or
      // Gatekeeper's App Translocation) makes the install impossible — and it
      // only failed AFTER streaming ~270 MB, then showed a bare
      // "Read-only file system (os error 30)". Check first, say what to do,
      // and don't waste the download.
      const blocked = blockedMessage(await readUpdateLocation());
      if (blocked) {
        set({ type: "error", message: blocked, stage: "install" });
        return;
      }
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
      //   - macOS: the new .app bundle is on disk but this old process still
      //     owns the single-instance registration. Spawn a fixed shell helper,
      //     exit now, and let the helper reopen the bundle one second later.
      if (IS_MAC) {
        try {
          const restart = macRestartCommand();
          await Command.create(restart.name, restart.args).spawn();
          await exit(0);
        } catch (e) {
          set({
            type: "error",
            message: `更新已下载，但自动重启失败：${e}。请手动退出应用并重新打开，新版本下次启动时生效。`,
            stage: "install",
          });
        }
      }
    } catch (e) {
      // A read-only bundle can also fail here (e.g. the pre-flight passed but
      // /Applications itself isn't writable). Translate the errno into the
      // same actionable copy rather than leaking "os error 30".
      const raw = String(e);
      set({
        type: "error",
        message: isReadOnlyFsError(raw) ? READ_ONLY_HELP : raw,
        stage: "install",
      });
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
