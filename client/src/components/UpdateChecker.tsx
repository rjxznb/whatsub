import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { useUpdater } from "../hooks/useUpdater";

const SKIPPED_KEY = "skippedUpdateVersions";

function getSkipped(): string[] {
  try {
    const raw = localStorage.getItem(SKIPPED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
function addSkipped(version: string) {
  const list = getSkipped();
  if (!list.includes(version)) {
    list.push(version);
    localStorage.setItem(SKIPPED_KEY, JSON.stringify(list));
  }
}

/**
 * Auto-checks for updates once on app launch and surfaces a non-blocking
 * toast in the bottom-right corner if one is found. The toast respects the
 * user's "skip this version" choice (persisted in localStorage), and does
 * not repeat for that version on subsequent launches.
 *
 * Failures (network, missing endpoint) are silently swallowed — the user
 * can still trigger a manual check from Settings.
 */
export function UpdateChecker() {
  const { status, checkNow, downloadAndInstall } = useUpdater();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Slight delay to avoid contending with the initial app load; also so
    // the user sees the home page before any toast appears.
    const t = setTimeout(() => {
      void checkNow();
    }, 3000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status.type === "available" && !dismissed) {
    const ver = status.update.version;
    if (getSkipped().includes(ver)) return null;
    return (
      <div className="fixed bottom-4 right-4 z-[60] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 w-80">
        <div className="flex items-start gap-2">
          <Download className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-zinc-100">
              发现新版本 v{ver}
            </div>
            {status.update.body && (
              <div className="text-xs text-zinc-400 mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                {status.update.body}
              </div>
            )}
          </div>
          <button
            onClick={() => setDismissed(true)}
            className="text-zinc-500 hover:text-zinc-200"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={() => void downloadAndInstall()}
            className="px-3 py-1.5 bg-blue-500 text-black text-xs rounded font-medium hover:bg-blue-400"
          >
            立即更新
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100"
          >
            稍后
          </button>
        </div>
        <label className="flex items-center gap-1.5 mt-2 text-[10px] text-zinc-500 cursor-pointer hover:text-zinc-400">
          <input
            type="checkbox"
            onChange={(e) => {
              if (e.target.checked) {
                addSkipped(ver);
                setDismissed(true);
              }
            }}
            className="accent-blue-400 h-3 w-3"
          />
          不再提醒此版本
        </label>
      </div>
    );
  }

  if (status.type === "downloading") {
    return (
      <div className="fixed bottom-4 right-4 z-[60] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 w-80">
        <div className="text-sm font-medium text-zinc-100">正在下载更新...</div>
        <div className="mt-2 h-1.5 bg-zinc-800 rounded overflow-hidden">
          <div
            className="h-full bg-blue-400 transition-all"
            style={{ width: `${status.percent}%` }}
          />
        </div>
        <div className="text-[10px] text-zinc-500 mt-1 tabular-nums">
          {status.percent.toFixed(0)}%
        </div>
      </div>
    );
  }

  if (status.type === "installing") {
    return (
      <div className="fixed bottom-4 right-4 z-[60] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 w-80">
        <div className="text-sm font-medium text-zinc-100">
          下载完成，正在安装并重启...
        </div>
      </div>
    );
  }

  return null;
}
