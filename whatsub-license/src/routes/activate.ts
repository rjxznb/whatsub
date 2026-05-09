import { Hono } from 'hono';
import type { Database } from '../lib/db.js';
import type { ActivationRow } from '../lib/types.js';
import { looksLikeKey, normalizeKey } from '../lib/keygen.js';

interface ActivateRequest {
  key?: unknown;
  fingerprint?: unknown;
  deviceLabel?: unknown;
}

export function activateRoute(db: Database) {
  const app = new Hono();

  app.post('/', async (c) => {
    let body: ActivateRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ status: 'bad_request', detail: 'invalid_json' }, 400);
    }

    const key = typeof body.key === 'string' ? normalizeKey(body.key) : '';
    const fingerprint =
      typeof body.fingerprint === 'string' ? body.fingerprint.trim() : '';
    const deviceLabel =
      (typeof body.deviceLabel === 'string' ? body.deviceLabel : '')
        .slice(0, 100) || null;

    if (!key || !fingerprint) {
      return c.json(
        { status: 'bad_request', detail: 'missing_key_or_fingerprint' },
        400,
      );
    }
    // Format-check the key BEFORE the DB lookup so callers can't probe
    // arbitrary strings against the licenses table.
    if (!looksLikeKey(key)) {
      return c.json(
        { status: 'bad_request', detail: 'invalid_key_format' },
        400,
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(fingerprint)) {
      return c.json(
        { status: 'bad_request', detail: 'fingerprint_not_hex64' },
        400,
      );
    }

    const license = await db.findLicense(key);
    if (!license) return c.json({ status: 'invalid_key' }, 404);

    const now = Date.now();

    // Path 1: same key+fingerprint already exists
    const existing = await db.findActivation(key, fingerprint);
    if (existing) {
      if (existing.deactivated_at !== null) {
        const active = await db.listActiveActivations(key);
        if (active.length >= license.max_devices) {
          return c.json(
            {
              status: 'device_limit',
              maxDevices: license.max_devices,
              devices: active.map(redact),
            },
            409,
          );
        }
        await db.reactivateActivation(existing.id, deviceLabel, now);
      } else {
        // Idempotent re-hit. deviceLabel from the request is intentionally
        // ignored — only last_seen_at bumps. To rename a device, the user
        // must contact support to deactivate, then re-activate with the
        // new label.
        await db.bumpActivationLastSeen(existing.id, now);
      }
      return c.json({ status: 'active' });
    }

    // Path 2: brand-new device.
    //
    // NOTE: check-then-insert is not atomic. Safe today because Aliyun runs
    // this container single-instance and the activation RPS is single-digit.
    // If this ever scales out (multi-instance behind a load balancer), two
    // concurrent activations on a key with 1 free slot could both pass the
    // check and double-spend. Fix at that point: a DB-level UNIQUE+partial
    // index, or wrap the count+insert in a SERIALIZABLE transaction.
    const active = await db.listActiveActivations(key);
    if (active.length >= license.max_devices) {
      return c.json(
        {
          status: 'device_limit',
          maxDevices: license.max_devices,
          devices: active.map(redact),
        },
        409,
      );
    }

    await db.insertActivation({
      license_key: key,
      fingerprint,
      device_label: deviceLabel,
      activated_at: now,
      last_seen_at: now,
      deactivated_at: null,
    });
    return c.json({ status: 'active' });
  });

  return app;
}

function redact(a: ActivationRow): {
  deviceLabel: string;
  activatedAt: number;
  fingerprintTail: string;
} {
  return {
    deviceLabel: a.device_label ?? '(无名设备)',
    activatedAt: a.activated_at,
    fingerprintTail: a.fingerprint.slice(-6),
  };
}
