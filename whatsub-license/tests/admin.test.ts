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

describe('POST /api/admin/issue', () => {
  it('returns N freshly-minted keys', async () => {
    const { app, db } = makeApp();
    const res = await app.request('/api/admin/issue', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 3, buyerNote: 'xianyu-001' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[] };
    expect(body.keys).toHaveLength(3);
    expect(body.keys[0]).toMatch(/^WHATSUB(-[2-9A-HJ-NP-Z]{4}){4}$/);
    const { items } = await db.listLicenses({ search: 'xianyu', limit: 10, offset: 0 });
    expect(items).toHaveLength(3);
  });

  it('clamps count to [1, 50]', async () => {
    const { app } = makeApp();
    const r0 = await app.request('/api/admin/issue', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 9999 }),
    });
    expect(r0.status).toBe(200);
    expect(((await r0.json()) as any).keys).toHaveLength(50);

    const r1 = await app.request('/api/admin/issue', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 0 }),
    });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as any).keys).toHaveLength(1);
  });

  it('clamps maxDevices to [1, 20], default 3', async () => {
    const { app, db } = makeApp();
    await app.request('/api/admin/issue', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 1, maxDevices: 100 }),
    });
    const { items } = await db.listLicenses({ search: '', limit: 10, offset: 0 });
    expect(items[0]!.max_devices).toBe(20);
  });

  it('rejects malformed JSON', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/issue', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

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
