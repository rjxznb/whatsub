import { useCallback, useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLicense } from "../store/license";
import { llmQuota, type LlmQuota } from "../lib/api/quota";

/** whatSub Pro subscription page (same deep-link the upsell CTAs use). */
const SUBSCRIBE_URL = "https://whatsub.eversay.cc/mobile#pro";

/**
 * Settings → 模型厂商 → "whatSub 托管 (Pro 订阅专用)" — replaces the API key
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // TRIAL_ACTIVE → bearer = trialToken (relay-issued).
      // ACTIVE / SUB_ACTIVE → bearer = session token (handled inside llmQuota).
      const override = mode === "TRIAL_ACTIVE" ? trial?.trialToken : undefined;
      if (mode === "TRIAL_ACTIVE" && !override) {
        throw new Error("trial token missing — 请重启应用刷新试用");
      }
      const q = await llmQuota(override);
      setQuota(q);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [mode, trial?.trialToken]);

  // Fetch on mount/bearer-change, then poll while the panel is open. Tokens are
  // consumed elsewhere (the global AI agent floats over Settings, plus video
  // analysis) WHILE Settings stays mounted — a one-shot fetch would sit stale at
  // whatever it read when Settings first opened (the "usage stuck at 0" report).
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [load]);

  // 买断(无 Pro 订阅)切到托管时,/quota 返回 403 license_blocked. Show a
  // clean "Pro only" upsell instead of dumping the raw 403 JSON.
  const licenseBlocked = !!error && error.includes("license_blocked");

  return (
    <div className="space-y-2 mt-1">
      <div className="text-[11px] text-zinc-400 italic bg-zinc-900/40 border-l-2 border-blue-700 px-3 py-1.5 rounded-r leading-relaxed">
        whatSub 托管模式，开箱即用，无需自己填 API key。
      </div>

      {loading && !quota && (
        <div className="text-[11px] text-zinc-500">读取额度中…</div>
      )}

      {error && licenseBlocked && (
        <div className="text-[11px] bg-zinc-900/60 border border-zinc-800 rounded px-3 py-2.5 space-y-1.5">
          <div className="text-zinc-200">
            whatSub 托管 LLM 仅 <span className="text-amber-300 font-medium">Pro 订阅会员</span> 可用。
          </div>
          <div className="text-zinc-500 leading-relaxed">
            买断版请在上方改用自己的 API key，或订阅 Pro 解锁零配置托管。
          </div>
          <button
            type="button"
            onClick={() => void openUrl(SUBSCRIBE_URL).catch(() => {})}
            className="mt-1 inline-flex items-center gap-1 rounded bg-amber-500 hover:bg-amber-400 text-zinc-900 font-medium px-2.5 py-1 transition-colors"
          >
            前往订阅 Pro →
          </button>
        </div>
      )}

      {error && !licenseBlocked && (
        <div className="text-[11px] text-amber-400 bg-amber-950/30 border border-amber-900/50 rounded px-3 py-2">
          额度查询失败：{error}
        </div>
      )}

      {quota && (
        <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3 space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-zinc-100">
              {tierLabel(quota.tier)}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] text-zinc-400 font-mono">
                {short(quota.used)} / {short(quota.limit)} tokens
              </span>
              <button
                type="button"
                onClick={() => void load()}
                title="刷新额度"
                className="text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <RotateCw className={"h-3 w-3 " + (loading ? "animate-spin" : "")} />
              </button>
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
