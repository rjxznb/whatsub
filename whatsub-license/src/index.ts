import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from './lib/db.js';
import { activateRoute } from './routes/activate.js';
import { adminRoutes } from './routes/admin.js';
import { downloadRoutes, latestRoute } from './routes/download.js';

/**
 * buildApp — pure (no env, no listen) factory used by tests.
 * The CLI entrypoint at the bottom of this file handles env wiring + listen.
 */
export function buildApp(db: Database, adminToken: string | undefined) {
  const app = new Hono();

  // CORS on every /api/* route. The Tauri client's webview uses
  // http://localhost:1420 in dev (Vite) and a `tauri://` scheme in
  // prod, both of which trigger browser CORS preflights for the cross-
  // origin POST to whatsub.eversay.cc/api/license/activate. The website
  // also fetches /api/license/latest. Auth is the license key itself or
  // a bearer token, not the origin — so a wildcard `*` is fine.
  app.use(
    '/api/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86400,
    }),
  );

  // / → /admin/ for the convenience case (admin opens the bare URL)
  app.get('/', (c) => c.redirect('/admin/', 302));

  // Activation endpoint — public
  app.route('/api/activate', activateRoute(db));

  // Admin endpoints — bearer-auth gated
  app.route('/api/admin', adminRoutes(db, adminToken));

  // Latest version JSON — public, used by the website
  app.route('/api', latestRoute());

  // Download redirects — public
  app.route('/download', downloadRoutes());

  // Admin SPA served from public/admin/
  app.use('/admin/*', serveStatic({ root: './public' }));

  return app;
}

// ---------- CLI entrypoint (only runs when started directly) -------------
// Normalize both paths to absolute before comparing — Windows argv[1] is
// relative and import.meta.url uses forward-slash file:// URIs.
const _thisFile = fileURLToPath(import.meta.url);
const _argv1 = process.argv[1] ? resolve(process.argv[1]) : '';
const isMain = _thisFile === _argv1;
if (isMain) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('FATAL: DATABASE_URL not set');
    process.exit(1);
  }
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    console.error('FATAL: ADMIN_TOKEN not set');
    process.exit(1);
  }
  const port = parseInt(process.env.PORT ?? '3002', 10);

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  const db = new Database(pool);
  const app = buildApp(db, adminToken);

  serve({ fetch: app.fetch, port }, ({ port }) => {
    console.log(`whatsub-license listening on :${port}`);
  });
}
