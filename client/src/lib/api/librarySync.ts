import { invoke } from "@tauri-apps/api/core";

export interface CloudLibraryEntry {
  id: string;
  youtubeId: string;
  sourceUrl: string;
  title: string;
  durationSec: number | null;
  thumbUrl: string | null;
  syncedAt: number;
}

export interface SyncOk {
  ok: boolean;
  syncedAt: number;
  /** false → captions synced but the OSS video upload failed (iOS needs VPN). */
  videoUploaded: boolean;
}

export interface ReplacementPayload {
  youtubeId: string;
  sourceUrl: string;
  title: string;
  durationSec: number;
  thumbUrl?: string;
  thumbData?: string;
  transcriptSrt: string;
  analysisJson: unknown;
  videoKey: string;
  audioKey?: string;
}

export async function syncToCloud(id: string): Promise<SyncOk> {
  return invoke<SyncOk>("library_sync_to_cloud", { id });
}

export async function stageReplacement(
  queueId: string,
  targetId: string,
  attemptToken: string,
  localVideoId: string,
): Promise<ReplacementPayload> {
  return invoke<ReplacementPayload>("library_stage_replacement", {
    queueId,
    targetId,
    attemptToken,
    localVideoId,
  });
}

export async function completeReplacement(
  queueId: string,
  targetId: string,
  attemptToken: string,
  payload: ReplacementPayload,
): Promise<void> {
  await invoke("library_complete_replacement_http", {
    queueId,
    targetId,
    attemptToken,
    payload,
  });
}

export async function unsyncFromCloud(id: string): Promise<void> {
  await invoke("library_unsync_from_cloud", { id });
}

export async function listSynced(): Promise<CloudLibraryEntry[]> {
  return invoke<CloudLibraryEntry[]>("library_list_synced");
}

export async function materializeFromCloud(id: string): Promise<void> {
  await invoke("library_materialize_from_cloud", { id });
}

/** Maps the prefixed Rust error strings to friendly Chinese for tooltips/dialogs.
 *  Two error shapes for per-video-cap rejections (free 100MB/20min, sub 500MB/60min):
 *    - Client pre-check: `video_too_large {"bytes":N,"limit":M}` / `video_too_long {...}`
 *    - Backend backstop: `http 413: {"error":"video_too_large", ...}` (same shape, wrapped) */
export function friendlySyncError(raw: string): string {
  if (raw === "auth_required") return "需要先登录";
  if (raw === "not_found") return "本地条目找不到";
  if (raw === "entry_not_ready") return "条目还在解析中，等解析完再试";
  if (raw === "only_youtube_sources_supported") return "仅支持 YouTube 源";
  if (raw === "not_youtube") return "URL 不是 YouTube 链接";
  if (raw.startsWith("timeout:")) return "网络超时，检查 VPN 或重试";
  if (raw.startsWith("connect:")) return "连不上服务器，检查网络";
  if (raw.startsWith("http 401")) return "登录已过期，请重新登录";
  if (raw.includes("quota_exceeded")) {
    const m = raw.match(/"used":\s*(\d+).*?"limit":\s*(\d+)/);
    const tail = m ? `（${m[1]}/${m[2]}）` : "";
    return `云端视频已达上限${tail}：删掉一些已同步的，或购买授权解锁 50 个`;
  }
  if (raw.includes("video_too_large")) {
    const m = raw.match(/"bytes":\s*(\d+).*?"limit":\s*(\d+)/);
    const tail = m ? `（${fmtMB(+m[1])} > 上限 ${fmtMB(+m[2])}）` : "";
    return `视频文件超过上限${tail}：升级 Pro 会员可同步更大视频`;
  }
  if (raw.includes("video_too_long")) {
    const m = raw.match(/"duration":\s*(\d+).*?"limit":\s*(\d+)/);
    const tail = m ? `（${fmtMin(+m[1])} > 上限 ${fmtMin(+m[2])}）` : "";
    return `视频时长超过上限${tail}：升级 Pro 会员可同步更长视频`;
  }
  if (raw === "video_upload_failed") {
    return "视频上传失败 · 点重试上传（字幕已同步，手机暂需 VPN）";
  }
  if (raw.startsWith("http ")) return `服务器返回 ${raw}`;
  return raw;
}

function fmtMB(bytes: number): string {
  // 1 MiB rounding so 100 * 1024 * 1024 renders as 100MB.
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
function fmtMin(seconds: number): string {
  return `${Math.round(seconds / 60)}分钟`;
}
