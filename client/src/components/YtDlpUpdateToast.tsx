import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { useYtDlpUpdater, shouldPromptYtDlp } from "../hooks/useYtDlpUpdater";
import { useUpdater } from "../hooks/useUpdater";

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
 * Launch-time download-engine update prompt. It intentionally uses the same
 * generic presentation as an app update: the implementation detail is not
 * useful to users. A real app update always takes priority because it may
 * already contain the newer download engine.
 */
export function YtDlpUpdateToast() {
  const { status, checkNow, update } = useYtDlpUpdater();
  const { status: appUpdateStatus } = useUpdater();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => void checkNow(), 3000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (["idle", "checking", "available", "downloading", "installing"].includes(appUpdateStatus.type)) {
    return null;
  }

  if (status.type === "available" && !dismissed) {
    const info = status.info;
    if (!shouldPromptYtDlp(info, getSkipped())) return null;
    return (
      <div className="fixed bottom-4 right-4 z-[60] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 w-80">
        <div className="flex items-start gap-2">
          <Download className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-zinc-100">
              发现新版本
            </div>
            <div className="text-xs text-zinc-400 mt-1 leading-relaxed">
              建议立即更新，以获得更稳定的视频下载体验。
            </div>
          </div>
          <button onClick={() => setDismissed(true)} className="text-zinc-500 hover:text-zinc-200" title="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={() => void update()}
            className="px-3 py-1.5 bg-blue-500 text-black text-xs rounded font-medium hover:bg-blue-400"
          >
            立即更新
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
            className="accent-blue-400 h-3 w-3"
          />
          不再提醒此版本
        </label>
      </div>
    );
  }

  if (status.type === "updating") {
    return (
      <div className="fixed bottom-4 right-4 z-[60] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 w-80">
        <div className="text-sm font-medium text-zinc-100">正在下载更新...</div>
      </div>
    );
  }

  if (status.type === "done" && !dismissed) {
    return (
      <div className="fixed bottom-4 right-4 z-[60] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 w-80">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-blue-300">更新完成</div>
          <button onClick={() => setDismissed(true)} className="text-zinc-500 hover:text-zinc-200"><X className="h-4 w-4" /></button>
        </div>
      </div>
    );
  }

  return null;
}
