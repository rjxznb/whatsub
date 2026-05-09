# whatsub-license

License key activation backend for whatSub. **Hono + node-postgres on Node 20**, running in a single Docker container behind enghub's nginx.

> Replaces the legacy Cloudflare Workers + D1 backend. Migrated 2026-05-09 because CF Workers' edge gets GFW-throttled in mainland China (5–10 s first-handshake), unacceptable for activation UX. New stack runs on the same Aliyun ECS that already serves Eversay (`47.93.87.206`, Beijing). Activation latency in mainland: ≤200 ms.

## What it does

Three public-ish concerns:

1. **`POST /api/activate`** — desktop client sends `{key, fingerprint, deviceLabel}`, gets `{status: 'active' | 'device_limit' | 'invalid_key' | 'bad_request'}`. Idempotent on `(key, fingerprint)` — same device hitting again just bumps `last_seen_at`, no new slot consumed.
2. **`/admin/*`** — Alpine.js + Tailwind SPA at `/admin/index.html` for the seller (you) to mint keys, list licenses, free device slots. Bearer-auth gated by `ADMIN_TOKEN` env.
3. **`/download/{win,mac}` + `/api/latest`** — public 302 redirect to the newest jihulab/GitHub release artifact + JSON wrapper for the website's version chip.

Key product policy: **lifetime license, no revocation, no refunds.** Once a device activates, the desktop app runs offline forever. The only ongoing concern is the 3-device-limit enforcement.

## Stack

| | |
|---|---|
| Web framework | **Hono 4** (lightweight router with built-in CORS, static, redirects) |
| DB driver | **`pg` (node-postgres) 8.x** |
| Database | **Existing Eversay Postgres 15** — separate DB `whatsub_license` inside the same `enghub-postgres-1` container. Username `whatsub_license_user` |
| Runtime | **Node 20 LTS Alpine** in Docker, single container `whatsub-license:3002` |
| Tests | **Vitest 1.x + pg-mem 3.x** (in-process Postgres, no Docker for unit tests) |
| Network | Joins enghub's existing `enghub_default` Docker network as `external: true` |
| Public domain | `whatsub.eversay.cc` (subdomain of eversay.cc, ICP-filed via parent) |

## Layout

```
whatsub-license/
├── package.json          # @whatsub/license, type: "module"
├── tsconfig.json         # base — used by typecheck + IDE (includes src + tests)
├── tsconfig.build.json   # extends base, narrows to src/ + sets rootDir for clean dist/index.js
├── .npmrc                # registry=https://registry.npmmirror.com (mainland China network)
├── Dockerfile            # multi-stage: builder (TS→dist) + runtime (alpine + tini)
├── docker-compose.yml    # SOURCE OF TRUTH; deployed to /opt/whatsub/docker-compose.yml
├── nginx/whatsub.conf    # SOURCE OF TRUTH; deployed to /data/nginx-conf.d/whatsub.conf
├── schema.sql            # Postgres DDL (2 tables: licenses + activations + 3 indexes)
├── .env.example          # template for /opt/whatsub/.env on the server
├── public/admin/index.html   # admin SPA (Alpine.js + Tailwind CDN, no build step)
├── src/
│   ├── index.ts          # buildApp() + CORS + serveStatic + CLI entrypoint
│   ├── lib/
│   │   ├── types.ts      # LicenseRow / ActivationRow / LicenseListItem
│   │   ├── db.ts         # Database class (10 methods wrapping pg.Pool)
│   │   ├── auth.ts       # checkAdminAuth — constant-time bearer compare
│   │   └── keygen.ts     # WHATSUB-XXXX-XXXX-XXXX-XXXX generator (31-char alphabet)
│   └── routes/
│       ├── activate.ts   # POST /api/activate — 4 paths (new / idempotent / device_limit / validation)
│       ├── admin.ts      # GET whoami / POST issue / GET licenses (list+detail) / POST deactivate
│       └── download.ts   # GET /download/{win,mac} 302 + GET /api/latest JSON (60s in-process cache)
└── tests/                # one test file per module (52 tests across 8 files)
```

## Local dev

```bash
cd whatsub-license
pnpm install              # uses .npmrc (Taobao mirror, fast in CN)
pnpm dev                  # tsx watch — :3002, FATAL without DATABASE_URL+ADMIN_TOKEN
pnpm test                 # vitest run, all 52 should pass
pnpm typecheck            # tsc --noEmit across src+tests
pnpm build                # tsc -p tsconfig.build.json → dist/index.js
```

To `pnpm dev` with a real DB: spin up a one-off Postgres locally and set `DATABASE_URL` + `ADMIN_TOKEN`. Or just rely on tests (pg-mem covers all DB query paths).

## Build + deploy (Aliyun)

The server is `47.93.87.206` (Eversay's Aliyun ECS). The 1.6/3.4 GB RAM machine **can't `docker compose build`** — always build locally, ship as image tarball, load on server. Same flow as Eversay (see `Enghub/docs/server-operations.md`).

**Per-release deploy:**

```bash
# Local — build + ship
cd whatsub-license
docker build -t whatsub-license:latest .
docker save whatsub-license:latest | gzip > /tmp/whatsub-license.tar.gz
scp -i ~/.ssh/id_ed25519 /tmp/whatsub-license.tar.gz root@47.93.87.206:/tmp/

# Local — apply on server
ssh -i ~/.ssh/id_ed25519 root@47.93.87.206 "
  docker load < /tmp/whatsub-license.tar.gz &&
  cd /opt/whatsub &&
  docker compose --env-file .env up -d --force-recreate &&
  rm /tmp/whatsub-license.tar.gz
"
```

If you also changed `nginx/whatsub.conf` or `docker-compose.yml`, scp those too:

```bash
scp -i ~/.ssh/id_ed25519 nginx/whatsub.conf root@47.93.87.206:/data/nginx-conf.d/whatsub.conf
ssh -i ~/.ssh/id_ed25519 root@47.93.87.206 "docker compose -f /opt/enghub/docker-compose.yml exec nginx nginx -s reload"
# (compose.yml on server: scp + the up -d above)
```

## Server topology

```
443 → nginx (in enghub compose)
       │
       ├ /api/license/*  → proxy_pass → whatsub-license:3002/api/*
       ├ /download/*     → proxy_pass → whatsub-license:3002/download/*
       ├ /admin/*        → proxy_pass → whatsub-license:3002/admin/*
       └ /               → static file serve from /data/whatsub-web/ (marketing site, separate plan)

whatsub-license:3002
       │
       └ pg.Pool → enghub-postgres-1:5432 / DB whatsub_license

Shared with enghub via:
  - Docker network enghub_default (external: true in our compose)
  - Host dir /data/nginx-conf.d/  (we drop our whatsub.conf, enghub's default.conf
                                   is template-processed into the same dir at startup)
  - Postgres container (separate database, separate user)
```

## Key design decisions (and why)

1. **Separate compose at `/opt/whatsub/`, not appended to enghub's compose.** Source-of-truth hygiene (Get_Video repo owns its own infra), failure isolation (whatsub deploy can't break Eversay), clean future portability if whatsub ever moves servers.

2. **Hono not NestJS.** NestJS would mean adding routes to enghub-api, coupling deploy. Hono is ~12 KB, Node-runtime-friendly, plays well with `serveStatic` for the admin SPA. The whole license app fits in one container under 100 MB.

3. **`Database` class wraps pg.Pool.** Single point for SQL audit. Tests inject pg-mem's adapter Pool; routes inject a real Pool. Same shape, different implementation.

4. **In-process 60 s cache for `latest.json`** in `download.ts`. Single container, single instance — a Map suffices, no Redis. Caps upstream traffic to jihulab at 1 req/min.

5. **CORS wildcard `Access-Control-Allow-Origin: *` on `/api/*`.** The activation endpoint is called from the Tauri webview (origin `http://localhost:1420` in dev, `tauri://...` in prod). Auth is the license key itself, not the origin — wildcard is correct.

6. **`/api/license/*` namespace.** Leaves room for future `whatsub.eversay.cc/api/<other-app>/...` (e.g., the marketing site's analytics endpoint). Both client and admin SPA know to prepend the prefix.

7. **`http2 on;` directive (not `listen 443 ssl http2`).** The latter is deprecated since nginx 1.25.1.

8. **Cert path `/etc/nginx/ssl/fullchain.pem` (NOT `/etc/letsencrypt/live/...`).** enghub's nginx container bind-mounts the certs into `/etc/nginx/ssl/`; the `/etc/letsencrypt/live/...` symlinks don't exist inside the container.

## Gotchas (we hit these during migration; check first if a similar symptom shows up)

- **Docker BuildKit cache occasionally fails to invalidate `COPY public ./public`** even when the files changed. Symptom: `docker run --rm whatsub-license:latest sh -c 'grep API_BASE /app/public/admin/index.html'` returns 0 after a fresh build. Workaround: `docker build --no-cache` (but then you may hit the next gotcha).

- **`apk add tini` fails on `--no-cache` builds from mainland China** because Alpine's default mirror (`dl-cdn.alpinelinux.org`) is intermittently unreachable. Workaround: edit Dockerfile to use Aliyun's mirror: `RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories && apk add --no-cache tini`. We haven't applied this in the source — only do so if you need `--no-cache` builds.

- **`docker.io` itself is intermittently blocked from mainland China.** If you do `docker builder prune -af` (which deletes cached base images) and your next build can't fetch `node:20-alpine`, pull through a mirror first: `docker pull docker.m.daocloud.io/library/node:20-alpine && docker tag docker.m.daocloud.io/library/node:20-alpine node:20-alpine`. Then build normally. **Lesson**: don't prune build cache without first ensuring you can re-fetch base images.

- **Hot-patch via `docker cp`**: if you need to push a static-file change without rebuilding the image (e.g., admin SPA tweak): `scp file root@server:/tmp/ && ssh root@server "docker cp /tmp/file whatsub-license:/app/public/admin/index.html"`. Lost on next `docker compose up`, so **also** rebuild + commit the image properly.

- **`pnpm-lock.yaml` lockfile-version 9.0** requires pnpm v9+. The Dockerfile installs `pnpm@9` explicitly via npm + Taobao registry; do NOT switch to corepack (corepack tries to resolve pnpm version from npmjs at build time, which is GFW-throttled).

- **`pg` returns BIGINT as STRING by default.** Caused NaN dates in the admin SPA. Fixed once globally in `src/lib/db.ts` via `pg.types.setTypeParser(20, (val) => Number(val))` — covers every BIGINT column (timestamps + BIGSERIAL ids). Safe because none of our BIGINTs approach 2^53.

- **`pg-mem 3.x` does NOT enforce FK constraints** even when the schema declares them. UNIQUE works. Tests should not assume FK enforcement; rely on real Postgres in deploy.

- **`pg-mem 3.x` rejects correlated subqueries that reference an outer-query alias** (we hit this in `listLicenses`). Workaround: use a CTE + LEFT JOIN. Real Postgres handles both forms — the CTE is also more efficient anyway.

- **`tsc --noEmit` errors with TS18003** if `include` matches zero `.ts` files. We avoid this by always having at least one source file (`src/index.ts`) AND keeping `include: ["src/**/*", "tests/**/*"]` in the base tsconfig.

- **`module: "Bundler"` in tsconfig is wrong for a Node-runtime project.** We use `module: "NodeNext", moduleResolution: "NodeNext"` so relative imports MUST end in `.js` (the TS source uses `.js` even though the file on disk is `.ts` — NodeNext resolves it).

- **Admin SPA fetches** all use `${API_BASE}/admin/...` where `API_BASE = '/api/license'`. If you add a new admin endpoint, follow this convention. The desktop client's `ACTIVATE_ENDPOINT` is hardcoded with the full URL `https://whatsub.eversay.cc/api/license/activate` so it doesn't see this constant.

- **Idempotent re-activation discards the new `deviceLabel`** — if a user renames their device and re-activates with the same fingerprint, the row's `device_label` stays at its previous value. Only `last_seen_at` bumps. Intentional (matches old CF behavior). To rename, the admin must deactivate + the user re-activate.

- **Check-then-insert race** in `activate.ts` Path 2: not atomic. Safe today because we run a single instance with low RPS. If we ever scale out, replace with a partial-unique index or a SERIALIZABLE transaction. There's a comment in the code at the relevant spot.

## Quick map

| Task | File |
|------|------|
| Add a new admin endpoint | `src/routes/admin.ts` (handler) + `tests/admin.test.ts` (TDD) |
| Add a new SPA tab/feature | `public/admin/index.html` — uses Alpine.js, no build step |
| Adjust device-limit policy | `src/routes/activate.ts` Path 1 + Path 2 (the `>= license.max_devices` checks) |
| Change SQL schema | `schema.sql` (deploy = run via psql against `whatsub_license` DB) + update `Database` class methods |
| Adjust download fallback URL | `src/routes/download.ts` — `GITHUB_FALLBACK_BASE` |
| Tighten / loosen CORS | `src/index.ts` — the `cors(...)` middleware config |
| Bump tini / Node version | `Dockerfile` (rebuild + redeploy required) |
| Server-side env vars | `/opt/whatsub/.env` on host (chmod 600, never check in) |
| Admin token rotation | edit `/opt/whatsub/.env` + `docker compose --env-file .env up -d --force-recreate` |

## Migration checklist (only relevant if you're standing up a fresh deploy on a new box)

See `docs/superpowers/plans/2026-05-09-whatsub-license-aliyun-migration.md` Phase 9-10 for the one-time server-side ops:
1. DNS A record for the subdomain
2. nginx conf.d shared dir migration on the host nginx
3. `certbot --expand --standalone` (requires brief nginx stop)
4. Postgres database + user creation (against the existing pg superuser)
5. `/opt/whatsub/.env` (chmod 600)
6. First `docker save | scp | docker load | docker compose up`
7. `psql < schema.sql`
8. nginx reload + curl smoke tests (whoami / issue / activate / download / latest)
