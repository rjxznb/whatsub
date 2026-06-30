import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface LoginArgs {
  key: string;
  label: string;
  loginUrl: string;
  harvestDomains: string[];
}
export type SitePreset = LoginArgs;

export interface UseSiteLogin {
  presets: SitePreset[];
  browsers: string[];
  selectedBrowser: string;
  setSelectedBrowser: (b: string) => void;
  pendingLogin: { key: string; label: string } | null;
  starting: boolean;
  savingLogin: boolean;
  loginError: string | null;
  clearError: () => void;
  startLogin: (args: LoginArgs) => Promise<void>;
  finishLogin: () => Promise<void>;
  cancelLogin: () => Promise<void>;
}

export function useSiteLogin(opts?: {
  onSuccess?: () => void;
  onCancelled?: () => void;
}): UseSiteLogin {
  const [presets, setPresets] = useState<SitePreset[]>([]);
  const [browsers, setBrowsers] = useState<string[]>([]);
  const [selectedBrowser, setSelectedBrowser] = useState("");
  const [pendingLogin, setPendingLogin] = useState<{ key: string; label: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [savingLogin, setSavingLogin] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const onSuccessRef = useRef(opts?.onSuccess);
  const onCancelledRef = useRef(opts?.onCancelled);
  useEffect(() => { onSuccessRef.current = opts?.onSuccess; }, [opts?.onSuccess]);
  useEffect(() => { onCancelledRef.current = opts?.onCancelled; }, [opts?.onCancelled]);

  useEffect(() => {
    void Promise.all([
      invoke<SitePreset[]>("site_presets").then(setPresets).catch(() => setPresets([])),
      invoke<string[]>("site_login_browsers").then(setBrowsers).catch(() => {}),
      invoke<{ siteKey: string; label: string } | null>("site_login_pending")
        .then((p) => { if (p) setPendingLogin({ key: p.siteKey, label: p.label }); })
        .catch(() => {}),
    ]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unlistens: UnlistenFn[] = [];
    void Promise.all([
      listen("site-login-success", () => {
        setPendingLogin(null);
        setSavingLogin(false);
        setLoginError(null);
        onSuccessRef.current?.();
      }),
      listen("site-login-cancelled", () => {
        setPendingLogin(null);
        setSavingLogin(false);
        onCancelledRef.current?.();
      }),
    ]).then((us) => {
      if (cancelled) us.forEach((u) => u());
      else unlistens.push(...us);
    });
    return () => {
      cancelled = true;
      unlistens.forEach((u) => u());
    };
  }, []);

  async function startLogin(args: LoginArgs) {
    setLoginError(null);
    setStarting(true);
    try {
      await invoke("site_login_start", {
        args: { ...args, browser: selectedBrowser || undefined },
      });
      setPendingLogin({ key: args.key, label: args.label });
    } catch (e) {
      setLoginError(`登录窗口启动失败：${String(e)}`);
    } finally {
      setStarting(false);
    }
  }

  async function finishLogin() {
    setLoginError(null);
    setSavingLogin(true);
    try {
      await invoke("site_login_finish");
      // success event clears state
    } catch (e) {
      setSavingLogin(false);
      setLoginError(`保存登录失败：${String(e)}`);
    }
  }

  async function cancelLogin() {
    try {
      await invoke("site_login_cancel");
    } catch {
      /* ignore */
    }
    setPendingLogin(null);
    setSavingLogin(false);
    setLoginError(null);
  }

  const clearError = () => setLoginError(null);

  return {
    presets, browsers, selectedBrowser, setSelectedBrowser,
    pendingLogin, starting, savingLogin, loginError, clearError,
    startLogin, finishLogin, cancelLogin,
  };
}
