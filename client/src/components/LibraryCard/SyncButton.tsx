import { useState } from "react";
import { Cloud, CloudOff, CheckCircle2, Loader2 } from "lucide-react";
import { syncToCloud, friendlySyncError } from "../../lib/api/librarySync";
import type { LibraryEntry } from "../../types/library";
import { openUrl } from "@tauri-apps/plugin-opener";

interface Props {
  entry: LibraryEntry;
  /** Called after a successful sync OR unsync so the parent can refresh
   *  library state from disk (re-invokes `library_list` / the existing store). */
  onChanged: () => void | Promise<void>;
}

type State = "idle" | "syncing" | "synced" | "failed";

export function SyncButton({ entry, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(entry.syncError ?? null);

  // Any URL source can sync now (YouTube, Bilibili, other) — the backend
  // generalised library_sync_to_cloud. Only local-file sources can't (the
  // Rust command still rejects LibrarySource::Local).
  const isUrlSource = entry.source.type === "url";
  const isReady = entry.status === "ready";
  const enabled = isUrlSource && isReady && !busy;

  const state: State =
    busy ? "syncing" :
    error ? "failed" :
    entry.syncedAt ? "synced" : "idle";

  async function doSync() {
    setBusy(true);
    setError(null);
    try {
      const res = await syncToCloud(entry.id);
      if (!res.videoUploaded) {
        // Entry synced (captions) but the OSS video upload failed — show the
        // retryable failed state (also persisted via entry.syncError on reload).
        setError(friendlySyncError("video_upload_failed"));
      }
      await onChanged();
    } catch (err) {
      const raw = String(err);
      setError(friendlySyncError(raw));
      if (raw.includes("quota_exceeded")) {
        if (window.confirm("云端视频已达上限。前往官网购买授权解锁 50 个？")) {
          void openUrl("https://whatsub.eversay.cc/#pricing").catch(() => {});
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (!enabled && state !== "synced") return;
    if (state === "idle") {
      const ok = window.confirm(
        "同步到云？\n仅上传字幕 + 元数据，不上传视频文件。\niOS / 其他设备的 whatSub 能看到这条。"
      );
      if (!ok) return;
      await doSync();
    } else if (state === "failed") {
      await doSync(); // retry
    } else if (state === "synced") {
      const again = window.confirm(
        `已同步 · ${new Date(entry.syncedAt!).toLocaleString()}\n\n点【确定】= 重新同步\n点【取消】= 关闭`
      );
      if (again) await doSync();
    }
  }

  const tooltip = !isUrlSource ? "本地文件源暂不支持云同步"
                : !isReady ? "等解析完成后再同步"
                : state === "failed" ? error ?? "同步失败 · 点重试"
                : state === "synced" ? `已同步 · ${new Date(entry.syncedAt!).toLocaleString()}`
                : "同步到云";

  const colorClasses =
    state === "synced" ? "text-emerald-400 hover:bg-emerald-500/20" :
    state === "failed" ? "text-rose-400 hover:bg-rose-500/20" :
    "text-zinc-300 hover:bg-white/15";

  return (
    <button
      onClick={handleClick}
      disabled={!enabled && state !== "synced" && state !== "failed"}
      title={tooltip}
      aria-label={tooltip}
      className={`
        h-7 w-7 grid place-items-center rounded-full transition-colors
        bg-black/50 backdrop-blur-sm
        ${colorClasses}
        ${!enabled && state !== "synced" && state !== "failed" ? "opacity-40 cursor-not-allowed" : ""}
      `}
    >
      {state === "syncing" && <Loader2 className="h-4 w-4 animate-spin" />}
      {state === "synced" && <CheckCircle2 className="h-4 w-4" />}
      {state === "failed" && <CloudOff className="h-4 w-4" />}
      {state === "idle" && <Cloud className="h-4 w-4" />}
    </button>
  );
}
