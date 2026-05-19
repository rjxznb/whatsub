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

  it('sendCode: returns the ok flag from Rust', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true });
    const r = await useAuth.getState().sendCode('a@b.com');
    expect(r.ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('auth_send_code', { email: 'a@b.com' });
  });

  it('verifyCode: on ok refreshes status', async () => {
    invokeMock
      .mockResolvedValueOnce({ ok: true })       // verify-code
      .mockResolvedValueOnce({                   // refresh
        authenticated: true, email: 'a@b.com', hasActiveLicense: false,
      });
    const r = await useAuth.getState().verifyCode('a@b.com', '123456');
    expect(r.ok).toBe(true);
    expect(useAuth.getState().status).toBe('authed');
  });

  it('logout: invokes auth_logout and sets unauthed', async () => {
    useAuth.setState({ status: 'authed', email: 'a@b.com', hasActiveLicense: true });
    invokeMock.mockResolvedValueOnce({ ok: true });
    await useAuth.getState().logout();
    expect(useAuth.getState().status).toBe('unauthed');
    expect(useAuth.getState().email).toBeNull();
  });
});
