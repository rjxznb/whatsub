import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Globe, ShieldCheck, X, ChevronDown } from 'lucide-react';

// ─── Site brand icons ────────────────────────────────────────────────
// Small inline SVGs in brand colors for the cookies-login dropdown.
// Sized to match lucide's w-4 h-4 (16px). Custom site falls back to
// lucide's Globe (handled at call site via siteKey === "__custom__").
function SiteIcon({ siteKey }: { siteKey: string }) {
  const cls = 'w-4 h-4 shrink-0';
  switch (siteKey) {
    case 'youtube':
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden>
          <path
            fill="#FF0000"
            d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"
          />
          <path fill="#fff" d="M9.545 15.568V8.432L15.818 12z" />
        </svg>
      );
    case 'bilibili':
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden>
          <path
            fill="#00AEEC"
            d="M18.223 3.086a1.25 1.25 0 0 1 0 1.768L17.08 5.996h1.17A3.75 3.75 0 0 1 22 9.747v7.5a3.75 3.75 0 0 1-3.75 3.75H5.75A3.75 3.75 0 0 1 2 17.247v-7.5a3.75 3.75 0 0 1 3.75-3.75h1.166L5.775 4.855a1.25 1.25 0 1 1 1.767-1.768l2.652 2.652c.079.079.145.165.198.257h3.213c.053-.092.12-.179.198-.258l2.652-2.652a1.25 1.25 0 0 1 1.768 0zM18.25 8.496H5.75a1.25 1.25 0 0 0-1.25 1.25v7.5a1.25 1.25 0 0 0 1.25 1.25h12.5a1.25 1.25 0 0 0 1.25-1.25v-7.5a1.25 1.25 0 0 0-1.25-1.25zM8.25 11.5a1 1 0 0 1 1 1v1.5a1 1 0 1 1-2 0V12.5a1 1 0 0 1 1-1zm7.5 0a1 1 0 0 1 1 1v1.5a1 1 0 1 1-2 0V12.5a1 1 0 0 1 1-1z"
          />
        </svg>
      );
    case 'instagram':
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden>
          <path
            fill="#E1306C"
            d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"
          />
        </svg>
      );
    case 'x':
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden>
          <path
            fill="currentColor"
            className="text-zinc-100"
            d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
          />
        </svg>
      );
    case 'tiktok':
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden>
          <path
            fill="currentColor"
            className="text-zinc-100"
            d="M19.321 5.562a5.122 5.122 0 0 1-.443-.258 6.228 6.228 0 0 1-1.137-.966c-.849-.967-1.166-1.95-1.283-2.638h.005C16.368 1.183 16.41 1 16.413 1H12.81v13.93c0 .187 0 .371-.008.553.001.046.005.087.008.135 0 .002 0 .005-.002.008v.022a3.622 3.622 0 0 1-1.83 2.881 3.567 3.567 0 0 1-1.769.466c-1.974 0-3.575-1.611-3.575-3.6 0-1.99 1.601-3.6 3.575-3.6.373 0 .744.059 1.099.176l.004-3.667a7.293 7.293 0 0 0-5.625 1.638 7.7 7.7 0 0 0-1.679 2.07c-.171.295-.821 1.487-.9 3.422-.05 1.099.281 2.237.439 2.707v.01c.099.278.483 1.224 1.106 2.021a8.187 8.187 0 0 0 1.679 1.621v-.01l.01.01c2.071 1.408 4.368 1.316 4.368 1.316.397-.016 1.729 0 3.243-.717 1.679-.796 2.633-1.984 2.633-1.984a8.063 8.063 0 0 0 1.422-2.353c.343-.846.458-1.86.458-2.266V7.847c.054.032.769.502.769.502s1.031.66 2.64.957c1.156.21 2.717.255 2.717.255V5.526c-.541.058-1.642-.114-2.769-.673z"
          />
        </svg>
      );
    default:
      return <Globe className={cls + ' text-zinc-400'} />;
  }
}

/**
 * Pre-import reminder dialog. Shown on the FIRST click of "+ Import"
 * each app session so the user is reminded of the two most common
 * causes of foreground download failure before they paste a URL:
 *   1. No VPN → overseas video sites time out
 *   2. No cookies → modern bot-detection rejects the download
 *
 * The cookies path is wired in-place: user picks a site (preset or
 * custom URL), clicks 登录, the dialog flips to the "等待保存" view
 * — same UX pattern as Settings page's cookies section. After clicking
 * 保存 cookies the Rust side (`site_login_finish`) writes the jar AND
 * calls `cdp_close_browser`, then we close this dialog and proceed.
 *
 * Gating lives in importChecklistGate.ts. Drag-drop of local files
 * bypasses this entirely (no network involved).
 */
type SitePreset = {
  key: string;
  label: string;
  loginUrl: string;
  harvestDomains: string[];
};

const CUSTOM_OPTION_KEY = '__custom__';

interface Props {
  /** Dialog is closing. `skipForever` reflects the "以后不再提示"
   *  checkbox; parent persists it. Parent should then open ImportModal
   *  so the user can paste a URL. */
  onDismiss: (skipForever: boolean) => void;
}

export function ImportChecklistDialog({ onDismiss }: Props) {
  const [skipForever, setSkipForever] = useState(false);

  // Site picker — defaults to youtube (the dominant use case for an
  // English-subtitle learning tool). "__custom__" switches to the URL
  // input.
  const [presets, setPresets] = useState<SitePreset[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('youtube');
  const [customUrl, setCustomUrl] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  // Installed browsers (lowercase ids) + the user's pick ("" = auto-detect).
  // Lets the user choose Chrome — Edge can hand off to a startup-boost
  // background process and exit 0 before CDP comes up.
  const [browsers, setBrowsers] = useState<string[]>([]);
  const [selectedBrowser, setSelectedBrowser] = useState<string>('');

  // Login-in-flight state. `pendingLogin` non-null swaps the layout to
  // the "等待保存" panel. `starting` covers the brief window between
  // clicking 登录 and Rust returning from site_login_start.
  const [pendingLogin, setPendingLogin] = useState<{
    key: string;
    label: string;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  const [savingLogin, setSavingLogin] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Refs so the event listener (mounted once) closes over the latest
  // skipForever value when it auto-dismisses on save success.
  const skipForeverRef = useRef(skipForever);
  useEffect(() => {
    skipForeverRef.current = skipForever;
  }, [skipForever]);
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  // Load presets + check for any already-pending login (e.g. user
  // started a login on Settings page then walked away). Same probe
  // Settings page does on mount.
  useEffect(() => {
    void Promise.all([
      invoke<SitePreset[]>('site_presets')
        .then((p) => setPresets(p))
        .catch(() => setPresets([])),
      invoke<{ siteKey: string; label: string } | null>('site_login_pending')
        .then((p) => {
          if (p) setPendingLogin({ key: p.siteKey, label: p.label });
        })
        .catch(() => {}),
      invoke<string[]>('site_login_browsers')
        .then((b) => setBrowsers(b))
        .catch(() => {}),
    ]);
  }, []);

  // Listen for login outcomes from Rust. On success: Rust already
  // closed the browser (cdp_close_browser inside site_login_finish);
  // we just clear state and dismiss the whole checklist so the parent
  // can open ImportModal.
  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    void Promise.all([
      listen('site-login-success', () => {
        setPendingLogin(null);
        setSavingLogin(false);
        setLoginError(null);
        // Auto-proceed to ImportModal — user just configured cookies,
        // they clearly want to import next.
        onDismissRef.current(skipForeverRef.current);
      }).then((un) => unlistens.push(un)),
      listen('site-login-cancelled', () => {
        setPendingLogin(null);
        setSavingLogin(false);
      }).then((un) => unlistens.push(un)),
    ]);
    return () => {
      unlistens.forEach((u) => u());
    };
  }, []);

  async function startLogin(args: SitePreset) {
    setLoginError(null);
    setStarting(true);
    try {
      await invoke('site_login_start', {
        args: { ...args, browser: selectedBrowser || undefined },
      });
      setPendingLogin({ key: args.key, label: args.label });
    } catch (e) {
      setLoginError(`登录窗口启动失败：${String(e)}`);
    } finally {
      setStarting(false);
    }
  }

  async function onClickLogin() {
    if (selectedKey === CUSTOM_OPTION_KEY) {
      const trimmed = customUrl.trim();
      if (!trimmed) {
        setLoginError('请输入网址');
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(
          trimmed.startsWith('http') ? trimmed : `https://${trimmed}`,
        );
      } catch {
        setLoginError('网址格式无效');
        return;
      }
      const host = parsed.hostname.replace(/^www\./, '');
      await startLogin({
        key: host,
        label: host,
        loginUrl: parsed.toString(),
        harvestDomains: [host],
      });
      return;
    }
    const preset = presets.find((p) => p.key === selectedKey);
    if (!preset) {
      setLoginError('找不到所选站点');
      return;
    }
    await startLogin(preset);
  }

  async function finishLogin() {
    setLoginError(null);
    setSavingLogin(true);
    try {
      await invoke('site_login_finish');
      // success event will fire → handler clears state + dismisses
    } catch (e) {
      setLoginError(String(e));
      setSavingLogin(false);
    }
  }

  async function cancelLogin() {
    try {
      await invoke('site_login_cancel');
    } catch {
      // ignore — even if cancel RPC fails, clear local UI state
    }
    setPendingLogin(null);
    setSavingLogin(false);
    setLoginError(null);
  }

  // ─── "等待保存" view ──────────────────────────────────────────────
  if (pendingLogin) {
    return (
      <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
        <div
          data-tour="checklist"
          className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl p-5"
        >
          <h2 className="text-base font-semibold text-zinc-100 mb-3">
            等待 {pendingLogin.label} 登录完成
          </h2>
          <div className="px-3 py-3 rounded border border-blue-500/40 bg-blue-500/5 mb-4">
            <ol className="space-y-1.5 text-xs leading-relaxed text-zinc-300 list-none">
              <li className="flex gap-2">
                <span className="text-blue-300 font-medium shrink-0">1.</span>
                <span>
                  whatsub 已经在你电脑上打开了 {pendingLogin.label}
                  {' '}的登录页(独立浏览器窗口)
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-blue-300 font-medium shrink-0">2.</span>
                <span>
                  在浏览器里完成登录(Google / Apple / 手机号 / 扫码均可)
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-blue-300 font-medium shrink-0">3.</span>
                <span>
                  登录完成后,
                  <span className="text-blue-300 font-medium">
                    直接关闭浏览器窗口
                  </span>
                  即可 —— whatsub 会自动读取 cookies 并继续导入
                </span>
              </li>
              <li className="flex gap-2 text-zinc-500">
                <span className="shrink-0">·</span>
                <span>
                  也可以切回这里点下面的「保存 cookies」按钮,效果一样
                </span>
              </li>
            </ol>
          </div>
          {loginError && (
            <div className="mb-3 px-2.5 py-1.5 bg-rose-500/10 border border-rose-500/30 rounded text-[11px] text-rose-200">
              {loginError}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={cancelLogin}
              disabled={savingLogin}
              className="px-3 py-1.5 text-sm text-zinc-300 hover:text-zinc-100 disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={finishLogin}
              disabled={savingLogin}
              className="px-4 py-1.5 bg-blue-500 hover:bg-blue-400 disabled:opacity-60 text-black text-sm rounded font-medium"
            >
              {savingLogin ? '保存中...' : '保存 cookies'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Form view ───────────────────────────────────────────────────
  const selectedLabel =
    selectedKey === CUSTOM_OPTION_KEY
      ? '自定义网址'
      : presets.find((p) => p.key === selectedKey)?.label ?? selectedKey;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div
        data-tour="checklist"
        className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">导入前请先确认</h2>
          <button
            type="button"
            onClick={() => onDismiss(skipForever)}
            className="text-zinc-500 hover:text-zinc-200 p-1 -mr-1 rounded"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <ul className="px-5 py-4 space-y-4 text-sm text-zinc-200">
          <li className="flex gap-3">
            <Globe className="w-4 h-4 mt-0.5 shrink-0 text-blue-400" />
            <div className="leading-relaxed">
              <span className="font-medium">下载 YouTube 等海外视频必须开启梯子</span>
            </div>
          </li>

          <li className="flex gap-3">
            <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
            <div className="leading-relaxed flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">授权 whatsub 使用你的网站登录状态</span>
                <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                  强烈建议
                </span>
              </div>
              <div className="text-zinc-400 text-xs mt-1 leading-relaxed">
                下载会员 / 年龄限制 / 私有视频时,whatsub 需要你的登录态
                <span className="text-zinc-500">(浏览器里的 cookies,不是账号密码)</span>
                。点下面会用你系统的 Edge / Chrome 打开站点(独立窗口)——
                <span className="text-zinc-200">在那里正常登录,然后点保存</span>。
                cookies <span className="text-zinc-200">只读到本地,不上传任何东西</span>。
                同一站点登一次能用好几天。
              </div>

              <div className="mt-3 flex items-stretch gap-2">
                <div className="relative w-40">
                  <button
                    type="button"
                    onClick={() => setPickerOpen((v) => !v)}
                    className="w-full px-2.5 py-1.5 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100 flex items-center gap-2 hover:border-zinc-600"
                  >
                    <SiteIcon siteKey={selectedKey} />
                    <span className="truncate flex-1 text-left">
                      {selectedLabel}
                    </span>
                    <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  </button>
                  {pickerOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => setPickerOpen(false)}
                      />
                      <ul className="absolute left-0 right-0 mt-1 z-20 bg-zinc-950 border border-zinc-700 rounded shadow-xl py-1 max-h-60 overflow-y-auto">
                        {presets.map((p) => (
                          <li key={p.key}>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedKey(p.key);
                                setPickerOpen(false);
                                setLoginError(null);
                              }}
                              className={
                                'w-full text-left px-2.5 py-1.5 text-xs hover:bg-zinc-800 flex items-center gap-2 ' +
                                (selectedKey === p.key
                                  ? 'text-blue-300'
                                  : 'text-zinc-200')
                              }
                            >
                              <SiteIcon siteKey={p.key} />
                              <span className="truncate">{p.label}</span>
                            </button>
                          </li>
                        ))}
                        <li className="border-t border-zinc-800 mt-1 pt-1">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedKey(CUSTOM_OPTION_KEY);
                              setPickerOpen(false);
                              setLoginError(null);
                            }}
                            className={
                              'w-full text-left px-2.5 py-1.5 text-xs hover:bg-zinc-800 flex items-center gap-2 ' +
                              (selectedKey === CUSTOM_OPTION_KEY
                                ? 'text-blue-300'
                                : 'text-zinc-200')
                            }
                          >
                            <SiteIcon siteKey={CUSTOM_OPTION_KEY} />
                            <span className="truncate">自定义网址...</span>
                          </button>
                        </li>
                      </ul>
                    </>
                  )}
                </div>
                {browsers.length > 1 && (
                  <select
                    value={selectedBrowser}
                    onChange={(e) => setSelectedBrowser(e.target.value)}
                    title="用哪个浏览器登录。Edge 报「exit code 0」时可换 Chrome"
                    className="px-2 py-1.5 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100 hover:border-zinc-600 shrink-0"
                  >
                    <option value="">自动</option>
                    {browsers.map((b) => (
                      <option key={b} value={b}>
                        {b === 'edge' ? 'Edge' : b === 'chrome' ? 'Chrome' : b === 'brave' ? 'Brave' : b}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  onClick={onClickLogin}
                  disabled={
                    starting ||
                    (selectedKey === CUSTOM_OPTION_KEY && !customUrl.trim())
                  }
                  className="px-3 py-1.5 bg-blue-500 hover:bg-blue-400 disabled:opacity-50 text-black text-xs font-medium rounded shrink-0"
                >
                  {starting ? '启动中...' : '登录'}
                </button>
              </div>

              {selectedKey === CUSTOM_OPTION_KEY && (
                <input
                  type="text"
                  value={customUrl}
                  onChange={(e) => {
                    setCustomUrl(e.target.value);
                    setLoginError(null);
                  }}
                  placeholder="比如 https://www.weibo.com/"
                  spellCheck={false}
                  autoComplete="off"
                  className="mt-2 w-full px-3 py-1.5 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
                />
              )}

              {loginError && (
                <div className="mt-2 px-2.5 py-1.5 bg-rose-500/10 border border-rose-500/30 rounded text-[11px] text-rose-200">
                  {loginError}
                </div>
              )}
            </div>
          </li>
        </ul>

        <div className="px-5 pb-4 pt-1 flex items-center justify-between gap-3 border-t border-zinc-800/60">
          <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={skipForever}
              onChange={(e) => setSkipForever(e.target.checked)}
              className="w-3.5 h-3.5 accent-blue-500"
            />
            以后不再提示
          </label>
          <button
            type="button"
            onClick={() => onDismiss(skipForever)}
            className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 text-sm font-medium rounded"
          >
            我已配好,继续导入
          </button>
        </div>
      </div>
    </div>
  );
}
