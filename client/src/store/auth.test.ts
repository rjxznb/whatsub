import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Import AFTER mock is registered
const { useAuth } = await import('./auth');

beforeEach(() => {
  invokeMock.mockReset();
  // Reset the store
  useAuth.setState({ status: 'unknown', email: null, hasActiveLicense: false });
});

describe('useAuth', () => {
  it('refresh: sets authed when auth_me returns authenticated', async () => {
    invokeMock.mockResolvedValueOnce({
      authenticated: true,
      email: 'a@b.com',
      hasActiveLicense: true,
    });
    await useAuth.getState().refresh();
    expect(useAuth.getState().status).toBe('authed');
    expect(useAuth.getState().email).toBe('a@b.com');
    expect(useAuth.getState().hasActiveLicense).toBe(true);
  });

  it('refresh: sets unauthed when auth_me returns not authenticated', async () => {
    invokeMock.mockResolvedValueOnce({
      authenticated: false,
      email: null,
      hasActiveLicense: null,
    });
    await useAuth.getState().refresh();
    expect(useAuth.getState().status).toBe('unauthed');
  });

  it('logout: invokes auth_logout and sets unauthed', async () => {
    useAuth.setState({ status: 'authed', email: 'a@b.com', hasActiveLicense: true });
    invokeMock.mockResolvedValueOnce({ ok: true });
    await useAuth.getState().logout();
    expect(useAuth.getState().status).toBe('unauthed');
    expect(useAuth.getState().email).toBeNull();
  });
});

describe('useAuth.authFromLicense', () => {
  it('on ok refreshes status', async () => {
    invokeMock
      .mockResolvedValueOnce({ ok: true })       // auth_from_license
      .mockResolvedValueOnce({                   // refresh (auth_me)
        authenticated: true, email: 'paid@x.com', hasActiveLicense: true,
      });
    const r = await useAuth.getState().authFromLicense('WHATSUB-AAAA-BBBB-CCCC-DDDD');
    expect(r.ok).toBe(true);
    expect(useAuth.getState().status).toBe('authed');
    expect(useAuth.getState().email).toBe('paid@x.com');
    expect(invokeMock).toHaveBeenCalledWith('auth_from_license', {
      licenseKey: 'WHATSUB-AAAA-BBBB-CCCC-DDDD',
    });
  });

  it('on failure does not refresh', async () => {
    invokeMock.mockResolvedValueOnce({ ok: false, reason: 'license_not_found' });
    const r = await useAuth.getState().authFromLicense('NOPE');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('license_not_found');
    // status remains as set by beforeEach (unknown), unchanged
    expect(useAuth.getState().status).toBe('unknown');
  });
});
