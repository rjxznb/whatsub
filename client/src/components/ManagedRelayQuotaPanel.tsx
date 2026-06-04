import { useEffect, useState } from "react";
import { useLicense } from "../store/license";
import { llmQuota, type LlmQuota } from "../lib/api/quota";

/**
 * Settings → 模型厂商 → "whatSub 托管 (DeepSeek)" — replaces the API key
 * + model rows with a server-driven quota view:
 *
 *   • 当前来源 (Pro / 试用 / 免费体验)
 *   • 已用 / 总额 + 进度条
 *   • 下次重置 / 用完后说明
 *
 * For TRIAL_ACTIVE users the relay needs the `trialToken` bearer (not
 * the session token, which they don't have until license activation),
 * so we pull it from the local license store and forward it as the
 * llmQuota override.
 *
 * 2026-06-04 (managed-LLM relay phase 3).
 */
export function ManagedRelayQuotaPanel() {
  const mode = useLicense((s) => s.mode);
  const trial = useLicense((s) => s.trial);

  const [quota, setQuota] = useState<LlmQuota | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        // TRIAL_ACTIVE → bearer = trialToken (relay-issued).
        // ACTIVE / NEEDS_KEY → bearer = session token (handled inside llmQuota).
        const override = mode === "TRIAL_ACTIVE" ? trial?.trialToken : undefined;
        if (mode === "TRIAL_ACTIVE" && !override) {
          throw new Error("trial token missing — 请重启应用刷新试用");
        }
        const q = await llmQuota(override);
        if (!cancelled) setQuota(q);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [mode, trial?.trialToken]);

  return (
    <div className="space-y-2 mt-1">
      <div className="text-[11px] text-zinc-400 italic bg-zinc-900/40 border-l-2 border-blue-700 px-3 py-1.5 rounded-r leading-relaxed">
        whatSub 后端代付 DeepSeek，Pro / 试用 / 免费用户都能直接用，不用自己填 key。
        服务端强制 deepseek-v4-flash + 月度 / 终身额度封顶。
      </div>

      {loading && !quota && (
        <div className="text-[11px] text-zinc-500">读取额度中…</div>
      )}

      {error && (
        <div className="text-[11px] text-amber-400 bg-amber-950/30 border border-amber-900/50 rounded px-3 py-2">
          额度查询失败：{error}
        </div>
      )}

      {quota && (
        <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3 space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-zinc-100">
              {tierLabel(quota.tier)}
            </span>
            <span className="text-[11px] text-zinc-400 font-mono">
              {short(quota.used)} / {short(quota.limit)} tokens
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
            <div
              className={
                "h-full transition-all " +
                (usagePct(quota) > 0.9 ? "bg-red-500" : "bg-blue-500")
              }
              style={{ width: `${Math.min(100, usagePct(quota) * 100)}%` }}
            />
          </div>
          <div className="text-[11px] text-zinc-500 leading-relaxed">
            {footerNote(quota)}
          </div>
        </div>
      )}
    </div>
  );
}

function tierLabel(tier: LlmQuota["tier"]): string {
  if (tier === "pro") return "已订阅 Pro";
  if (tier === "trial") return "桌面试用";
  return "免费体验";
}

function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function usagePct(q: LlmQuota): number {
  if (q.limit <= 0) return 0;
  return Math.min(1, q.used / q.limit);
}

function footerNote(q: LlmQuota): string {
  if (q.tier === "free") {
    return "免费体验包 LIFETIME（每个邮箱一次性），用完后请升级 Pro 或切到其它厂商";
  }
  if (q.tier === "trial") {
    return "桌面 24h 试用包；时间或额度任一耗尽就结束";
  }
  if (q.tier === "pro" && q.periodResetAt > 0) {
    const d = new Date(q.periodResetAt);
    const str = d.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return `Pro 月度配额，下次重置：${str}`;
  }
  return "";
}
