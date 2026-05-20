import { useEffect } from 'react';
import { useAuth } from '../store/auth';
import { useLicense } from '../store/license';

interface Props {
  children: React.ReactNode;
}

/**
 * LicenseSessionGate — fire-and-forget cloud session bootstrap.
 *
 * Cloud auth is ONLY needed for the corpus feature. The license activation
 * page (outer LicenseGate) is the real paywall. So this component never
 * blocks rendering: it kicks off `refresh()` then `authFromLicense()` on
 * mount, writes the result into `useAuth`, and always renders children.
 *
 * Pages that depend on the session (e.g. /corpus) read `useAuth.status`
 * themselves and show their own "云端未连接, 重试" UI when needed. Offline
 * users / network blips don't lose access to library, vocab, player, etc.
 */
export function LicenseSessionGate({ children }: Props) {
  const refresh = useAuth((s) => s.refresh);
  const authFromLicense = useAuth((s) => s.authFromLicense);
  const licenseKey = useLicense((s) => s.state?.key ?? null);

  useEffect(() => {
    (async () => {
      await refresh();
      if (useAuth.getState().status === 'authed') return;
      if (!licenseKey) return;
      await authFromLicense(licenseKey);
    })();
  }, [licenseKey, refresh, authFromLicense]);

  return <>{children}</>;
}
