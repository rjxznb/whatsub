import { useEffect, useState } from 'react';
import { useAuth } from '../store/auth';
import { useLicense } from '../store/license';

interface Props {
  children: React.ReactNode;
}

/**
 * LicenseSessionGate — bridges the license activation layer and the cloud
 * auth session layer.
 *
 * Lifecycle:
 *   1. On mount: call `refresh()` to restore an existing session cookie.
 *      If already authed → render children immediately.
 *   2. Not authed: check if the license store has an activated key.
 *      If yes → call `authFromLicense(key)` to exchange the key for a
 *      session. On success → status flips to 'authed' → render children.
 *   3. No license key (shouldn't happen here — LicenseGate is the outer
 *      gate and guarantees mode === ACTIVE before we mount): render
 *      children anyway so the outer LicenseGate handles the fallback.
 *   4. Exchange error: show an inline error card so the user knows why
 *      they can't reach the app, with guidance to contact support.
 *
 * Nesting: <LicenseGate> → <LicenseSessionGate> → <BrowserRouter> → app
 * LicenseGate ensures mode === ACTIVE before rendering children, so by the
 * time LicenseSessionGate mounts, `useLicense.state.key` is always set.
 */
export function LicenseSessionGate({ children }: Props) {
  const status = useAuth((s) => s.status);
  const refresh = useAuth((s) => s.refresh);
  const authFromLicense = useAuth((s) => s.authFromLicense);
  // licenseState is non-null when LicenseGate has passed (mode === ACTIVE).
  const licenseKey = useLicense((s) => s.state?.key ?? null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      await refresh(); // try existing session first
      if (useAuth.getState().status === 'authed') return;
      // No session — exchange license key for a cloud session
      if (!licenseKey) return; // outer LicenseGate handles "no license yet"
      const r = await authFromLicense(licenseKey);
      if (!r.ok) setError(r.reason ?? 'unknown');
    })();
  }, [licenseKey, refresh, authFromLicense]);

  if (status === 'unknown') {
    return <div className="p-8 text-zinc-400">加载中…</div>;
  }

  if (status === 'unauthed' && error) {
    return (
      <div className="min-h-screen bg-zinc-900 flex items-center justify-center p-4">
        <div className="max-w-sm p-6 bg-zinc-800 rounded-lg border border-zinc-700 space-y-3">
          <h2 className="text-base font-semibold">无法登录云端</h2>
          <p className="text-xs text-zinc-400">原因: {error}</p>
          <p className="text-xs text-zinc-400">请检查激活码或联系客服。</p>
        </div>
      </div>
    );
  }

  // status === 'unauthed' && !error: still trying (no license key yet, or
  // exchange in flight) — render children; LicenseGate handles "no license"
  // status === 'authed': render children normally
  return <>{children}</>;
}
