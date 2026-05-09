import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/lib/db.js';
import { buildApp } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeApp() {
  const mem = newDb();
  mem.public.none(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf-8'));
  const adapter = mem.adapters.createPg();
  const db = new Database(new adapter.Pool());
  return buildApp(db, 'TOKEN');
}

describe('buildApp routing', () => {
  it('mounts /api/activate', async () => {
    const app = makeApp();
    // Hono's behavior: GET on a POST-only route returns 404 (route not found
    // for that method). So we just confirm the path is reachable by sending
    // a POST that fails validation — should be 400, not 404.
    const res = await app.request('/api/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400); // missing_key_or_fingerprint
  });

  it('mounts /api/admin/* under auth', async () => {
    const app = makeApp();
    const res = await app.request('/api/admin/whoami');
    expect(res.status).toBe(401); // proves middleware wired up
  });

  it('mounts /download/win', async () => {
    const app = makeApp();
    // Don't care about upstream — just route exists.
    const res = await app.request('/download/win');
    // 302 (cached or upstream success), or fallback 302 if upstream unreachable.
    expect([200, 302, 503]).toContain(res.status);
  });

  it('mounts /api/latest', async () => {
    const app = makeApp();
    const res = await app.request('/api/latest');
    expect([200, 503]).toContain(res.status);
  });

  it('redirects bare / to /admin/', async () => {
    const app = makeApp();
    const res = await app.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/\/admin\/?$/);
  });
});
