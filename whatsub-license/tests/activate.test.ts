import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { Database } from '../src/lib/db.js';
import { activateRoute } from '../src/routes/activate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FP = 'a'.repeat(64); // valid hex SHA-256 shape

function makeApp() {
  const mem = newDb();
  const sql = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf-8');
  mem.public.none(sql);
  const adapter = mem.adapters.createPg();
  const db = new Database(new adapter.Pool());
  const app = new Hono();
  app.route('/api/activate', activateRoute(db));
  return { app, db };
}

async function activate(app: Hono, body: unknown) {
  return app.request('/api/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/activate — happy path', () => {
  it('grants slot for a brand-new device on a valid key', async () => {
    const { app, db } = makeApp();
    await db.insertLicense({
      key: 'WHATSUB-AAAA-AAAA-AAAA-AAAA',
      max_devices: 3, created_at: 1, buyer_note: null, email: null,
    });

    const res = await activate(app, {
      key: 'WHATSUB-AAAA-AAAA-AAAA-AAAA',
      fingerprint: FP,
      deviceLabel: 'renjx 的 Mac',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('active');

    // Side effect: a row exists in activations
    const a = await db.findActivation('WHATSUB-AAAA-AAAA-AAAA-AAAA', FP);
    expect(a).not.toBeNull();
    expect(a?.device_label).toBe('renjx 的 Mac');
    expect(a?.deactivated_at).toBeNull();
  });
});
