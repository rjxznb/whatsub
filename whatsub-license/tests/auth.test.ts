import { describe, it, expect } from 'vitest';
import { checkAdminAuth } from '../src/lib/auth.js';

describe('checkAdminAuth', () => {
  it('rejects when no ADMIN_TOKEN configured', () => {
    const r = checkAdminAuth('Bearer x', undefined);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('server_missing_admin_token');
  });

  it('rejects when no Bearer header', () => {
    const r = checkAdminAuth(null, 'secret');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_bearer_token');
  });

  it('rejects when Bearer token wrong', () => {
    const r = checkAdminAuth('Bearer wrong', 'secret');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_token');
  });

  it('accepts when Bearer token matches exactly', () => {
    expect(checkAdminAuth('Bearer secret', 'secret').ok).toBe(true);
  });

  it('rejects similar-but-shorter token (length differ)', () => {
    expect(checkAdminAuth('Bearer secre', 'secret').ok).toBe(false);
  });

  it('trims whitespace inside the bearer value', () => {
    expect(checkAdminAuth('Bearer   secret  ', 'secret').ok).toBe(true);
  });
});
