import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export type AuthStatus = 'unknown' | 'authed' | 'unauthed';

interface AuthStore {
  status: AuthStatus;
  email: string | null;
  hasActiveLicense: boolean;
  refresh: () => Promise<void>;
  authFromLicense: (licenseKey: string) => Promise<{ ok: boolean; reason?: string }>;
  logout: () => Promise<void>;
}

interface AuthMeResult {
  authenticated: boolean;
  email: string | null;
  hasActiveLicense: boolean | null;
}

interface AuthResult {
  ok: boolean;
  reason?: string;
}

export const useAuth = create<AuthStore>((set, get) => ({
  status: 'unknown',
  email: null,
  hasActiveLicense: false,

  refresh: async () => {
    try {
      const r = await invoke<AuthMeResult>('auth_me');
      if (r.authenticated) {
        set({
          status: 'authed',
          email: r.email,
          hasActiveLicense: !!r.hasActiveLicense,
        });
      } else {
        set({ status: 'unauthed', email: null, hasActiveLicense: false });
      }
    } catch {
      set({ status: 'unauthed', email: null, hasActiveLicense: false });
    }
  },

  authFromLicense: async (licenseKey: string) => {
    const r = await invoke<AuthResult>('auth_from_license', { licenseKey });
    if (r.ok) await get().refresh();
    return r;
  },

  logout: async () => {
    try {
      await invoke('auth_logout');
    } finally {
      set({ status: 'unauthed', email: null, hasActiveLicense: false });
    }
  },
}));
