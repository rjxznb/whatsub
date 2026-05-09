import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { Database } from '../src/lib/db.js';
import { adminRoutes } from '../src/routes/admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'sekret-token-very-long';

function makeApp() {
  const mem = newDb();
  const sql = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf-8');
  mem.public.none(sql);
  const adapter = mem.adapters.createPg();
  const db = new Database(new adapter.Pool());
  const app = new Hono();
  app.route('/api/admin', adminRoutes(db, TOKEN));
  return { app, db };
}

const authHeader = (t = TOKEN) => ({ Authorization: `Bearer ${t}` });

describe('GET /api/admin/whoami', () => {
  it('returns 401 without auth', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/whoami');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong token', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/whoami', {
      headers: authHeader('wrong'),
    });
    expect(res.status).toBe(401);
  });

  it('returns { ok: true } with correct token', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/whoami', { headers: authHeader() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
