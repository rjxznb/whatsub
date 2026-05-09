import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'schema.sql');

// ----------------------------------------------------------------------
// Note on pg-mem coverage gaps:
//   pg-mem 3.x parses and stores FOREIGN KEY constraints but does NOT
//   enforce them at insert time — orphan child rows (license_key with no
//   matching licenses row) succeed silently. Real Postgres enforces. This
//   gap is only relevant if a test specifically tries to verify FK
//   behavior; for our purposes UNIQUE enforcement (verified below) is
//   what the routes rely on for the activate-conflict path.
//
//   String values in raw SQL strings are interpolated with `${}` for
//   convenience — these are TEST FIXTURES with hard-coded values, never
//   user input. Do NOT copy this pattern into production route code:
//   route DB queries must use $1, $2 parameterized form via pg.query()
//   to prevent SQL injection.
// ----------------------------------------------------------------------

describe('schema.sql', () => {
  it('creates licenses + activations tables on a fresh Postgres', async () => {
    const db = newDb();
    const sql = readFileSync(schemaPath, 'utf-8');
    db.public.none(sql);

    // licenses table accepts the columns we care about
    db.public.none(
      `INSERT INTO licenses (key, max_devices, created_at, buyer_note, email)
       VALUES ('WHATSUB-XXXX-XXXX-XXXX-XXXX', 3, 1700000000000, 'note', 'a@b.c')`,
    );
    const licRows = db.public.many(`SELECT * FROM licenses`);
    expect(licRows).toHaveLength(1);
    expect(licRows[0].max_devices).toBe(3);

    // activations table accepts the FK + auto id
    // Note: fingerprint is pre-computed in JS — pg-mem parses raw SQL so
    //       JS method calls like 'a'.repeat(64) are not valid SQL syntax.
    const fp64 = 'a'.repeat(64);
    db.public.none(
      `INSERT INTO activations (license_key, fingerprint, device_label,
                                activated_at, last_seen_at, deactivated_at)
       VALUES ('WHATSUB-XXXX-XXXX-XXXX-XXXX', '${fp64}', 'mac',
               1700000000001, 1700000000001, NULL)`,
    );
    const actRows = db.public.many(`SELECT * FROM activations`);
    expect(actRows).toHaveLength(1);
    expect(actRows[0].id).toBeGreaterThan(0); // BIGSERIAL assigned a value
  });

  it('enforces UNIQUE (license_key, fingerprint)', async () => {
    const db = newDb();
    const sql = readFileSync(schemaPath, 'utf-8');
    db.public.none(sql);

    db.public.none(
      `INSERT INTO licenses (key, max_devices, created_at) VALUES ('K', 3, 1)`,
    );
    db.public.none(
      `INSERT INTO activations (license_key, fingerprint, activated_at, last_seen_at)
       VALUES ('K', 'fp', 1, 1)`,
    );
    expect(() =>
      db.public.none(
        `INSERT INTO activations (license_key, fingerprint, activated_at, last_seen_at)
         VALUES ('K', 'fp', 2, 2)`,
      ),
    ).toThrow(/duplicate|UNIQUE/i);
  });
});
