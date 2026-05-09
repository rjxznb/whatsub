import { Hono } from 'hono';
import type { Database } from '../lib/db.js';
import { checkAdminAuth } from '../lib/auth.js';

export function adminRoutes(db: Database, adminToken: string | undefined) {
  const app = new Hono();

  // Auth on every admin route
  app.use('*', async (c, next) => {
    const auth = checkAdminAuth(c.req.header('authorization') ?? null, adminToken);
    if (!auth.ok) {
      return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    }
    await next();
  });

  app.get('/whoami', (c) => c.json({ ok: true }));

  app.post('/issue', async (c) => {
    let body: {
      count?: unknown;
      buyerNote?: unknown;
      email?: unknown;
      maxDevices?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const count = Math.max(
      1, Math.min(50, Number.isFinite(body.count as number) ? (body.count as number) : 1),
    );
    const maxDevices = Math.max(
      1, Math.min(20, Number.isFinite(body.maxDevices as number) ? (body.maxDevices as number) : 3),
    );
    const buyerNote =
      (typeof body.buyerNote === 'string' ? body.buyerNote : '').slice(0, 200) || null;
    const email =
      (typeof body.email === 'string' ? body.email : '').slice(0, 200) || null;

    const now = Date.now();
    const keys: string[] = [];

    for (let i = 0; i < count; i++) {
      let key: string;
      let attempts = 0;
      while (true) {
        key = (await import('../lib/keygen.js')).generateLicenseKey();
        const exists = await db.findLicense(key);
        if (!exists) break;
        if (++attempts > 5) {
          return c.json({ error: 'keygen_collision' }, 500);
        }
      }
      await db.insertLicense({
        key, max_devices: maxDevices, created_at: now, buyer_note: buyerNote, email,
      });
      keys.push(key);
    }
    return c.json({ keys });
  });

  return app;
}
