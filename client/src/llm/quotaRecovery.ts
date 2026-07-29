import { llmQuota, type LlmQuota } from "../lib/api/quota";
import type { Settings } from "../types/settings";
import { RelayError } from "./providers/relayErrors";

export interface QuotaExhaustedDetails {
  used: number | null;
  limit: number | null;
  periodResetAt: number | null;
  committedCueOffset: number;
  totalCues: number;
}

export const SETTINGS_LLM_LINK = "/settings?highlight=llm-provider";

type LoadQuota = () => Promise<LlmQuota>;

/** Advisory preflight for user-started imports. The relay remains authoritative:
 *  a lookup failure must never turn a temporary network issue into a local
 *  import block. */
export async function preflightManagedQuota(
  settings: Readonly<Settings>,
  loadQuota: LoadQuota = () => llmQuota(),
): Promise<QuotaExhaustedDetails | null> {
  if (settings.vendorId !== "whatsub-managed") return null;
  try {
    const quota = await loadQuota();
    if (quota.tier !== "pro" || quota.used < quota.limit) return null;
    return {
      used: quota.used,
      limit: quota.limit,
      periodResetAt: quota.periodResetAt > 0 ? quota.periodResetAt : null,
      committedCueOffset: 0,
      totalCues: 0,
    };
  } catch {
    return null;
  }
}

export function quotaDetailsFromRelayError(
  error: unknown,
  committedCueOffset: number,
  totalCues: number,
): QuotaExhaustedDetails | null {
  if (!(error instanceof RelayError) || error.code !== "quota_exceeded") {
    return null;
  }
  return {
    used: error.used,
    limit: error.limit,
    periodResetAt: error.periodResetAt,
    committedCueOffset: Math.max(0, committedCueOffset),
    totalCues: Math.max(0, totalCues),
  };
}

export function canResumeQuota(
  details: QuotaExhaustedDetails,
  now = Date.now(),
): boolean {
  return details.periodResetAt !== null && now >= details.periodResetAt;
}

export function quotaRecoveryMessage(details: QuotaExhaustedDetails): string {
  const progress = details.committedCueOffset > 0
    ? `已保存到第 ${details.committedCueOffset} 条字幕`
    : "解析进度尚未开始";
  if (details.periodResetAt === null) {
    return `本月 AI 额度已用完。${progress}；切换自己的 API 后可立即继续。`;
  }
  const reset = formatBeijingTime(details.periodResetAt);
  return `本月 AI 额度已用完。${progress}，将于 ${reset}（北京时间）恢复；恢复后可从这里继续，无需重新下载或转录。`;
}

function formatBeijingTime(epochMs: number): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}/${value("month")}/${value("day")} ${value("hour")}:${value("minute")}`;
}
