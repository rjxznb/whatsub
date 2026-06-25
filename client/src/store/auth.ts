import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export type AuthStatus = 'unknown' | 'authed' | 'unauthed';

interface AuthStore {
  status: AuthStatus;
  email: string | null;
  hasActiveLicense: boolean;
  /** True when the logged-in email holds an active Pro subscription — used to
   *  grant Pro perks to a 买断(ACTIVE)user who ALSO subscribed (same email).
   *  The relay already gates on this server-side; the client tracks it so the
   *  UI surfaces Pro + auto-defaults to the managed vendor. */
  hasActiveSubscription: boolean;
  refresh: () => Promise<void>;
  authFromLicense: (licenseKey: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Email-OTP login (step 1): ask the backend to email a 6-digit code. */
  sendCode: (email: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Email-OTP login (step 2): verify the code → mints + persists a session
   *  for that email. On success refresh() pulls the new identity. This is how a
   *  trial/free user obtains a cloud identity (their mobile account), and how a
   *  买断 user can switch the active account to whichever email holds their Pro
   *  subscription. Identity is always single-email — never a cross-email union. */
  verifyCode: (email: string, code: string) => Promise<{ ok: boolean; reason?: string }>;
  logout: () => Promise<void>;
}

interface AuthMeResult {
  authenticated: boolean;
  email: string | null;
  hasActiveLicense: boolean | null;
  hasActiveSubscription: boolean | null;
}

interface AuthResult {
  ok: boolean;
  reason?: string;
}

export const useAuth = create<AuthStore>((set, get) => ({
  status: 'unknown',
  email: null,
  hasActiveLicense: false,
  hasActiveSubscription: false,

  refresh: async () => {
    try {
      const r = await invoke<AuthMeResult>('auth_me');
      if (r.authenticated) {
        set({
          status: 'authed',
          email: r.email,
          hasActiveLicense: !!r.hasActiveLicense,
          hasActiveSubscription: !!r.hasActiveSubscription,
        });
      } else {
        set({ status: 'unauthed', email: null, hasActiveLicense: false, hasActiveSubscription: false });
      }
    } catch {
      set({ status: 'unauthed', email: null, hasActiveLicense: false, hasActiveSubscription: false });
    }
  },

  authFromLicense: async (licenseKey: string) => {
    const r = await invoke<AuthResult>('auth_from_license', { licenseKey });
    if (r.ok) await get().refresh();
    return r;
  },

  sendCode: async (email: string) => {
    return await invoke<AuthResult>('auth_send_code', { email });
  },

  verifyCode: async (email: string, code: string) => {
    const r = await invoke<AuthResult>('auth_verify_code', { email, code });
    if (r.ok) await get().refresh();
    return r;
  },

  logout: async () => {
    try {
      await invoke('auth_logout');
    } finally {
      set({ status: 'unauthed', email: null, hasActiveLicense: false, hasActiveSubscription: false });
    }
  },
}));
