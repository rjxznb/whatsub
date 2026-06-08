import { useState } from "react";
import { Cloud, CloudOff, CheckCircle2, Loader2 } from "lucide-react";
import { syncToCloud, friendlySyncError } from "../../lib/api/librarySync";
import type { LibraryEntry } from "../../types/library";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useDownloadQueue } from "../../store/downloadQueue";
import { applyUploadResult } from "../../store/importQueue";
import { ConfirmDialog } from "../ConfirmDialog";

interface Props {
  entry: LibraryEntry;
  /** Called after a successful sync OR unsync so the parent can refresh
   *  library state from disk (re-invokes `library_list` / the existing store). */
  onChanged: () => void | Promise<void>;
}

type State = "idle" | "syncing" | "synced" | "failed";

interface DialogState {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}

export function SyncButton({ entry, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(entry.syncError ?? null);
  // Themed confirm/notice dialog (replaces the OS-native confirm()).
  const [dialog, setDialog] = useState<DialogState | null>(null);

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
    // Show an "uploading" row in the 后台任务 widget (transcode % then a PUT
    // spinner), same as the queue-driven path. applyUploadResult finalizes it
    // (removes on success / shows upload_failed + 重试上传 on failure).
    useDownloadQueue.getState().upsert(entry.id, {
      videoId: entry.id,
      sourceKind: "url",
      sourceValue: entry.title,
      label: entry.title,
      phase: "uploading",
      percent: 0,
      startedAt: Date.now(),
    });
    try {
      const res = await syncToCloud(entry.id);
      applyUploadResult(entry.id, res.videoUploaded);
      if (!res.videoUploaded) {
        // Entry synced (captions) but the OSS video upload failed — show the
        // retryable failed state (also persisted via entry.syncError on reload).
        setError(friendlySyncError("video_upload_failed"));
      }
      await onChanged();
    } catch (err) {
      useDownloadQueue.getState().remove(entry.id);
      const raw = String(err);
      setError(friendlySyncError(raw));
      // All three upsells deep-link to the desktop Pro card at /#pro (main
      // site, Alipay-web checkout) — NOT the iOS-only /mobile page. Count,
      // size, and duration are all subscription-tier capabilities, lifted
      // unanimously by the same ¥12/月 product.
      if (raw.includes("quota_exceeded")) {
        setDialog({
          title: "云端视频已达上限",
          message:
            "云端视频数量已达免费上限 (3 个)。升级 Pro 会员 (¥12/月) 可解锁到 50 个。",
          confirmLabel: "前往订阅",
          onConfirm: () =>
            void openUrl("https://whatsub.eversay.cc/#pro").catch(() => {}),
        });
      } else if (raw.includes("video_too_large")) {
        // Per-video size cap (free 100MB / sub 500MB). Sub upsell since OSS storage
        // + CDN egress are recurring costs; one-time license alone doesn't move the cap.
        setDialog({
          title: "视频文件超过上限",
          message:
            "该视频超过免费版限制 (100MB)。升级 Pro 会员 (¥12/月) 可同步 500MB 的视频。",
          confirmLabel: "前往订阅",
          onConfirm: () =>
            void openUrl("https://whatsub.eversay.cc/#pro").catch(() => {}),
        });
      } else if (raw.includes("video_too_long")) {
        // Per-video duration cap (free 20min / sub 60min). Same upsell as size.
        setDialog({
          title: "视频时长超过上限",
          message:
            "该视频超过免费版限制 (20 分钟)。升级 Pro 会员 (¥12/月) 可同步 60 分钟的视频。",
          confirmLabel: "前往订阅",
          onConfirm: () =>
            void openUrl("https://whatsub.eversay.cc/#pro").catch(() => {}),
        });
      }
    } finally {
      setBusy(false);
    }
  }

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (!enabled && state !== "synced") return;
    if (state === "idle") {
      setDialog({
        title: "同步到云？",
        // Cap notice up-front so users don't discover the limit by failure.
        // Generic ("免费 / Pro" instead of fetching the user's tier) keeps
        // the dialog stateless — sub status is shown unambiguously by what
        // gets rejected on confirm.
        message:
          "上传字幕 + 视频到云端，手机 / 其他设备的 whatSub 可免 VPN 观看。\n\n" +
          "单个视频上限：免费 100MB / 20 分钟，Pro 会员 500MB / 60 分钟。",
        confirmLabel: "同步",
        onConfirm: () => void doSync(),
      });
    } else if (state === "failed") {
      void doSync(); // retry — no confirm
    } else if (state === "synced") {
      setDialog({
        title: "重新同步？",
        message: `已同步 · ${new Date(entry.syncedAt!).toLocaleString()}\n再次上传会覆盖云端版本。`,
        confirmLabel: "重新同步",
        onConfirm: () => void doSync(),
      });
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
    <>
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
      {dialog && (
        <ConfirmDialog
          title={dialog.title}
          message={dialog.message}
          confirmLabel={dialog.confirmLabel}
          onConfirm={dialog.onConfirm}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
