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

describe('GET /api/admin/licenses', () => {
  it('returns paginated list with total + page metadata', async () => {
    const { app, db } = makeApp();
    for (let i = 0; i < 7; i++) {
      await db.insertLicense({
        key: `K-${i}`, max_devices: 3, created_at: i,
        buyer_note: null, email: null,
      });
    }
    const res = await app.request('/api/admin/licenses?page=1', { headers: authHeader() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ key: string; active_devices: number }>;
      total: number; page: number; pageSize: number;
    };
    expect(body.total).toBe(7);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(body.items).toHaveLength(7);
    // Sorted descending by created_at
    expect(body.items[0]!.key).toBe('K-6');
  });

  it('search param filters by key or buyer_note', async () => {
    const { app, db } = makeApp();
    await db.insertLicense({
      key: 'K-A', max_devices: 3, created_at: 1, buyer_note: 'xianyu', email: null,
    });
    await db.insertLicense({
      key: 'K-B', max_devices: 3, created_at: 2, buyer_note: 'xhs', email: null,
    });
    const res = await app.request('/api/admin/licenses?search=xianyu', {
      headers: authHeader(),
    });
    const body = (await res.json()) as { items: Array<{ key: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]!.key).toBe('K-A');
  });
});

describe('GET /api/admin/licenses/:key', () => {
  it('returns license + activations with redacted fingerprintTail', async () => {
    const { app, db } = makeApp();
    await db.insertLicense({
      key: 'K-DETAIL', max_devices: 3, created_at: 1,
      buyer_note: 'note', email: null,
    });
    await db.insertActivation({
      license_key: 'K-DETAIL',
      fingerprint: 'abcdef'.repeat(10) + 'abcd',
      device_label: 'mac',
      activated_at: 100, last_seen_at: 100, deactivated_at: null,
    });
    const res = await app.request('/api/admin/licenses/K-DETAIL', {
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      license: { key: string };
      activations: Array<{ fingerprintTail: string }>;
    };
    expect(body.license.key).toBe('K-DETAIL');
    expect(body.activations).toHaveLength(1);
    expect(body.activations[0]!.fingerprintTail).toHaveLength(6);
  });

  it('returns 404 for unknown key', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/licenses/NOPE', {
      headers: authHeader(),
    });
    expect(res.status).toBe(404);
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
