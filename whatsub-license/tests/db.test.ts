import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, IMemoryDb } from 'pg-mem';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeDb(): { mem: IMemoryDb; db: Database } {
  const mem = newDb();
  const sql = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf-8');
  mem.public.none(sql);
  const adapter = mem.adapters.createPg();
  const db = new Database(new adapter.Pool());
  return { mem, db };
}

describe('Database', () => {
  let mem: IMemoryDb;
  let db: Database;

  beforeEach(() => {
    ({ mem, db } = makeDb());
  });

  it('insertLicense + findLicense round-trip', async () => {
    await db.insertLicense({
      key: 'K1',
      max_devices: 3,
      created_at: 1700,
      buyer_note: 'note',
      email: null,
    });
    const found = await db.findLicense('K1');
    expect(found).not.toBeNull();
    expect(found?.max_devices).toBe(3);
    expect(found?.email).toBeNull();
  });

  it('findLicense returns null for missing key', async () => {
    expect(await db.findLicense('NOPE')).toBeNull();
  });

  it('insertActivation + findActivation + listActiveActivations', async () => {
    await db.insertLicense({
      key: 'K2', max_devices: 3, created_at: 1, buyer_note: null, email: null,
    });
    await db.insertActivation({
      license_key: 'K2',
      fingerprint: 'a'.repeat(64),
      device_label: 'mac1',
      activated_at: 100,
      last_seen_at: 100,
      deactivated_at: null,
    });
    const found = await db.findActivation('K2', 'a'.repeat(64));
    expect(found?.device_label).toBe('mac1');
    const active = await db.listActiveActivations('K2');
    expect(active).toHaveLength(1);
  });

  it('softDeactivate marks slot deactivated', async () => {
    await db.insertLicense({
      key: 'K3', max_devices: 3, created_at: 1, buyer_note: null, email: null,
    });
    await db.insertActivation({
      license_key: 'K3', fingerprint: 'b'.repeat(64), device_label: null,
      activated_at: 100, last_seen_at: 100, deactivated_at: null,
    });
    const a = await db.findActivation('K3', 'b'.repeat(64));
    await db.softDeactivate(a!.id, 200);
    const active = await db.listActiveActivations('K3');
    expect(active).toHaveLength(0);
  });

  it('reactivateActivation clears deactivated_at and bumps timestamps', async () => {
    await db.insertLicense({
      key: 'K4', max_devices: 3, created_at: 1, buyer_note: null, email: null,
    });
    await db.insertActivation({
      license_key: 'K4', fingerprint: 'c'.repeat(64), device_label: 'old',
      activated_at: 100, last_seen_at: 100, deactivated_at: 200,
    });
    const a = await db.findActivation('K4', 'c'.repeat(64));
    await db.reactivateActivation(a!.id, 'new', 300);
    const refreshed = await db.findActivation('K4', 'c'.repeat(64));
    expect(refreshed?.device_label).toBe('new');
    expect(refreshed?.activated_at).toBe(300);
    expect(refreshed?.deactivated_at).toBeNull();
  });

  it('listLicenses with empty search returns all + correct active count', async () => {
    await db.insertLicense({
      key: 'A', max_devices: 3, created_at: 100, buyer_note: 'first', email: null,
    });
    await db.insertLicense({
      key: 'B', max_devices: 3, created_at: 200, buyer_note: 'second', email: null,
    });
    await db.insertActivation({
      license_key: 'A', fingerprint: 'd'.repeat(64), device_label: null,
      activated_at: 1, last_seen_at: 1, deactivated_at: null,
    });
    const { items, total } = await db.listLicenses({ search: '', limit: 10, offset: 0 });
    expect(total).toBe(2);
    expect(items).toHaveLength(2);
    const aRow = items.find((i) => i.key === 'A')!;
    expect(aRow.active_devices).toBe(1);
  });

  it('listLicenses with search filters by key/buyer_note/email', async () => {
    await db.insertLicense({
      key: 'AAA', max_devices: 3, created_at: 1, buyer_note: 'xianyu-001', email: null,
    });
    await db.insertLicense({
      key: 'BBB', max_devices: 3, created_at: 2, buyer_note: 'xhs-002', email: null,
    });
    const { items: byNote, total } = await db.listLicenses({
      search: 'xianyu', limit: 10, offset: 0,
    });
    expect(byNote).toHaveLength(1);
    expect(byNote[0]!.key).toBe('AAA');
    // Verify the WHERE clause is applied to the total-count query too —
    // catches the case where filtering works on items but total leaks the
    // unfiltered row count (would silently break pagination metadata).
    expect(total).toBe(1);
  });
});
