import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ExternalLink, Check, Pause, Play, Download, Eye, EyeOff, ChevronDown, LogIn, Trash2, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { notify, confirmDialog } from "../store/appDialog";
import { resetLearnerProfile } from "../tutor/learnerProfile";
import { useSettings } from "../store/settings";
import { useAuth } from "../store/auth";
import type { Settings, WhisperModelSize } from "../types/settings";
import { VENDORS, getVendor, inferVendorId } from "../llm/vendors";
import { MODEL_TIERS, formatModelSize } from "../llm/modelTiers";
import { useModelDownload } from "../store/modelDownload";
import { useUpdater } from "../hooks/useUpdater";
import { useLicense } from "../store/license";
import { SiteIcon } from "../components/SiteIcon";
import { ManagedRelayQuotaPanel } from "../components/ManagedRelayQuotaPanel";
import { getVersion } from "@tauri-apps/api/app";

export function Settings() {
  const { settings, load, save } = useSettings();
  const [draft, setDraft] = useState<Settings>(settings);
  const [modelDownloaded, setModelDownloaded] = useState<Record<string, boolean>>({});
  const [modelPartialPct, setModelPartialPct] = useState<Record<string, number>>({});
  // Whisper download state lives in a global Zustand store so navigating
  // away from Settings (e.g. back to Library) doesn't drop the in-flight
  // invoke / progress listener. Component unmount = no UI; download keeps
  // running; come back, store still has the live phase + pct.
  const {
    phase: dlPhase,
    activeSize: dlActive,
    pct: downloadPct,
    start: startDownload,
    pause: pauseDownload,
  } = useModelDownload();
  const downloading = dlPhase === "downloading" ? dlActive : null;
  const downloadPaused = dlPhase === "paused" ? dlActive : null;
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => setDraft(settings), [settings]);

  useEffect(() => {
    Promise.all(
      MODEL_TIERS.map(async (t) => {
        const [ok, partialBytes] = await Promise.all([
          invoke<boolean>("whisper_model_status", { size: t.size }),
          invoke<number>("whisper_model_partial_size", { size: t.size }),
        ]);
        const totalBytes = t.sizeMB * 1024 * 1024;
        const p = totalBytes > 0 ? Math.floor((partialBytes / totalBytes) * 100) : 0;
        return [t.size, ok, p] as const;
      })
    ).then((results) => {
      const dl: Record<string, boolean> = {};
      const pp: Record<string, number> = {};
      for (const [s, ok, p] of results) {
        dl[s] = ok;
        pp[s] = p;
      }
      setModelDownloaded(dl);
      setModelPartialPct(pp);
    });
  }, [downloading, downloadPaused]);

  // The pipeline-event listener for ModelDownload progress is set up once
  // inside the modelDownload store on first start() — no per-component
  // listen needed here.

  function downloadModel(size: WhisperModelSize) {
    // Fire-and-forget: the store keeps the in-flight invoke alive across
    // navigation. We don't await here so the click handler returns
    // immediately; phase/pct updates flow through the store subscription.
    void startDownload(size);
  }

  async function testConnection() {
    setTestStatus("测试中...");
    try {
      const { getProvider } = await import("../llm/providers");
      const p = getProvider(draft);
      let ok = false;
      for await (const _ of p.stream({
        systemPrompt: "Reply with 'ok'.",
        userPrompt: "ok",
      })) {
        ok = true;
        break;
      }
      setTestStatus(ok ? "✓ 连接成功" : "✗ 无响应");
    } catch (e) {
      setTestStatus(`✗ ${e}`);
    }
  }

  async function handleSave() {
    setSaveStatus({ ok: true, msg: "保存中..." });
    try {
      // If libraryDir is changing, freeze the path of any existing entries that
      // don't yet have a videoDir set. This must happen BEFORE save_settings,
      // so the freeze uses the OLD library_dir() value — old videos stay where
      // they are, new imports use the new path.
      if (settings.libraryDir !== draft.libraryDir) {
        const frozen = await invoke<number>("library_freeze_paths");
        if (frozen > 0) {
          console.log(`Froze ${frozen} legacy entries to old library dir`);
        }
      }
      await save(draft);
      setSaveStatus({ ok: true, msg: "✓ 已保存" });
      setTimeout(() => setSaveStatus(null), 2500);
    } catch (e) {
      console.error("save failed", e);
      setSaveStatus({ ok: false, msg: `✗ 保存失败：${e}` });
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-20 flex items-center gap-3 px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <Link
          to="/"
          title="返回 Library"
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-lg font-semibold">设置</h1>
        <div className="ml-auto flex items-center gap-3">
          {saveStatus && (
            <span
              className={
                "text-sm " + (saveStatus.ok ? "text-green-400" : "text-red-400")
              }
            >
              {saveStatus.msg}
            </span>
          )}
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-blue-500 hover:bg-blue-400 text-black font-medium rounded text-sm"
          >
            保存设置
          </button>
        </div>
      </header>

      <div className="max-w-2xl mx-auto p-6 space-y-8">
        <section>
          <h2 className="font-semibold mb-3">翻译服务</h2>
          <VendorSection draft={draft} setDraft={setDraft} />

          <div className="flex items-center gap-3 mt-3">
            <button
              onClick={testConnection}
              className="px-3 py-1.5 bg-zinc-800 text-sm rounded"
            >
              测试连接
            </button>
            {testStatus && <span className="text-sm text-zinc-400">{testStatus}</span>}
          </div>
        </section>

        <section>
          <h2 className="font-semibold mb-3">存储路径</h2>
          <div className="space-y-3">
            <DirField
              label="视频和字幕保存位置"
              value={draft.libraryDir}
              defaultHint="默认：%APPDATA%/whatsub/library"
              onChange={(v) => setDraft({ ...draft, libraryDir: v })}
            />
            <CookieSourceSection draft={draft} setDraft={setDraft} />
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              ⚠ 改了保存位置不会自动搬已有的视频文件，但已经在的视频不会丢，会留在原来的位置正常使用。要集中管理的话请手动把文件移到新路径。
            </p>
          </div>
        </section>

        <section>
          <h2 className="font-semibold mb-3">网络</h2>
          <div className="space-y-1.5">
            <div className="text-sm font-medium text-zinc-200">yt-dlp 代理</div>
            <input
              type="text"
              value={draft.ytDlpProxy ?? ""}
              onChange={(e) => setDraft({ ...draft, ytDlpProxy: e.target.value })}
              placeholder="留空 = 自动检测（如 http://127.0.0.1:7890）"
              className="w-full px-2.5 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 placeholder:text-zinc-500 box-border"
            />
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              访问 / 搜索 YouTube 需要代理时填这里（Clash 默认{" "}
              <code>http://127.0.0.1:7890</code>）。留空会自动用系统环境变量、或探测本机常见代理端口；
              填 <code>off</code> 强制直连。<b>安装版从开始菜单启动时拿不到终端里的代理变量</b>，
              如果搜索/导入一直「工具超时」，在这里显式填一次即可。
            </p>
          </div>
        </section>

        <section>
          <h2 className="font-semibold mb-3">字幕识别引擎</h2>
          {(() => {
            // Single-row dropdown + action, then description + (optional)
            // progress bar underneath. Replaces the previous stacked tier
            // cards which ate ~200 lines of vertical space when the user
            // mostly just wants to swap which model's active.
            //
            // Lock the dropdown while a download is in flight — switching
            // the draft mid-download would hide the in-progress tier from
            // its own progress bar (we render the bar based on the active
            // draft tier matching `downloading`).
            const current = MODEL_TIERS.find((t) => t.size === draft.whisperModel);
            if (!current) return null;
            const isCurrentDownloaded = modelDownloaded[current.size];
            const isCurrentDownload = downloading === current.size;
            const isPausedHere = downloadPaused === current.size;
            const currentPartial = modelPartialPct[current.size] ?? 0;
            const downloadInFlight = downloading !== null;

            // Compact suffix shown next to each option in the dropdown so
            // the user can see download status without first selecting.
            function statusSuffix(t: (typeof MODEL_TIERS)[number]): string {
              if (modelDownloaded[t.size]) return "✓ 已下载";
              const p = modelPartialPct[t.size] ?? 0;
              if (p > 0) return `已下载 ${p}%`;
              return formatModelSize(t.sizeMB);
            }

            return (
              <>
                <div className="flex items-center gap-2">
                  <select
                    value={draft.whisperModel}
                    disabled={downloadInFlight}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        whisperModel: e.target.value as WhisperModelSize,
                      })
                    }
                    className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded text-sm disabled:opacity-50"
                  >
                    {MODEL_TIERS.map((t) => (
                      <option key={t.size} value={t.size}>
                        {t.name}
                        {t.recommended ? "（推荐）" : ""} · {statusSuffix(t)}
                      </option>
                    ))}
                  </select>

                  {/* Right-side action: the dropdown handles selection, this
                      slot just shows the verb for the active tier (download /
                      pause / resume / done). */}
                  {isCurrentDownloaded ? (
                    <span className="text-[11px] text-green-400 inline-flex items-center gap-1 px-2 shrink-0">
                      <Check className="h-3.5 w-3.5" /> 已下载
                    </span>
                  ) : isCurrentDownload ? (
                    <button
                      onClick={pauseDownload}
                      className="text-[11px] px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded inline-flex items-center gap-1 shrink-0"
                    >
                      <Pause className="h-3 w-3" /> 暂停
                    </button>
                  ) : isPausedHere ? (
                    <button
                      onClick={() => downloadModel(current.size)}
                      className="text-[11px] px-3 py-2 bg-blue-500 hover:bg-blue-400 text-black rounded inline-flex items-center gap-1 shrink-0"
                    >
                      <Play className="h-3 w-3" /> 继续
                    </button>
                  ) : (
                    <button
                      onClick={() => downloadModel(current.size)}
                      disabled={downloadInFlight}
                      className="text-[11px] px-3 py-2 bg-blue-500 hover:bg-blue-400 text-black rounded inline-flex items-center gap-1 shrink-0 disabled:opacity-50"
                    >
                      <Download className="h-3 w-3" />
                      {currentPartial > 0 ? `继续 (${currentPartial}%)` : "下载"}
                    </button>
                  )}
                </div>

                {/* Progress bar — only when the active tier is the one
                    actually being transferred or paused. */}
                {(isCurrentDownload || isPausedHere) && (
                  <div className="mt-2">
                    <div className="h-1.5 bg-zinc-800 rounded overflow-hidden">
                      <div
                        className={
                          "h-full transition-all duration-200 " +
                          (isPausedHere ? "bg-amber-500" : "bg-blue-500")
                        }
                        style={{ width: `${downloadPct}%` }}
                      />
                    </div>
                    <p
                      className={
                        "text-[11px] mt-1 " +
                        (isPausedHere ? "text-amber-400" : "text-zinc-400")
                      }
                    >
                      {isPausedHere ? `已暂停（${downloadPct}%）` : `下载中 ${downloadPct}%`}
                    </p>
                  </div>
                )}

                <p className="text-[11px] text-zinc-500 mt-2 leading-relaxed">
                  {current.description}
                </p>
              </>
            );
          })()}
          <div className="mt-3 text-xs">
            <span className="text-zinc-500">显卡加速：</span>
            {draft.whisperBackend ? (
              <span
                className={
                  draft.whisperBackend.startsWith("CPU")
                    ? "text-zinc-300"
                    : "text-emerald-400 font-medium"
                }
              >
                {draft.whisperBackend.startsWith("CPU")
                  ? "❌ 没用上，靠 CPU 跑（识别会慢一些）"
                  : `✅ ${draft.whisperBackend}`}
              </span>
            ) : (
              <span className="text-zinc-500 italic">
                还没检测（导入第一个视频后会自动识别）
              </span>
            )}
          </div>
        </section>

        <AccountSection />

        <UpdateSection />

        <TutorSection />

      </div>
    </div>
  );
}

/** Read-only license info card. No self-service deactivation:换设备 by
 *  user-driven local file delete would leave the server-side slot still
 *  consumed and is misleading; users who want to switch machines should
 *  contact support to release the slot in the admin backend. The
 *  fingerprint tail shown here is what they reference in that ticket
 *  ("please release device …XXXXXX") so support can pinpoint the row
 *  in admin without ambiguity. */
/** Multi-site cookie source picker.
 *
 *  Mode selection (none / in-app / file) is unchanged. The "in-app"
 *  panel now shows ALL sites the user has logged into via the
 *  webview flow — multiple at once — with per-site re-login + remove
 *  controls and a unified add-site form (preset shortcuts + custom
 *  URL). Cookies merge across sites; logging into B 站 doesn't wipe
 *  YouTube and vice versa.
 *
 *  Tauri events:
 *    site-login-success    { siteKey, label, cookieCount, at }
 *    site-login-cancelled  ()
 */
type SiteRecord = {
  key: string;
  label: string;
  loginAt: number;
  cookieCount: number;
};
type SitePreset = {
  key: string;
  label: string;
  loginUrl: string;
  harvestDomains: string[];
};

function CookieSourceSection({
  draft,
  setDraft,
}: {
  draft: Settings;
  setDraft: (s: Settings) => void;
}) {
  const [logins, setLogins] = useState<SiteRecord[]>([]);
  const [presets, setPresets] = useState<SitePreset[]>([]);
  const [pending, setPending] = useState<{ key: string; label: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState("");

  async function reload() {
    try {
      const list = await invoke<SiteRecord[]>("site_logins_list");
      setLogins(list);
    } catch {
      // ignore — empty list is fine to show
    }
  }

  // Load presets + current logins on mount, plus check whether a
  // login is already in flight (e.g. user navigated away from
  // Settings with the login window still open).
  useEffect(() => {
    void Promise.all([
      invoke<SitePreset[]>("site_presets")
        .then(setPresets)
        .catch(() => setPresets([])),
      reload(),
      invoke<{ siteKey: string; label: string } | null>("site_login_pending")
        .then((p) => {
          if (p) setPending({ key: p.siteKey, label: p.label });
        })
        .catch(() => {}),
    ]);
  }, []);

  // Listen for outcome events from the Rust login flow. Both success
  // and cancel clear the pending banner; success also bumps the
  // local draft + reloads the list.
  useEffect(() => {
    const unlistens: Array<() => void> = [];
    void Promise.all([
      listen<{ siteKey: string; label: string; cookieCount: number; at: number }>(
        "site-login-success",
        (e) => {
          setPending(null);
          setError(null);
          setDraft({
            ...draft,
            cookieSource: "in-app",
            inAppLoginAt: e.payload.at,
          });
          void reload();
        },
      ).then((un) => unlistens.push(un)),
      listen("site-login-cancelled", () => {
        setPending(null);
      }).then((un) => unlistens.push(un)),
    ]);
    return () => {
      unlistens.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Start a login. Caller passes either a preset's full descriptor
   *  or a custom { siteKey, label, loginUrl, harvestDomains } built
   *  from the user's URL input. */
  async function startLogin(args: SitePreset) {
    setError(null);
    setPending({ key: args.key, label: args.label });
    try {
      await invoke("site_login_start", { args });
    } catch (e) {
      setPending(null);
      setError(String(e));
    }
  }

  async function startCustomLogin() {
    const trimmed = customUrl.trim();
    if (!trimmed) return;
    let parsed: URL;
    try {
      parsed = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    } catch {
      setError("URL 格式无效");
      return;
    }
    // Use the registrable-ish domain (stripped of "www.") as the
    // site_key + label, so a custom www.weibo.com login lives at
    // key "weibo.com" and harvests cookies from .weibo.com + subdomains.
    const host = parsed.hostname.replace(/^www\./, "");
    await startLogin({
      key: host,
      label: host,
      loginUrl: parsed.toString(),
      harvestDomains: [host],
    });
    setCustomUrl("");
  }

  async function finishLogin() {
    setError(null);
    try {
      await invoke("site_login_finish");
    } catch (e) {
      // Don't clear pending — finish() puts it back so user can
      // continue logging in. Show the error.
      setError(String(e));
    }
  }

  async function cancelLogin() {
    try {
      await invoke("site_login_cancel");
    } catch {}
    setPending(null);
  }

  async function reLogin(record: SiteRecord) {
    const preset = presets.find((p) => p.key === record.key);
    if (preset) {
      await startLogin(preset);
    } else {
      // Custom site that's not a preset — reconstruct from stored
      // domain (the key IS the domain for custom sites).
      await startLogin({
        key: record.key,
        label: record.label,
        loginUrl: `https://${record.key}/`,
        harvestDomains: [record.key],
      });
    }
  }

  async function removeLogin(record: SiteRecord) {
    try {
      await invoke("site_login_remove", { args: { siteKey: record.key } });
    } catch (e) {
      setError(String(e));
      return;
    }
    void reload();
  }

  async function clearAll() {
    if (!confirm("清除所有站点的登录？")) return;
    try {
      await invoke("site_logins_clear");
    } catch (e) {
      setError(String(e));
      return;
    }
    setDraft({ ...draft, inAppLoginAt: undefined });
    void reload();
  }

  // Migration for legacy users: cookieSource didn't exist before this
  // feature shipped, so settings.json from older versions has only
  // cookiesFile. Default to "file" if there's a path; else "none".
  const source =
    draft.cookieSource ??
    (draft.cookiesFile && draft.cookiesFile.trim() ? "file" : "none");

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium mb-1.5">网站 Cookies 来源</div>
        <p className="text-[11px] text-zinc-500 leading-relaxed mb-2">
          多数视频不需要 cookies 就能下载；仅在站点要求登录验证（如 YouTube
          的 bot 检测、B 站会员视频、Instagram、X 等）时才用得上。快速获取支持任意站点，cookies 保存在本地，不上传。
        </p>

        {/* Single-card container: dropdown header + selected-mode body
            share one rounded border so the relationship is visually
            clear (clicking the header selects WHICH mode the body is
            showing). The header has no bottom border; the body has
            border-top to separate them while keeping the unified frame. */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-visible">
          <CookieSourceDropdown
            value={source}
            onChange={(v) => setDraft({ ...draft, cookieSource: v })}
          />

          {source === "in-app" && (
            <div className="border-t border-zinc-800 p-3 space-y-3">
          {/* Pending login banner — shown while a login window is
              open. The user logs in in the popup, then comes back
              here to click "保存". */}
          {pending && (
            <div className="px-3 py-2.5 rounded border border-blue-500/40 bg-blue-500/5">
              <div className="flex items-center gap-2.5 mb-2">
                <Loader2 className="w-4 h-4 text-blue-300 animate-spin shrink-0" />
                <div className="text-sm text-zinc-100">
                  正在获取 <span className="font-medium">{pending.label}</span>{" "}
                  的 cookies...
                </div>
              </div>
              <div className="mb-2 px-2.5 py-2 bg-zinc-950/60 rounded text-[11px] leading-relaxed">
                <div className="text-zinc-300 font-medium mb-1.5">接下来 3 步：</div>
                <ol className="space-y-1 text-zinc-400 list-none">
                  <li className="flex gap-2">
                    <span className="text-blue-300 font-medium shrink-0">1.</span>
                    <span>
                      在刚才打开的浏览器窗口里登录{" "}
                      <span className="text-zinc-200 font-medium">
                        {pending.label}
                      </span>
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-blue-300 font-medium shrink-0">2.</span>
                    <span>
                      回到 whatsub，点下面的{" "}
                      <span className="text-blue-300 font-medium">「保存」</span>
                      按钮，自动抓 cookies
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-zinc-500 font-medium shrink-0">3.</span>
                    <span className="text-zinc-500">
                      浏览器可以保持打开下次直接用，也可以随手关掉 —— cookies 保存好之后关不关都不影响
                    </span>
                  </li>
                </ol>
                <div className="mt-2 pt-1.5 border-t border-zinc-800/60 text-[10px] text-zinc-500">
                  ⓘ 这是一个独立的 profile，不影响你日常浏览器、不加载任何扩展
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={finishLogin}
                  className="flex-1 px-3 py-1.5 bg-blue-500 hover:bg-blue-400 text-black font-medium text-sm rounded"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={cancelLogin}
                  className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-sm rounded"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* Logged-in sites list */}
          {logins.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-xs text-zinc-400">
                  已获取的站点（{logins.length}）
                </div>
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-[10px] text-zinc-500 hover:text-rose-300 transition-colors"
                >
                  全部清除
                </button>
              </div>
              <div className="space-y-1.5">
                {logins.map((rec) => (
                  <div
                    key={rec.key}
                    className="flex items-center gap-2.5 px-2.5 py-1.5 rounded bg-zinc-900/60 border border-zinc-800"
                  >
                    {/* Brand glyph instead of a generic ✓ — gives each
                        row immediate visual identity. Custom URLs fall
                        through to a Globe in SiteIcon. */}
                    <div className="flex h-7 w-7 items-center justify-center rounded shrink-0 text-zinc-200">
                      <SiteIcon siteKey={rec.key} size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-zinc-100 truncate">
                        {rec.label}
                      </div>
                      <div className="text-[10px] text-zinc-500">
                        {formatRelativeTime(rec.loginAt)} · {rec.cookieCount}{" "}
                        条 cookies
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => reLogin(rec)}
                      disabled={!!pending}
                      title="重新获取 cookies"
                      className="px-2 py-0.5 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40"
                    >
                      重新获取
                    </button>
                    <button
                      type="button"
                      onClick={() => removeLogin(rec)}
                      title="移除"
                      className="p-1 rounded text-zinc-500 hover:bg-rose-900/30 hover:text-rose-300 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Add new site — disabled while a login is pending */}
          <div className={pending ? "opacity-40 pointer-events-none" : ""}>
            <div className="text-xs text-zinc-400 mb-1.5">
              {logins.length > 0 ? "获取新站点的 cookies" : "获取第一个站点的 cookies"}
            </div>
            {presets.length > 0 && (
              <div className="flex items-center flex-wrap gap-1.5 mb-2">
                {presets.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => startLogin(p)}
                    disabled={!!pending}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-zinc-700 bg-zinc-900/60 hover:border-zinc-600 hover:bg-zinc-800 disabled:opacity-40 text-zinc-200"
                  >
                    <SiteIcon siteKey={p.key} size={14} />
                    <span>{p.label}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="或输入自定义网址，比如 https://www.weibo.com/"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void startCustomLogin();
                  }
                }}
                className="flex-1 px-2.5 py-1.5 text-sm bg-zinc-950 border border-zinc-700 rounded focus:outline-none focus:border-blue-500"
              />
              <button
                type="button"
                onClick={startCustomLogin}
                disabled={!!pending || !customUrl.trim()}
                className="px-3 py-1.5 text-sm rounded bg-blue-500 hover:bg-blue-400 disabled:opacity-50 text-black font-medium flex items-center gap-1.5"
              >
                <LogIn className="w-3.5 h-3.5" />
                获取
              </button>
            </div>
          </div>

          {error && (
            <div className="px-2.5 py-1.5 bg-rose-500/10 border border-rose-500/30 rounded text-[11px] text-rose-200">
              {error}
            </div>
          )}
            </div>
          )}

          {source === "file" && (
            <div className="border-t border-zinc-800 p-3">
              <FileField
                label="cookies.txt 路径"
                value={draft.cookiesFile}
                defaultHint="按导入页的「?」按钮里的教程导出 cookies.txt 后选到这里。"
                filterName="cookies.txt"
                filterExt={["txt"]}
                onChange={(v) => setDraft({ ...draft, cookiesFile: v })}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Compact dropdown picker for the three cookie-source modes.
 *  Replaces the always-visible 3-radio stack — collapses the full
 *  list to a single row showing the current selection, with the
 *  options revealed on click. Each option carries its own sublabel
 *  inside the dropdown so users can compare modes at the moment of
 *  decision; the sublabel disappears once the menu closes so the
 *  layout stays tight.
 *
 *  Same animation as the Vocab page's SortDropdown
 *  (`animate-sort-slide-down` from App.css) for visual consistency.
 *  Outside-click closes; ChevronDown rotates 180° while open. */
function CookieSourceDropdown({
  value,
  onChange,
}: {
  value: "in-app" | "file" | "none";
  onChange: (v: "in-app" | "file" | "none") => void;
}) {
  const OPTIONS: Array<{
    value: "in-app" | "file" | "none";
    label: string;
    sublabel: string;
  }> = [
    {
      value: "in-app",
      label: "快速获取（推荐）",
      sublabel:
        "用你系统装的 Edge / Chrome 打开登录页（独立 profile，不影响日常浏览，不加载扩展），登完点保存自动抓 cookies。OAuth / 扫码 / 验证码全部支持。",
    },
    {
      value: "file",
      label: "手动 cookies.txt 文件",
      sublabel: "老方式——用 Chrome/Edge 插件「Get cookies.txt LOCALLY」导出后选到这里。",
    },
    {
      value: "none",
      label: "不使用 cookies",
      sublabel: "多数视频可以直接下载；遇到验证身份的提示再切回上面任意一种。",
    },
  ];

  const [open, setOpen] = useState(false);
  const [menuWidth, setMenuWidth] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];

  // Close on outside-click. Listener only attached while open so we
  // don't pay for it on every render.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  function toggleOpen() {
    if (!open && triggerRef.current) {
      setMenuWidth(triggerRef.current.offsetWidth);
    }
    setOpen((v) => !v);
  }

  function pick(v: "in-app" | "file" | "none") {
    onChange(v);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggleOpen}
        // No border on the trigger — the parent card carries it. We
        // only need a hover/active background tweak here so the row
        // reads as the card's header rather than as a separate input.
        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-zinc-800/40 active:bg-zinc-800/60 transition-colors text-sm text-left"
      >
        <span className="truncate">{selected.label}</span>
        <ChevronDown
          className={
            "w-4 h-4 text-zinc-400 transition-transform shrink-0 " +
            (open ? "rotate-180" : "")
          }
        />
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-1 z-30 bg-zinc-900 border border-zinc-700 rounded shadow-2xl py-1 overflow-hidden animate-sort-slide-down"
          style={{
            transformOrigin: "top center",
            width: menuWidth ?? undefined,
          }}
        >
          {OPTIONS.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => pick(o.value)}
                className={
                  "w-full px-3 py-2 text-left flex items-start gap-2 transition-colors " +
                  (active
                    ? "bg-blue-500/10 text-blue-200"
                    : "text-zinc-200 hover:bg-zinc-800")
                }
              >
                <div
                  className={
                    "mt-0.5 w-4 h-4 shrink-0 flex items-center justify-center "
                  }
                >
                  {active && <Check className="w-3.5 h-3.5 text-blue-300" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm">{o.label}</div>
                  <div className="text-[11px] text-zinc-500 leading-relaxed mt-0.5">
                    {o.sublabel}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** "5 分钟前" / "2 小时前" / "3 天前" / "2026-05-09" depending on age. */
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "登录于刚才";
  if (min < 60) return `登录于 ${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `登录于 ${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `登录于 ${day} 天前`;
  return `登录于 ${new Date(ts).toLocaleDateString()}`;
}

/** Account / entitlement card. Covers all unlocked states so the user can see
 *  WHICH path is active + the info available for it:
 *   - ACTIVE      买断 license  → email + 授权码 + device + activation date
 *   - SUB_ACTIVE  Pro 订阅       → email (from auth_me) + manage / logout
 *   - TRIAL_ACTIVE 试用          → remaining hours + upgrade hint
 *  Replaces the old fixed top-right "★ Pro 订阅中" pill (which overlapped the
 *  settings button). */
function AccountSection() {
  const license = useLicense();
  const email = useAuth((s) => s.email);
  const refresh = useAuth((s) => s.refresh);
  const logout = useAuth((s) => s.logout);
  const hasSub = useAuth((s) => s.hasActiveSubscription);

  // Pull email/sub-status from auth_me. SUB_ACTIVE: nothing else refreshes for
  // them. ACTIVE: a 买断 user may ALSO hold a sub (same email) — refresh so we
  // can surface "Pro 订阅中" + the fact that the managed LLM is available.
  useEffect(() => {
    if (license.mode === 'SUB_ACTIVE' || license.mode === 'ACTIVE') void refresh();
  }, [license.mode, refresh]);

  const formatDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // ── 买断 / license ──
  if (license.mode === 'ACTIVE' && license.state) {
    const fpTail = license.state.fingerprint.slice(-6);
    const activatedDate = new Date(license.state.activatedAt);
    return (
      <section className="border-t border-zinc-800 pt-6">
        <h2 className="font-semibold mb-3">软件授权</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded p-4 space-y-2 text-sm">
          <Row label="状态">
            <span className="text-emerald-300">
              买断已激活
              {hasSub && <span className="text-amber-300"> · ★ Pro 订阅中</span>}
            </span>
          </Row>
          <Row label="授权邮箱">
            <span className="text-zinc-300">{email ?? '—'}</span>
          </Row>
          <Row label="授权码">
            <span className="font-mono text-emerald-300">{license.state.key}</span>
          </Row>
          <Row label="本机标识">
            <span>{license.state.deviceLabel}</span>
            <span className="ml-2 font-mono text-zinc-500 text-xs">…{fpTail}</span>
          </Row>
          <Row label="激活时间">
            <span className="text-zinc-300">{formatDate(activatedDate)}</span>
          </Row>
        </div>
        {hasSub && (
          <p className="mt-3 text-[11px] text-amber-300/80 leading-relaxed">
            你同时拥有 Pro 订阅 —— 可在「翻译服务」选「whatSub 托管 (Pro 订阅专用)」直接用托管 LLM，享受 Pro 配额，无需自己填 key。
          </p>
        )}
        <p className="mt-3 text-[11px] text-zinc-500 leading-relaxed">
          换电脑想转移授权？请联系客服并备注本机标识尾号
          <span className="font-mono mx-1">{fpTail}</span>
          ，客服会在后台释放设备槽位，您即可在新设备激活。
        </p>
      </section>
    );
  }

  // ── Pro 订阅(无买断 license)──
  if (license.mode === 'SUB_ACTIVE') {
    return (
      <section className="border-t border-zinc-800 pt-6">
        <h2 className="font-semibold mb-3">账户</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded p-4 space-y-2 text-sm">
          <Row label="状态">
            <span className="text-amber-300">★ Pro 订阅中</span>
          </Row>
          <Row label="邮箱">
            <span className="text-zinc-300">{email ?? '…'}</span>
          </Row>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void openUrl('https://whatsub.eversay.cc/#pro').catch(() => {})}
            className="px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors"
          >
            管理订阅
          </button>
          <button
            type="button"
            onClick={async () => {
              const ok = await confirmDialog(
                '退出后需要重新用邮箱登录（或输入授权码）才能继续使用，确定退出吗？',
                { title: '退出登录', okText: '退出', cancelText: '取消', danger: true },
              );
              if (!ok) return;
              await logout();
              await license.init();
            }}
            className="px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          >
            退出登录
          </button>
        </div>
      </section>
    );
  }

  // ── 试用 ──
  if (license.mode === 'TRIAL_ACTIVE') {
    const hoursLeft = license.trial
      ? Math.max(0, Math.ceil((license.trial.expiresAt - Date.now()) / 3_600_000))
      : 0;
    return (
      <section className="border-t border-zinc-800 pt-6">
        <h2 className="font-semibold mb-3">账户</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded p-4 space-y-2 text-sm">
          <Row label="状态">
            <span className="text-blue-300">试用中</span>
          </Row>
          <Row label="剩余">
            <span className="text-zinc-300">约 {hoursLeft} 小时</span>
          </Row>
        </div>
        <p className="mt-3 text-[11px] text-zinc-500 leading-relaxed">
          试用期间 AI 走 whatsub 托管，免费免配置。已订阅 Pro？可在激活页用邮箱登录解锁；也可激活买断永久授权。
        </p>
      </section>
    );
  }

  return null;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-zinc-500 w-20 shrink-0">{label}</span>
      <span className="flex-1 min-w-0 truncate">{children}</span>
    </div>
  );
}

function UpdateSection() {
  const { status, checkNow, downloadAndInstall } = useUpdater();
  const [appVersion, setAppVersion] = useState<string>("");
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(""));
  }, []);
  return (
    <section className="border-t border-zinc-800 pt-6">
      <h2 className="font-semibold mb-3">应用版本</h2>
      <div className="flex items-center gap-3">
        <span className="text-sm text-zinc-400 tabular-nums">
          v{appVersion || "0.0.0"}
        </span>
        <button
          onClick={() => void checkNow()}
          disabled={status.type === "checking" || status.type === "downloading"}
          className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-sm rounded disabled:opacity-50"
        >
          {status.type === "checking" ? "检查中..." : "检查更新"}
        </button>
        {status.type === "available" && (
          <button
            onClick={() => void downloadAndInstall()}
            className="px-3 py-1.5 bg-blue-500 text-black text-sm rounded font-medium"
          >
            更新到 v{status.update.version}
          </button>
        )}
        {status.type === "none" && (
          <span className="text-sm text-green-400">✓ 已是最新版本</span>
        )}
        {status.type === "error" && (
          <span className="text-xs text-red-400" title={status.message}>
            ✗ 检查失败
          </span>
        )}
        {status.type === "downloading" && (
          <span className="text-xs text-blue-300 tabular-nums">
            下载中 {status.percent.toFixed(0)}%
          </span>
        )}
        {status.type === "installing" && (
          <span className="text-xs text-blue-300">安装中，即将重启...</span>
        )}
      </div>
    </section>
  );
}

/**
 * Vendor preset dropdown + auto-filled fields.
 * The user picks a vendor (DeepSeek / OpenAI / Claude / etc.); we derive
 * `llmProvider` (protocol) and `baseUrl` from the preset. API key and model
 * are stored under the matching protocol slot in Settings (so switching among
 * protocols preserves keys; switching between OpenAI-compatible vendors shares
 * the same slot — that's a known UX limitation we may revisit later).
 */
function VendorSection({
  draft,
  setDraft,
}: {
  draft: Settings;
  setDraft: (s: Settings) => void;
}) {
  const vendorId =
    draft.vendorId ?? inferVendorId(draft.llmProvider, draft.openaiCompatible.baseUrl);
  const vendor = getVendor(vendorId) ?? VENDORS[0];

  // Read the active key+model from whichever protocol slot the current
  // vendor uses. The protocol slots remain runtime source of truth; the
  // vendorKeys map is just per-vendor archive (see types/settings.ts).
  const activeKey =
    vendor.protocol === "claude"
      ? draft.claude.apiKey
      : vendor.protocol === "gemini"
      ? draft.gemini.apiKey
      : draft.openaiCompatible.apiKey;
  const activeModel =
    vendor.protocol === "claude"
      ? draft.claude.model
      : vendor.protocol === "gemini"
      ? draft.gemini.model
      : draft.openaiCompatible.model;

  function pickVendor(id: string) {
    const v = getVendor(id);
    if (!v) return;
    if (v.id === vendor.id) return;

    // 1) Stash the OUTGOING vendor's current key+model under its own slot.
    //    First-time switch from a fresh-install settings → seeds the stash
    //    with whatever the user had typed before this feature existed.
    const stash: Record<string, { apiKey: string; model: string }> = {
      ...(draft.vendorKeys ?? {}),
      [vendor.id]: { apiKey: activeKey, model: activeModel },
    };

    // 2) Load the INCOMING vendor's saved credentials, or blank+default model.
    const restored = stash[v.id];
    const newKey = restored?.apiKey ?? "";
    const newModel = restored?.model ?? (v.models[0] ?? "");

    const next: Settings = {
      ...draft,
      vendorId: v.id,
      llmProvider: v.protocol,
      vendorKeys: stash,
    };
    if (v.protocol === "openai-compatible") {
      next.openaiCompatible = {
        ...draft.openaiCompatible,
        baseUrl: v.baseUrl || draft.openaiCompatible.baseUrl,
        apiKey: newKey,
        model: newModel,
      };
    } else if (v.protocol === "claude") {
      next.claude = { apiKey: newKey, model: newModel };
    } else if (v.protocol === "gemini") {
      next.gemini = { apiKey: newKey, model: newModel };
    }
    setDraft(next);
  }

  // setActiveKey / setActiveModel write to BOTH the live protocol slot
  // AND the per-vendor stash so user edits persist regardless of whether
  // they save before switching vendors.
  function setActiveKey(v: string) {
    const stash = {
      ...(draft.vendorKeys ?? {}),
      [vendor.id]: { apiKey: v, model: activeModel },
    };
    if (vendor.protocol === "claude") {
      setDraft({ ...draft, vendorKeys: stash, claude: { ...draft.claude, apiKey: v } });
    } else if (vendor.protocol === "gemini") {
      setDraft({ ...draft, vendorKeys: stash, gemini: { ...draft.gemini, apiKey: v } });
    } else {
      setDraft({
        ...draft,
        vendorKeys: stash,
        openaiCompatible: { ...draft.openaiCompatible, apiKey: v },
      });
    }
  }
  function setActiveModel(v: string) {
    const stash = {
      ...(draft.vendorKeys ?? {}),
      [vendor.id]: { apiKey: activeKey, model: v },
    };
    if (vendor.protocol === "claude") {
      setDraft({ ...draft, vendorKeys: stash, claude: { ...draft.claude, model: v } });
    } else if (vendor.protocol === "gemini") {
      setDraft({ ...draft, vendorKeys: stash, gemini: { ...draft.gemini, model: v } });
    } else {
      setDraft({
        ...draft,
        vendorKeys: stash,
        openaiCompatible: { ...draft.openaiCompatible, model: v },
      });
    }
  }

  const isCustom = vendor.id === "custom";
  // Only show the API 地址 field for "自定义" vendor — every preset has its
  // URL hard-coded in vendors.ts and the input would just be a read-only
  // display the user can't change. Hiding it on presets cleans the UI without
  // affecting routing (getProvider still resolves the URL from the vendor
  // preset internally).
  const showBaseUrl = isCustom;
  // whatSub 托管 (managed-LLM relay): API key + model are server-resolved
  // (Bearer = session/trial token, model = forced deepseek-v4-flash) so we
  // hide the input rows entirely and surface a quota panel + helper copy
  // instead. The user just picks the vendor and is done.
  const isManagedRelay = vendor.id === "whatsub-managed";

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm text-zinc-300 block">
          模型厂商
          <select
            value={vendor.id}
            onChange={(e) => pickVendor(e.target.value)}
            className="w-full mt-1 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-sm text-zinc-100"
          >
            {VENDORS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {showBaseUrl && (
        <div>
          <label className="text-sm text-zinc-300 block">
            API 地址
            <input
              type="text"
              value={
                isCustom
                  ? draft.openaiCompatible.baseUrl
                  : vendor.baseUrl
              }
              readOnly={!isCustom}
              onChange={(e) =>
                isCustom &&
                setDraft({
                  ...draft,
                  openaiCompatible: {
                    ...draft.openaiCompatible,
                    baseUrl: e.target.value,
                  },
                })
              }
              placeholder={isCustom ? "https://your-proxy.example.com/v1" : ""}
              className={
                "w-full mt-1 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 " +
                (isCustom ? "" : "cursor-default")
              }
            />
          </label>
        </div>
      )}

      {isManagedRelay ? (
        <ManagedRelayQuotaPanel />
      ) : (
        <>
          <SecretField
            label="API Key"
            value={activeKey}
            onChange={setActiveKey}
          />
          {vendor.keyConsoleUrl && (
            <a
              href={vendor.keyConsoleUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300"
            >
              获取 / 管理 API Key <ExternalLink className="h-3 w-3" />
            </a>
          )}

          <ModelField
            models={vendor.models}
            value={activeModel}
            onChange={setActiveModel}
          />
          {vendor.models.length > 0 && (
            <div className="-mt-2 text-[10px] text-zinc-500">
              点输入框右侧的图标看推荐模型列表，也可以手动输入其它模型名
            </div>
          )}
        </>
      )}

      {vendor.note && (
        <div className="text-[11px] text-zinc-400 italic bg-zinc-900/40 border-l-2 border-zinc-700 px-3 py-1.5 rounded-r">
          {vendor.note}
        </div>
      )}
    </div>
  );
}

/**
 * Model name input with a click-to-open dropdown listing the vendor's
 * recommended models. Replaces the previous `<input list=...>` + `<datalist>`
 * pair, where the browser's native datalist filtered the list to entries
 * matching the current input value — meaning once the user had a model name
 * in the field they could no longer browse the full preset list. This custom
 * version always shows everything; user can still type any name freely.
 */
function ModelField({
  models,
  value,
  onChange,
}: {
  models: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click. Pointerdown on document so we beat any handlers
  // that re-render the input during the same event.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const showButton = models.length > 0;

  return (
    <div>
      <label className="text-sm text-zinc-300 block">
        使用的模型
        <div ref={containerRef} className="relative mt-1">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={models[0] ?? "model name"}
            className={
              "w-full px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 " +
              (showButton ? "pr-8" : "")
            }
          />
          {showButton && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label="展开模型列表"
              className="absolute right-1 top-1/2 -translate-y-1/2 p-1 flex items-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded"
            >
              <ChevronDown
                className={"h-4 w-4 transition-transform " + (open ? "rotate-180" : "")}
              />
            </button>
          )}
          {open && showButton && (
            <div className="absolute z-10 left-0 right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded shadow-lg max-h-60 overflow-y-auto">
              {models.map((m) => {
                const active = m === value;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      onChange(m);
                      setOpen(false);
                    }}
                    className={
                      "w-full text-left px-3 py-1.5 text-sm transition-colors " +
                      (active
                        ? "bg-blue-500/20 text-blue-300"
                        : "text-zinc-200 hover:bg-zinc-800")
                    }
                  >
                    {m}
                    {active && <span className="ml-2 text-blue-400">✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </label>
    </div>
  );
}

function DirField({
  label,
  value,
  defaultHint,
  onChange,
}: {
  label: string;
  value: string;
  defaultHint: string;
  onChange: (v: string) => void;
}) {
  async function pickDir() {
    const result = await openDialog({ directory: true, multiple: false });
    if (typeof result === "string") onChange(result);
  }
  return (
    <label className="text-sm text-zinc-300 block">
      {label}
      <div className="mt-1 flex gap-2">
        <input
          type="text"
          value={value}
          readOnly
          placeholder={defaultHint}
          className="flex-1 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 placeholder:text-zinc-600"
        />
        <button
          type="button"
          onClick={pickDir}
          className="px-3 py-1.5 bg-zinc-700 text-zinc-100 rounded text-sm hover:bg-zinc-600"
        >
          选择...
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            title="重置为默认"
            className="px-3 py-1.5 bg-zinc-800 text-zinc-300 rounded text-sm hover:bg-zinc-700"
          >
            清除
          </button>
        )}
      </div>
    </label>
  );
}

function FileField({
  label,
  value,
  defaultHint,
  filterName,
  filterExt,
  onChange,
}: {
  label: string;
  value: string;
  defaultHint: string;
  filterName: string;
  filterExt: string[];
  onChange: (v: string) => void;
}) {
  async function pickFile() {
    const result = await openDialog({
      directory: false,
      multiple: false,
      filters: [{ name: filterName, extensions: filterExt }],
    });
    if (typeof result === "string") onChange(result);
  }
  return (
    <label className="text-sm text-zinc-300 block">
      {label}
      <div className="mt-1 flex gap-2">
        <input
          type="text"
          value={value}
          readOnly
          placeholder={defaultHint}
          className="flex-1 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 placeholder:text-zinc-600"
        />
        <button
          type="button"
          onClick={pickFile}
          className="px-3 py-1.5 bg-zinc-700 text-zinc-100 rounded text-sm hover:bg-zinc-600"
        >
          选择...
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            title="清除"
            className="px-3 py-1.5 bg-zinc-800 text-zinc-300 rounded text-sm hover:bg-zinc-700"
          >
            清除
          </button>
        )}
      </div>
    </label>
  );
}

function TutorSection() {
  const [resetting, setResetting] = useState(false);

  async function handleReset() {
    const ok = await confirmDialog(
      "确认清空学习档案？所有错误事件、薄弱点和水平估计都会删除，无法撤销。",
      { title: "重置学习档案", okText: "清空", danger: true },
    );
    if (!ok) return;
    setResetting(true);
    try {
      await resetLearnerProfile();
    } catch (e) {
      await notify(`重置失败：${String(e)}`);
    } finally {
      setResetting(false);
    }
  }

  return (
    <section className="border-t border-zinc-800 pt-6">
      <h2 className="font-semibold mb-3">私教模式</h2>
      <p className="text-[11px] text-zinc-500 mb-3 leading-relaxed">
        （私教使用你在「翻译服务」配置的同一个模型）
      </p>
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={handleReset}
          disabled={resetting}
          className="px-3 py-1.5 bg-rose-900/30 hover:bg-rose-900/50 text-rose-200 text-sm rounded disabled:opacity-50 transition-colors"
        >
          {resetting ? "重置中..." : "重置学习档案"}
        </button>
      </div>
      <p className="text-[11px] text-zinc-500 mt-2 leading-relaxed">
        学习档案记录你在精讲 / 角色扮演 / 专项练习里犯过的错误（出处视频、你的原话、正确改法），
        并据此推断你的薄弱语法点和英语水平（CEFR 等级）。私教靠它判断「你哪里弱」、推荐你回去
        复习真正出错的片段。重置会永久清空这些数据 —— 水平估计和薄弱点都会归零，相当于让私教把
        对你的了解全部忘掉。
      </p>
    </section>
  );
}

/**
 * Password input with a toggle eye button to reveal the value.
 */
function SecretField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <label className="text-sm text-zinc-300">
      {label}
      <div className="mt-1 flex items-stretch border border-zinc-800 rounded bg-zinc-900 focus-within:border-zinc-600">
        <input
          type={reveal ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 px-3 py-1.5 bg-transparent text-zinc-100 outline-none"
          placeholder={value ? "" : "未设置"}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          title={reveal ? "隐藏" : "显示"}
          className="px-3 flex items-center text-zinc-400 hover:text-zinc-100 select-none"
        >
          {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {value && !reveal && (
        <div className="text-[10px] text-zinc-500 mt-1">已保存（{value.length} 字符）</div>
      )}
    </label>
  );
}
