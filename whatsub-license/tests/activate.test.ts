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

describe('POST /api/activate — idempotency', () => {
  it('same key+fingerprint twice does NOT consume a 2nd slot', async () => {
    const { app, db } = makeApp();
    await db.insertLicense({
      key: 'WHATSUB-BBBB-BBBB-BBBB-BBBB',
      max_devices: 1, // tight: only 1 slot
      created_at: 1, buyer_note: null, email: null,
    });

    const r1 = await activate(app, {
      key: 'WHATSUB-BBBB-BBBB-BBBB-BBBB', fingerprint: FP, deviceLabel: 'first',
    });
    expect(r1.status).toBe(200);

    const r2 = await activate(app, {
      key: 'WHATSUB-BBBB-BBBB-BBBB-BBBB', fingerprint: FP, deviceLabel: 'reinstalled',
    });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as any).status).toBe('active');

    const active = await db.listActiveActivations('WHATSUB-BBBB-BBBB-BBBB-BBBB');
    expect(active).toHaveLength(1); // not 2 — same fingerprint
  });
});

describe('POST /api/activate — device limit', () => {
  it('rejects with 409 + device list when slots are full', async () => {
    const { app, db } = makeApp();
    await db.insertLicense({
      key: 'WHATSUB-CCCC-CCCC-CCCC-CCCC',
      max_devices: 2, created_at: 1, buyer_note: null, email: null,
    });

    // Pre-populate 2 active slots
    for (let i = 0; i < 2; i++) {
      await db.insertActivation({
        license_key: 'WHATSUB-CCCC-CCCC-CCCC-CCCC',
        fingerprint: String(i).padStart(64, '0'),
        device_label: `device-${i}`,
        activated_at: 100 + i, last_seen_at: 100 + i, deactivated_at: null,
      });
    }

    const res = await activate(app, {
      key: 'WHATSUB-CCCC-CCCC-CCCC-CCCC',
      fingerprint: 'f'.repeat(64),
      deviceLabel: 'third device',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      status: string;
      maxDevices: number;
      devices: Array<{ deviceLabel: string; fingerprintTail: string }>;
    };
    expect(body.status).toBe('device_limit');
    expect(body.maxDevices).toBe(2);
    expect(body.devices).toHaveLength(2);
    // Tail is last 6 of fingerprint — verify redaction
    expect(body.devices[0]!.fingerprintTail).toHaveLength(6);
    // Full fingerprint never returned
    expect(JSON.stringify(body)).not.toContain('0'.repeat(64));
  });

  it('reactivating a previously-deactivated slot when others are full → 409', async () => {
    const { app, db } = makeApp();
    await db.insertLicense({
      key: 'WHATSUB-DDDD-DDDD-DDDD-DDDD',
      max_devices: 1, created_at: 1, buyer_note: null, email: null,
    });
    // Slot 1: deactivated; Slot 2: active. New activation of slot 1 must fail.
    await db.insertActivation({
      license_key: 'WHATSUB-DDDD-DDDD-DDDD-DDDD',
      fingerprint: 'a'.repeat(64), device_label: 'old',
      activated_at: 100, last_seen_at: 100, deactivated_at: 200,
    });
    await db.insertActivation({
      license_key: 'WHATSUB-DDDD-DDDD-DDDD-DDDD',
      fingerprint: 'b'.repeat(64), device_label: 'new active',
      activated_at: 300, last_seen_at: 300, deactivated_at: null,
    });

    const res = await activate(app, {
      key: 'WHATSUB-DDDD-DDDD-DDDD-DDDD',
      fingerprint: 'a'.repeat(64), // re-claim
      deviceLabel: 'old',
    });
    expect(res.status).toBe(409);
  });
});
