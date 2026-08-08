import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { useYtDlpUpdater, shouldPromptYtDlp } from "../hooks/useYtDlpUpdater";

const SKIPPED_KEY = "ytdlpSkippedVersions";

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
 * Launch-time yt-dlp update prompt. Checks the GitCode manifest ~3s after
 * launch and, if a newer yt-dlp exists (and the user hasn't skipped it),
 * shows a non-blocking bottom-left toast. Explicit-consent only. Silent on
 * failure / no update. Bottom-LEFT so it never overlaps the app-updater toast.
 */
export function YtDlpUpdateToast() {
  const { status, checkNow, update } = useYtDlpUpdater();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => void checkNow(), 3000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status.type === "available" && !dismissed) {
    const info = status.info;
    if (!shouldPromptYtDlp(info, getSkipped())) return null;
    return (
      <div className="fixed bottom-4 left-4 z-[60] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 w-80">
        <div className="flex items-start gap-2">
          <Download className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-zinc-100">
              yt-dlp 有新版本 {info.latest}
            </div>
            <div className="text-xs text-zinc-400 mt-1 leading-relaxed">
              更新以保持视频下载可用。
              {info.notes && <div className="mt-1 whitespace-pre-wrap">{info.notes}</div>}
            </div>
          </div>
          <button onClick={() => setDismissed(true)} className="text-zinc-500 hover:text-zinc-200" title="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={() => void update()}
            className="px-3 py-1.5 bg-emerald-500 text-black text-xs rounded font-medium hover:bg-emerald-400"
          >
            更新
          </button>
          <button onClick={() => setDismissed(true)} className="px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100">
            稍后
          </button>
        </div>
        <label className="flex items-center gap-1.5 mt-2 text-[10px] text-zinc-500 cursor-pointer hover:text-zinc-400">
          <input
            type="checkbox"
            onChange={(e) => {
              if (e.target.checked) {
                addSkipped(info.latest);
                setDismissed(true);
              }
            }}
            className="accent-emerald-400 h-3 w-3"
          />
          不再提醒此版本
        </label>
      </div>
    );
  }

  if (status.type === "updating") {
    return (
      <div className="fixed bottom-4 left-4 z-[60] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 w-80">
        <div className="text-sm font-medium text-zinc-100">正在更新 yt-dlp…</div>
      </div>
    );
  }

  if (status.type === "done" && !dismissed) {
    return (
      <div className="fixed bottom-4 left-4 z-[60] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 w-80">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-emerald-300">yt-dlp 已更新到 {status.version}</div>
          <button onClick={() => setDismissed(true)} className="text-zinc-500 hover:text-zinc-200"><X className="h-4 w-4" /></button>
        </div>
      </div>
    );
  }

  return null;
}
