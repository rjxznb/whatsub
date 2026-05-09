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

  return app;
}
