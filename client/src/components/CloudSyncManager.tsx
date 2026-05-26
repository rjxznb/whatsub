import { useEffect, useState, useCallback } from "react";
import { X, Trash2, Cloud, Download } from "lucide-react";
import { listSynced, unsyncFromCloud, friendlySyncError, type CloudLibraryEntry } from "../lib/api/librarySync";
import { libraryQuota, type Quota } from "../lib/api/quota";
import { useLibrary } from "../store/library";
import { useMaterializing } from "../store/materializing";
import { confirm, message } from "@tauri-apps/plugin-dialog";

interface Props {
  /** Called when user closes the dialog (Esc, backdrop click, X button, 关闭). */
  onClose: () => void;
  /** Called after any successful unsync so the parent (Library page) can refresh
   *  its local library state (sync badges may need to clear). */
  onChanged: () => void | Promise<void>;
}

export function CloudSyncManager({ onClose, onChanged }: Props) {
  const [entries, setEntries] = useState<CloudLibraryEntry[] | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  // Materialize state lives in a module-level store so the "正在后台下载…"
  // indicator persists across this dialog being closed + reopened.
  const materializeStatus = useMaterializing((s) => s.status);
  const materializeErrors = useMaterializing((s) => s.errors);
  const localLibrary = useLibrary((s) => s.library);

  const reload = useCallback(async () => {
    setEntries(null);
    setError(null);
    try {
      setEntries(await listSynced());
    } catch (err) {
      setError(friendlySyncError(String(err)));
    }
  }, []);

  // Server-authoritative cloud-video quota (used/limit). Best-effort — a failure
  // just leaves the badge hidden; it never blocks the entry list.
  const loadQuota = useCallback(async () => {
    try {
      setQuota(await libraryQuota());
    } catch {
      /* keep prior value / stay hidden */
    }
  }, []);

  useEffect(() => {
    void reload();
    void loadQuota();
  }, [reload, loadQuota]);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function unsync(id: string, title: string) {
    if (!(await confirm(`从云端下架「${title}」？\niOS 上将不再可见。本地条目不会被删。`))) return;
    setBusyIds(prev => new Set(prev).add(id));
    try {
      await unsyncFromCloud(id);
      setEntries(prev => prev?.filter(e => e.id !== id) ?? null);
      await onChanged();
      void loadQuota();
    } catch (err) {
      await message(friendlySyncError(String(err)));
    } finally {
      setBusyIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function materialize(e: CloudLibraryEntry) {
    // Fire-and-forget into the module-level store: it keeps running (and the
    // "正在后台下载…" indicator persists) even if this dialog is closed. On
    // success it silently reloads the library — no popup, no alert sound.
    void useMaterializing.getState().run({
      id: e.id,
      title: e.title,
      sourceUrl: e.sourceUrl,
      durationSec: e.durationSec,
      thumbUrl: e.thumbUrl,
    });
  }

  async function unsyncAll() {
    if (!entries?.length) return;
    if (!(await confirm(`从云端下架全部 ${entries.length} 条？\n本地条目不会被删。`))) return;
    // Sequential — fast enough for typical sizes (< 100 entries) and gives
    // partial-progress feedback if one fails.
    for (const e of entries) {
      try {
        await unsyncFromCloud(e.id);
      } catch (err) {
        console.warn(`unsync ${e.id} failed:`, err);
      }
    }
    await reload();
    await onChanged();
    void loadQuota();
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[92vw] max-h-[80vh] flex flex-col rounded-2xl bg-zinc-900 border border-white/10 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Cloud className="h-5 w-5 text-emerald-400" />
            <h2 className="text-base font-semibold text-white">云同步详情</h2>
            {entries && <span className="text-xs text-zinc-500">· {entries.length} 条</span>}
            {quota && (
              <span
                className={`text-xs px-1.5 py-0.5 rounded border ${
                  quota.used >= quota.limit
                    ? "text-amber-300 bg-amber-400/10 border-amber-400/40"
                    : "text-zinc-400 bg-zinc-800 border-white/10"
                }`}
                title="云端视频额度（订阅 50 / 免费 3）"
              >
                配额 {quota.used}/{quota.limit}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white" aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-3 min-h-[120px]">
          {entries === null && !error && (
            <div className="text-zinc-400 text-sm">加载中…</div>
          )}
          {error && (
            <div className="text-rose-400 text-sm bg-rose-500/10 rounded p-3">
              加载失败：{error}
              <button onClick={reload} className="ml-2 underline">重试</button>
            </div>
          )}
          {entries?.length === 0 && (
            <div className="text-zinc-500 text-sm py-12 text-center">
              还没同步过任何条目。
              <br />
              <span className="text-xs">在 Library 卡片上点 ☁️ 同步 YouTube 视频。</span>
            </div>
          )}
          {entries?.map(e => {
            const isLocal = localLibrary.videos.some(v => v.id === e.id);
            const isMaterializing = materializeStatus[e.id] === "downloading";
            const matError = materializeErrors[e.id];
            return (
              <div
                key={e.id}
                className="flex items-center gap-3 rounded-lg bg-zinc-800/60 hover:bg-zinc-800 p-3 transition-colors"
              >
                {e.thumbUrl ? (
                  <img
                    src={e.thumbUrl}
                    alt=""
                    className="h-12 w-20 rounded object-cover bg-zinc-700 flex-shrink-0"
                  />
                ) : (
                  <div className="h-12 w-20 rounded bg-zinc-700 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm text-white" title={e.title}>{e.title}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    同步于 {new Date(e.syncedAt).toLocaleString()}
                  </div>
                  {matError && (
                    <div className="text-xs text-rose-400 mt-0.5" title={matError}>
                      下载失败：{matError}
                    </div>
                  )}
                </div>
                {!isLocal && (
                  <button
                    onClick={() => materialize(e)}
                    disabled={isMaterializing || busyIds.has(e.id)}
                    className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 disabled:opacity-40 px-2 py-1.5 rounded flex-shrink-0 transition-colors"
                    title="下载到本地（视频+字幕+分析）"
                    aria-label={`下载到本地 ${e.title}`}
                  >
                    {isMaterializing ? (
                      <span className="animate-spin">⟳</span>
                    ) : (
                      <Download size={14} />
                    )}
                    <span>{isMaterializing ? "正在后台下载…" : "下载到本地"}</span>
                  </button>
                )}
                {isLocal && (
                  <span className="text-xs text-emerald-500 px-2 flex-shrink-0">已在本地</span>
                )}
                <button
                  onClick={() => unsync(e.id, e.title)}
                  disabled={busyIds.has(e.id) || isMaterializing}
                  className="grid place-items-center h-8 w-8 rounded text-rose-400 hover:bg-rose-500/15 disabled:opacity-40 flex-shrink-0"
                  title="从云下架"
                  aria-label={`从云下架 ${e.title}`}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}
        </div>

        {entries && entries.length > 0 && (
          <footer className="px-5 py-3 border-t border-white/10 flex justify-between items-center">
            <button
              onClick={unsyncAll}
              className="text-sm text-rose-400 hover:text-rose-300"
            >
              全部下架
            </button>
            <button
              onClick={onClose}
              className="text-sm text-zinc-300 hover:text-white px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700"
            >
              关闭
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
