/**
 * Bearer-token check for /api/admin/* routes.
 *
 * Constant-time compare so an attacker can't time-attack the token
 * character by character. Same algorithm as the old Worker.
 */
export function checkAdminAuth(
  authorizationHeader: string | null,
  expectedToken: string | undefined,
): { ok: boolean; reason?: string } {
  if (!expectedToken) {
    return { ok: false, reason: 'server_missing_admin_token' };
  }
  if (!authorizationHeader) {
    return { ok: false, reason: 'no_bearer_token' };
  }
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader);
  if (!match) return { ok: false, reason: 'no_bearer_token' };
  const provided = match[1]!.trim();
  return constantTimeEqual(provided, expectedToken)
    ? { ok: true }
    : { ok: false, reason: 'bad_token' };
}

function constantTimeEqual(a: string, b: string): boolean {
  // Pad to longer length so loop count itself doesn't leak info.
  const len = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    mismatch |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return mismatch === 0;
}
