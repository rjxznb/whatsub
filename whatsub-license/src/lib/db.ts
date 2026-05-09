import type { Pool } from 'pg';
import type {
  ActivationRow,
  LicenseListItem,
  LicenseRow,
} from './types.js';

/**
 * Thin typed wrapper around a pg Pool. One method per query the routes
 * need; SQL is co-located with the call site so it's easy to audit.
 *
 * Why a class instead of free functions: tests want to inject pg-mem's
 * Pool, and routes want to inject a real Pool — both via the same shape.
 * A class makes that injection a one-liner.
 */
export class Database {
  constructor(private readonly pool: Pool) {}

  // ---- Read helpers --------------------------------------------------

  async findLicense(key: string): Promise<LicenseRow | null> {
    const { rows } = await this.pool.query<LicenseRow>(
      `SELECT key, max_devices, created_at, buyer_note, email
       FROM licenses
       WHERE key = $1`,
      [key],
    );
    return rows[0] ?? null;
  }

  async findActivation(
    licenseKey: string,
    fingerprint: string,
  ): Promise<ActivationRow | null> {
    const { rows } = await this.pool.query<ActivationRow>(
      `SELECT id, license_key, fingerprint, device_label,
              activated_at, last_seen_at, deactivated_at
       FROM activations
       WHERE license_key = $1 AND fingerprint = $2`,
      [licenseKey, fingerprint],
    );
    return rows[0] ?? null;
  }

  async listActiveActivations(licenseKey: string): Promise<ActivationRow[]> {
    const { rows } = await this.pool.query<ActivationRow>(
      `SELECT id, license_key, fingerprint, device_label,
              activated_at, last_seen_at, deactivated_at
       FROM activations
       WHERE license_key = $1 AND deactivated_at IS NULL
       ORDER BY activated_at ASC`,
      [licenseKey],
    );
    return rows;
  }

  async listAllActivations(licenseKey: string): Promise<ActivationRow[]> {
    const { rows } = await this.pool.query<ActivationRow>(
      `SELECT id, license_key, fingerprint, device_label,
              activated_at, last_seen_at, deactivated_at
       FROM activations
       WHERE license_key = $1
       ORDER BY activated_at DESC`,
      [licenseKey],
    );
    return rows;
  }

  // ---- Write helpers -------------------------------------------------

  async insertLicense(row: LicenseRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO licenses (key, max_devices, created_at, buyer_note, email)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.key, row.max_devices, row.created_at, row.buyer_note, row.email],
    );
  }

  async insertActivation(row: Omit<ActivationRow, 'id'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO activations (
         license_key, fingerprint, device_label,
         activated_at, last_seen_at, deactivated_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        row.license_key,
        row.fingerprint,
        row.device_label,
        row.activated_at,
        row.last_seen_at,
        row.deactivated_at,
      ],
    );
  }

  async bumpActivationLastSeen(id: number, ts: number): Promise<void> {
    await this.pool.query(
      `UPDATE activations SET last_seen_at = $1 WHERE id = $2`,
      [ts, id],
    );
  }

  async reactivateActivation(
    id: number,
    deviceLabel: string | null,
    ts: number,
  ): Promise<void> {
    // Re-using a previously deactivated row: clear deactivated_at, bump ts.
    await this.pool.query(
      `UPDATE activations
       SET device_label = $1, activated_at = $2, last_seen_at = $2, deactivated_at = NULL
       WHERE id = $3`,
      [deviceLabel, ts, id],
    );
  }

  async softDeactivate(id: number, ts: number): Promise<void> {
    await this.pool.query(
      `UPDATE activations SET deactivated_at = $1 WHERE id = $2`,
      [ts, id],
    );
  }

  // ---- Admin list query ---------------------------------------------

  async listLicenses(opts: {
    search?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: LicenseListItem[]; total: number }> {
    const search = opts.search?.trim() ?? '';
    const params: unknown[] = [];
    let where = '';
    if (search) {
      // Use ILIKE for case-insensitive search on real Postgres.
      // pg-mem v3 supports ILIKE; if a future pg-mem version rejects it,
      // fall back to plain LIKE (real Postgres works either way).
      where = `WHERE l.key ILIKE $1 OR l.buyer_note ILIKE $1 OR l.email ILIKE $1`;
      params.push(`%${search}%`);
    }

    // total — use ::text cast to get a string pg can return, then parseInt.
    // pg-mem v3 supports ::text; on real Postgres COUNT(*) returns a string
    // from the wire protocol anyway, so parseInt is always correct.
    const totalQ = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM licenses l ${where}`,
      params,
    );
    const total = parseInt(totalQ.rows[0]?.n ?? '0', 10);

    // page
    const limitParam = `$${params.length + 1}`;
    const offsetParam = `$${params.length + 2}`;
    // pg-mem v3 does not resolve outer-query table aliases inside correlated
    // subqueries (reports `column "l.key" does not exist`). Work around by
    // LEFT JOINing a pre-aggregated CTE instead of using a correlated subquery.
    // Real Postgres supports both forms; the JOIN version is also more efficient.
    const itemsQ = await this.pool.query<LicenseListItem>(
      `WITH act_counts AS (
         SELECT license_key, COUNT(*)::int AS active_devices
         FROM activations
         WHERE deactivated_at IS NULL
         GROUP BY license_key
       )
       SELECT
         l.key, l.max_devices, l.created_at, l.buyer_note, l.email,
         COALESCE(ac.active_devices, 0) AS active_devices
       FROM licenses l
       LEFT JOIN act_counts ac ON ac.license_key = l.key
       ${where}
       ORDER BY l.created_at DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      [...params, opts.limit, opts.offset],
    );
    return { items: itemsQ.rows, total };
  }
}
