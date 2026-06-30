import { createPortal } from "react-dom";
import { useSiteLogin } from "../hooks/useSiteLogin";
import type { SiteLoginAction } from "../utils/friendlyError";

export interface SiteLoginModalProps {
  open: boolean;
  action?: SiteLoginAction;
  onClose: () => void;
  onSuccess?: () => void;
}

export function SiteLoginModal({ open, action, onClose, onSuccess }: SiteLoginModalProps) {
  const login = useSiteLogin({
    onSuccess: () => { onSuccess?.(); onClose(); },
    onCancelled: () => {},
  });

  if (!open) return null;
  const label = action?.siteLabel ?? "网站";

  const onConfirm = () => {
    if (!action) return;
    void login.startLogin({
      key: action.siteKey,
      label: action.siteLabel,
      loginUrl: action.loginUrl,
      harvestDomains: action.harvestDomains,
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      data-agent-popover
      onClick={onClose}
    >
      <div
        className="w-[420px] rounded-xl bg-zinc-900 border border-zinc-700 p-5 text-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        {!login.pendingLogin ? (
          <>
            <div className="text-base font-semibold mb-2">登录 {label}</div>
            <p className="text-sm text-zinc-400 mb-4">
              将打开一个浏览器窗口，请在里面登录你的 {label} 账号；登录后点「我已登录完成」，
              whatsub 会自动抓取 cookie。
            </p>
            {login.loginError && (
              <div className="text-sm text-rose-400 mb-3">{login.loginError}</div>
            )}
            <div className="flex justify-end gap-2">
              <button className="px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200" onClick={onClose}>
                取消
              </button>
              <button
                className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
                onClick={onConfirm}
                disabled={login.starting || !action}
              >
                {login.starting ? "启动中…" : `登录 ${label}`}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-base font-semibold mb-2">等待登录完成</div>
            <p className="text-sm text-zinc-400 mb-4">
              在弹出的浏览器里完成 {login.pendingLogin.label} 登录后，点下面的按钮保存 cookie。
            </p>
            {login.loginError && (
              <div className="text-sm text-rose-400 mb-3">{login.loginError}</div>
            )}
            <div className="flex justify-end gap-2">
              <button className="px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200" onClick={() => void login.cancelLogin()}>
                取消
              </button>
              <button
                className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
                onClick={() => void login.finishLogin()}
                disabled={login.savingLogin}
              >
                {login.savingLogin ? "保存中…" : "我已登录完成"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
