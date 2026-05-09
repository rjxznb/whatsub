# whatSub License Backend → Aliyun Migration — Implementation Plan

> **Status (2026-05-09): EXECUTED + DEPLOYED.** All 33 tasks completed across 12 phases. Backend is live on `https://whatsub.eversay.cc`. The codebase has been **extracted into its own repo at [`github.com/rjxznb/whatsub-license`](https://github.com/rjxznb/whatsub-license)** (private) — references in this plan to `whatsub-license/` paths in this repo are historical. Future backend work happens in the standalone repo. This plan is preserved here as a record of the migration. Project doc with current architecture: `whatsub-license/CLAUDE.md` in the new repo.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the whatSub license backend off Cloudflare Workers + D1 onto the existing Aliyun ECS that runs Eversay. Deploy as an isolated Docker compose at `/opt/whatsub/`, share the existing nginx + Postgres, expose the API at `https://whatsub.eversay.cc/api/license/*`. Update the Tauri client to point at the new endpoint. Retire the Cloudflare Worker.

**Architecture:** New Node 20 + Hono + node-postgres container `whatsub-license:3002`. Lives in its own `docker-compose.yml` joining enghub's existing Docker network as `external: true`. Connects to a new `whatsub_license` database inside the existing `enghub-postgres-1` container. nginx routes `whatsub.eversay.cc/api/license/*`, `/download/*`, `/admin/*` to it via the shared host directory `/data/nginx-conf.d/`.

**Tech Stack:** Hono 4 (web framework), node-postgres (`pg`) 8.x, Node 20 LTS, Vitest 1.x for tests, pg-mem for in-process Postgres in unit tests. TypeScript strict. pnpm package manager.

**Reference docs:**
- Spec: [`docs/superpowers/specs/2026-05-09-whatsub-landing-page-design.md`](../specs/2026-05-09-whatsub-landing-page-design.md), §3, §6, §7, §8, §9
- Aliyun runbook: `C:/Users/renjx/Desktop/Enghub/docs/server-operations.md`
- Old CF Workers code being ported: `license-server/src/`

---

## Phase 0 — Manual prerequisites (Aliyun web console + local secrets)

**Who does this:** the human (家兴), via the Aliyun web console. **Not a subagent task.** Run these BEFORE Phase 9 (the server-side ops). Phase 1-8 (code work) doesn't depend on any of this — they can run in parallel.

### Task 0.1: Add the `whatsub.eversay.cc` DNS record

- [ ] **Step 1: Aliyun DNS console**

Login → 域名解析 → `eversay.cc` zone → Add record:
- Type: **A**
- Hostname: **`whatsub`** (not the full domain — Aliyun appends `.eversay.cc` automatically)
- Value: **`47.93.87.206`**
- TTL: 600

- [ ] **Step 2: Verify propagation (wait 5-10 minutes after saving)**

```bash
nslookup whatsub.eversay.cc
```
Expected: returns `47.93.87.206`.

```bash
nslookup whatsub.eversay.cc 8.8.8.8
```
Expected: same answer from Google's resolver — confirms global propagation.

This must succeed before Task 24 (Let's Encrypt expand) — certbot uses HTTP-01 challenge which requires the DNS record to resolve to the server.

### Task 0.2: ICP filing — verify subdomain is covered

`eversay.cc` is already filed under 京ICP备2026014893号-1. Subdomains on the same server typically inherit the parent filing, but Aliyun's console sometimes wants explicit subdomain registration.

- [ ] **Step 1: Check Aliyun ICP console**

Login → [Aliyun 备案控制台](https://beian.aliyun.com/) → eversay.cc filing → 网站信息.

If existing Eversay subdomains (e.g., `cdn.eversay.cc`, `api.eversay.cc`) are listed individually under the filing, follow the same pattern for `whatsub.eversay.cc`. If only `eversay.cc` is listed and Eversay's subdomains run fine, no action needed for whatsub either.

### Task 0.3: Aliyun security group — verify 80/443 open

- [ ] **Step 1: Aliyun ECS console**

ECS console → 47.93.87.206 instance → Security Groups → Inbound rules.

Required rules (likely already exist for Eversay):
- `80/80 TCP` from `0.0.0.0/0`
- `443/443 TCP` from `0.0.0.0/0`

If missing, add them. If already present, no action.

### Task 0.4: Generate secrets locally

- [ ] **Step 1: Generate Postgres password**

```bash
openssl rand -hex 16
```
Save the output. Will be substituted into `/opt/whatsub/.env`'s `WHATSUB_LICENSE_DATABASE_URL` in Task 25-26.

- [ ] **Step 2: Generate admin token**

```bash
openssl rand -hex 32
```
Save the output. Will be the bearer token for the admin SPA + admin API in Task 26.

Store both in your password manager — they don't recover if lost (Postgres can be reset, but the admin token is shared between server `.env` and any browser sessions).

### Phase 0 done when:

- ✅ `nslookup whatsub.eversay.cc` returns `47.93.87.206` from at least 2 resolvers
- ✅ ICP filing situation is verified (either subdomain auto-inherits, or you've added it explicitly)
- ✅ Security group has 80 + 443 inbound open
- ✅ Two secrets are generated and stored

After this, you can proceed to Phase 9 (and Phases 1-8 can run in parallel without waiting on any of this).

---

## Phase 1 — Project scaffold

### Task 1: Initialize the whatsub-license package

**Files:**
- Create: `whatsub-license/package.json`
- Create: `whatsub-license/tsconfig.json`
- Create: `whatsub-license/.gitignore`
- Create: `whatsub-license/README.md`

- [ ] **Step 1: Create the directory and `package.json`**

```bash
mkdir -p whatsub-license/src/{routes,lib} whatsub-license/public/admin whatsub-license/tests whatsub-license/nginx
cd whatsub-license
```

Write `whatsub-license/package.json`:

```json
{
  "name": "@whatsub/license",
  "version": "0.1.0",
  "private": true,
  "description": "License key issuance + activation backend for whatsub. Hono + Postgres on Node 20.",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@hono/node-server": "^1.13.0",
    "hono": "^4.6.0",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "@types/pg": "^8.11.0",
    "pg-mem": "^3.0.4",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
.env
.env.local
*.log
coverage/
```

- [ ] **Step 4: Create a one-line `README.md`**

```markdown
# whatsub-license

License key activation backend for whatSub. Hono + Postgres. Replaces the
old Cloudflare Workers `license-server/` (deleted after this migration).
See repo root `docs/superpowers/specs/2026-05-09-whatsub-landing-page-design.md` §7 for architecture.
```

- [ ] **Step 5: Install + verify**

Run: `cd whatsub-license && pnpm install`
Expected: completes without error, creates `pnpm-lock.yaml` and `node_modules/`.

Run: `pnpm typecheck`
Expected: PASS (no source files yet, so compiler exits clean).

- [ ] **Step 6: Commit**

```bash
git add whatsub-license/
git commit -m "feat(license): scaffold whatsub-license package (Hono + pg)"
```

---

### Task 2: Add the Postgres schema

**Files:**
- Create: `whatsub-license/schema.sql`
- Create: `whatsub-license/tests/schema.test.ts`

Port from `license-server/schema.sql` (SQLite) → Postgres dialect.

- [ ] **Step 1: Write the failing test**

Create `whatsub-license/tests/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'schema.sql');

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
    db.public.none(
      `INSERT INTO activations (license_key, fingerprint, device_label,
                                activated_at, last_seen_at, deactivated_at)
       VALUES ('WHATSUB-XXXX-XXXX-XXXX-XXXX', 'a'.repeat(64), 'mac',
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test schema.test`
Expected: FAIL with `ENOENT: no such file or directory ... schema.sql`.

- [ ] **Step 3: Write `schema.sql`**

Create `whatsub-license/schema.sql`:

```sql
-- whatsub license server schema (Postgres dialect).
--
-- Apply with:
--   docker compose -f /opt/enghub/docker-compose.yml exec -T postgres \
--     psql -U whatsub_license_user -d whatsub_license < schema.sql
--
-- Ported from the old D1 SQLite schema. Differences:
--   - INTEGER PRIMARY KEY AUTOINCREMENT  →  BIGSERIAL PRIMARY KEY
--   - All ms timestamps stay BIGINT (matches the JS Date.now() the routes use)
--   - Foreign key enforced by default (no PRAGMA needed)

CREATE TABLE IF NOT EXISTS licenses (
    key          TEXT     PRIMARY KEY,
    max_devices  INTEGER  NOT NULL DEFAULT 3,
    created_at   BIGINT   NOT NULL,
    buyer_note   TEXT,
    email        TEXT
);

CREATE TABLE IF NOT EXISTS activations (
    id              BIGSERIAL  PRIMARY KEY,
    license_key     TEXT       NOT NULL REFERENCES licenses(key),
    fingerprint     TEXT       NOT NULL,
    device_label    TEXT,
    activated_at    BIGINT     NOT NULL,
    last_seen_at    BIGINT     NOT NULL,
    deactivated_at  BIGINT,

    UNIQUE (license_key, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_act_key      ON activations (license_key);
CREATE INDEX IF NOT EXISTS idx_act_active   ON activations (license_key, deactivated_at);
CREATE INDEX IF NOT EXISTS idx_lic_created  ON licenses    (created_at DESC);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test schema.test`
Expected: PASS, both tests green.

- [ ] **Step 5: Commit**

```bash
git add whatsub-license/schema.sql whatsub-license/tests/schema.test.ts
git commit -m "feat(license): add Postgres schema + pg-mem test"
```

---

### Task 3: Add the type-shared row interfaces

**Files:**
- Create: `whatsub-license/src/lib/types.ts`

Defines the row shapes used by every route. No tests — pure type definitions.

- [ ] **Step 1: Write the file**

```typescript
// whatsub-license/src/lib/types.ts

/** One issued license key. */
export interface LicenseRow {
  key: string;
  max_devices: number;
  created_at: number; // unix ms
  buyer_note: string | null;
  email: string | null;
}

/** One (license, device) activation slot. */
export interface ActivationRow {
  id: number; // BIGSERIAL — fits in JS number for the foreseeable future
  license_key: string;
  fingerprint: string;
  device_label: string | null;
  activated_at: number; // unix ms
  last_seen_at: number; // unix ms
  deactivated_at: number | null; // unix ms; null = slot still active
}

/** A license + an aggregate count, for the admin license-list endpoint. */
export interface LicenseListItem extends LicenseRow {
  active_devices: number;
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add whatsub-license/src/lib/types.ts
git commit -m "feat(license): add row type interfaces"
```

---

## Phase 2 — Database access layer

### Task 4: Build the pg pool wrapper + tests

**Files:**
- Create: `whatsub-license/src/lib/db.ts`
- Create: `whatsub-license/tests/db.test.ts`

The DB module exposes a `Database` class (or factory function) that wraps a `pg.Pool` and provides typed helpers matching the old `license-server/src/lib/db.ts` API. The tests use pg-mem to exercise queries without a real Postgres.

- [ ] **Step 1: Write the failing test**

Create `whatsub-license/tests/db.test.ts`:

```typescript
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
    const { items: byNote } = await db.listLicenses({
      search: 'xianyu', limit: 10, offset: 0,
    });
    expect(byNote).toHaveLength(1);
    expect(byNote[0].key).toBe('AAA');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test db.test`
Expected: FAIL with `Cannot find module '../src/lib/db.js'`.

- [ ] **Step 3: Implement `db.ts`**

Create `whatsub-license/src/lib/db.ts`:

```typescript
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
      where = `WHERE l.key ILIKE $1 OR l.buyer_note ILIKE $1 OR l.email ILIKE $1`;
      params.push(`%${search}%`);
    }

    // total
    const totalQ = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM licenses l ${where}`,
      params,
    );
    const total = parseInt(totalQ.rows[0]?.n ?? '0', 10);

    // page
    const limitParam = `$${params.length + 1}`;
    const offsetParam = `$${params.length + 2}`;
    const itemsQ = await this.pool.query<LicenseListItem>(
      `SELECT
         l.key, l.max_devices, l.created_at, l.buyer_note, l.email,
         (SELECT COUNT(*) FROM activations a
          WHERE a.license_key = l.key AND a.deactivated_at IS NULL)::int AS active_devices
       FROM licenses l
       ${where}
       ORDER BY l.created_at DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      [...params, opts.limit, opts.offset],
    );
    return { items: itemsQ.rows, total };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test db.test`
Expected: PASS, all 7 tests green.

If pg-mem rejects `ILIKE` or `::text`/`::int` casts (some versions are strict), adjust by using `LIKE` and removing casts — both work the same in real Postgres. Re-run tests until green.

- [ ] **Step 5: Commit**

```bash
git add whatsub-license/src/lib/db.ts whatsub-license/tests/db.test.ts
git commit -m "feat(license): add typed pg Database wrapper + tests"
```

---

## Phase 3 — Crypto utilities

### Task 5: Port `keygen` (TDD)

**Files:**
- Create: `whatsub-license/src/lib/keygen.ts`
- Create: `whatsub-license/tests/keygen.test.ts`

Functionally identical to `license-server/src/lib/keygen.ts`, but uses Node's `webcrypto` instead of Workers' global `crypto`.

- [ ] **Step 1: Write the failing test**

Create `whatsub-license/tests/keygen.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  generateLicenseKey,
  looksLikeKey,
  normalizeKey,
} from '../src/lib/keygen.js';

describe('keygen', () => {
  it('generateLicenseKey returns a WHATSUB-XXXX-XXXX-XXXX-XXXX shape', () => {
    const k = generateLicenseKey();
    expect(k).toMatch(/^WHATSUB(-[2-9A-HJ-NP-Z]{4}){4}$/);
  });

  it('generateLicenseKey is non-deterministic across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateLicenseKey());
    expect(seen.size).toBe(100); // 31^16 collision space → 100 must all differ
  });

  it('looksLikeKey accepts canonical, rejects junk', () => {
    expect(looksLikeKey('WHATSUB-ABCD-EFGH-JKMN-PQRS')).toBe(true);
    expect(looksLikeKey('whatsub-abcd-efgh-jkmn-pqrs')).toBe(true); // case-insensitive
    expect(looksLikeKey(' WHATSUB-ABCD-EFGH-JKMN-PQRS ')).toBe(true); // trims
    expect(looksLikeKey('GARBAGE')).toBe(false);
    expect(looksLikeKey('WHATSUB-ABCD-EFGH-JKMN')).toBe(false); // missing group
    expect(looksLikeKey('WHATSUB-ABC1-EFGH-JKMN-PQRS')).toBe(false); // '1' excluded
  });

  it('normalizeKey trims + uppercases', () => {
    expect(normalizeKey('  whatsub-abcd-efgh-jkmn-pqrs  ')).toBe(
      'WHATSUB-ABCD-EFGH-JKMN-PQRS',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test keygen.test`
Expected: FAIL with `Cannot find module '../src/lib/keygen.js'`.

- [ ] **Step 3: Implement `keygen.ts`**

Create `whatsub-license/src/lib/keygen.ts`:

```typescript
import { webcrypto } from 'node:crypto';

/**
 * License key generator.
 *
 * Format: WHATSUB-XXXX-XXXX-XXXX-XXXX
 *   - 4 groups of 4 chars from a 31-char alphabet (excludes 0/O/1/I/L)
 *   - 31^16 ≈ 10^24 combinations → trivially unguessable
 *   - "WHATSUB-" prefix makes keys self-identifying when pasted
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const GROUP_LEN = 4;
const NUM_GROUPS = 4;

export function generateLicenseKey(): string {
  const bytes = new Uint8Array(GROUP_LEN * NUM_GROUPS);
  webcrypto.getRandomValues(bytes);

  const chars: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    // Non-null assert is safe: i is bounded by bytes.length above.
    chars.push(ALPHABET[bytes[i]! % ALPHABET.length]!);
  }
  const groups: string[] = [];
  for (let g = 0; g < NUM_GROUPS; g++) {
    groups.push(chars.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN).join(''));
  }
  return `WHATSUB-${groups.join('-')}`;
}

/** Lightweight format check before hitting the database. */
export function looksLikeKey(s: string): boolean {
  return /^WHATSUB(-[2-9A-HJ-NP-Z]{4}){4}$/i.test(s.trim());
}

/** Normalize for storage / lookup. Uppercase + trim. */
export function normalizeKey(s: string): string {
  return s.trim().toUpperCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test keygen.test`
Expected: PASS, 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add whatsub-license/src/lib/keygen.ts whatsub-license/tests/keygen.test.ts
git commit -m "feat(license): port keygen to node:webcrypto"
```

---

### Task 6: Port `auth` (TDD)

**Files:**
- Create: `whatsub-license/src/lib/auth.ts`
- Create: `whatsub-license/tests/auth.test.ts`

Same constant-time bearer compare as before. Adapter changes: takes a `Headers`-like object instead of a `Request`, since Hono passes the headers object directly.

- [ ] **Step 1: Write the failing test**

Create `whatsub-license/tests/auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { checkAdminAuth } from '../src/lib/auth.js';

describe('checkAdminAuth', () => {
  it('rejects when no ADMIN_TOKEN configured', () => {
    const r = checkAdminAuth('Bearer x', undefined);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('server_missing_admin_token');
  });

  it('rejects when no Bearer header', () => {
    const r = checkAdminAuth(null, 'secret');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_bearer_token');
  });

  it('rejects when Bearer token wrong', () => {
    const r = checkAdminAuth('Bearer wrong', 'secret');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_token');
  });

  it('accepts when Bearer token matches exactly', () => {
    expect(checkAdminAuth('Bearer secret', 'secret').ok).toBe(true);
  });

  it('rejects similar-but-shorter token (length differ)', () => {
    expect(checkAdminAuth('Bearer secre', 'secret').ok).toBe(false);
  });

  it('trims whitespace inside the bearer value', () => {
    expect(checkAdminAuth('Bearer   secret  ', 'secret').ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test auth.test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `auth.ts`**

Create `whatsub-license/src/lib/auth.ts`:

```typescript
/**
 * Bearer-token check for /api/admin/* routes.
 *
 * Constant-time compare so an attacker can't time-attack the token
 * character by character. Same algorithm as the old Worker.
 */
export function checkAdminAuth(
  authorizationHeader: string | null,
  expectedToken: string | undefined,
): { ok: boolean; reason?: string } {
  if (!expectedToken) {
    return { ok: false, reason: 'server_missing_admin_token' };
  }
  if (!authorizationHeader) {
    return { ok: false, reason: 'no_bearer_token' };
  }
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader);
  if (!match) return { ok: false, reason: 'no_bearer_token' };
  const provided = match[1]!.trim();
  return constantTimeEqual(provided, expectedToken)
    ? { ok: true }
    : { ok: false, reason: 'bad_token' };
}

function constantTimeEqual(a: string, b: string): boolean {
  // Pad to longer length so loop count itself doesn't leak info.
  const len = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    mismatch |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return mismatch === 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test auth.test`
Expected: PASS, 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add whatsub-license/src/lib/auth.ts whatsub-license/tests/auth.test.ts
git commit -m "feat(license): port checkAdminAuth (constant-time bearer compare)"
```

---

## Phase 4 — Activate route (4 scenarios, TDD)

The activate route has 4 distinct execution paths from `license-server/src/routes/activate.ts`. Each gets its own test + verification cycle; we build up the route incrementally.

### Task 7: `/api/activate` happy path — new device

**Files:**
- Create: `whatsub-license/src/routes/activate.ts`
- Create: `whatsub-license/tests/activate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `whatsub-license/tests/activate.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, IMemoryDb } from 'pg-mem';
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
  return { app, db, mem };
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test activate.test`
Expected: FAIL — `Cannot find module '../src/routes/activate.js'`.

- [ ] **Step 3: Implement the activate route**

Create `whatsub-license/src/routes/activate.ts`:

```typescript
import { Hono } from 'hono';
import type { Database } from '../lib/db.js';
import type { ActivationRow } from '../lib/types.js';
import { normalizeKey } from '../lib/keygen.js';

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
        await db.bumpActivationLastSeen(existing.id, now);
      }
      return c.json({ status: 'active' });
    }

    // Path 2: brand-new device
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test activate.test`
Expected: PASS — happy path test green.

- [ ] **Step 5: Commit**

```bash
git add whatsub-license/src/routes/activate.ts whatsub-license/tests/activate.test.ts
git commit -m "feat(license): /api/activate happy path — new device gets slot"
```

---

### Task 8: `/api/activate` idempotent re-activation

- [ ] **Step 1: Add the failing test**

Append to `whatsub-license/tests/activate.test.ts` (inside its module, after the existing describe):

```typescript
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
    expect((await r2.json() as any).status).toBe('active');

    const active = await db.listActiveActivations('WHATSUB-BBBB-BBBB-BBBB-BBBB');
    expect(active).toHaveLength(1); // not 2 — same fingerprint
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm test activate.test`
Expected: **PASS already** — Path 1 (existing-row + bump last_seen_at) was implemented in Task 7. This test just verifies that branch was right.

If it fails, the existing-row branch has a bug; fix `activate.ts` and re-run.

- [ ] **Step 3: Commit**

```bash
git add whatsub-license/tests/activate.test.ts
git commit -m "test(license): /api/activate is idempotent for same fingerprint"
```

---

### Task 9: `/api/activate` device_limit response

- [ ] **Step 1: Add the failing test**

Append to `whatsub-license/tests/activate.test.ts`:

```typescript
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
    expect(body.devices[0].fingerprintTail).toHaveLength(6);
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
```

- [ ] **Step 2: Run test**

Run: `pnpm test activate.test`
Expected: **PASS** — both branches were already implemented in Task 7.

- [ ] **Step 3: Commit**

```bash
git add whatsub-license/tests/activate.test.ts
git commit -m "test(license): /api/activate enforces device_limit + redacts fingerprints"
```

---

### Task 10: `/api/activate` validation errors

- [ ] **Step 1: Add the failing test**

Append to `whatsub-license/tests/activate.test.ts`:

```typescript
describe('POST /api/activate — validation', () => {
  it('returns 404 invalid_key for unknown key', async () => {
    const { app } = makeApp();
    const res = await activate(app, {
      key: 'WHATSUB-XXXX-XXXX-XXXX-XXXX', fingerprint: FP,
    });
    expect(res.status).toBe(404);
    expect((await res.json() as any).status).toBe('invalid_key');
  });

  it('rejects malformed JSON body with 400 bad_request', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.status).toBe('bad_request');
    expect(body.detail).toBe('invalid_json');
  });

  it('rejects missing key/fingerprint with 400', async () => {
    const { app } = makeApp();
    const res = await activate(app, { key: '', fingerprint: '' });
    expect(res.status).toBe(400);
    expect((await res.json() as any).detail).toBe('missing_key_or_fingerprint');
  });

  it('rejects fingerprint not 64 hex chars with 400', async () => {
    const { app, db } = makeApp();
    await db.insertLicense({
      key: 'K', max_devices: 3, created_at: 1, buyer_note: null, email: null,
    });
    const res = await activate(app, { key: 'K', fingerprint: 'not-hex' });
    expect(res.status).toBe(400);
    expect((await res.json() as any).detail).toBe('fingerprint_not_hex64');
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm test activate.test`
Expected: **PASS** — all 4 validation branches are in the route already.

- [ ] **Step 3: Commit**

```bash
git add whatsub-license/tests/activate.test.ts
git commit -m "test(license): /api/activate validation paths covered"
```

---

## Phase 5 — Admin routes (TDD)

### Task 11: `/api/admin/whoami` (auth gate)

**Files:**
- Create: `whatsub-license/src/routes/admin.ts`
- Create: `whatsub-license/tests/admin.test.ts`

The admin namespace is auth-gated with the same Bearer-token check on every request. We start with the simplest endpoint (`whoami`) to land the auth middleware.

- [ ] **Step 1: Write the failing test**

Create `whatsub-license/tests/admin.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, IMemoryDb } from 'pg-mem';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { Database } from '../src/lib/db.js';
import { adminRoutes } from '../src/routes/admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'sekret-token-very-long';

function makeApp() {
  const mem = newDb();
  const sql = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf-8');
  mem.public.none(sql);
  const adapter = mem.adapters.createPg();
  const db = new Database(new adapter.Pool());
  const app = new Hono();
  app.route('/api/admin', adminRoutes(db, TOKEN));
  return { app, db };
}

const authHeader = (t = TOKEN) => ({ Authorization: `Bearer ${t}` });

describe('GET /api/admin/whoami', () => {
  it('returns 401 without auth', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/whoami');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong token', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/whoami', {
      headers: authHeader('wrong'),
    });
    expect(res.status).toBe(401);
  });

  it('returns { ok: true } with correct token', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/whoami', { headers: authHeader() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test admin.test`
Expected: FAIL — `Cannot find module '../src/routes/admin.js'`.

- [ ] **Step 3: Implement `admin.ts` with auth middleware + `/whoami`**

Create `whatsub-license/src/routes/admin.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test admin.test`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add whatsub-license/src/routes/admin.ts whatsub-license/tests/admin.test.ts
git commit -m "feat(license): /api/admin auth middleware + /whoami"
```

---

### Task 12: `/api/admin/issue`

- [ ] **Step 1: Add the failing tests**

Append to `whatsub-license/tests/admin.test.ts`:

```typescript
describe('POST /api/admin/issue', () => {
  it('returns N freshly-minted keys', async () => {
    const { app, db } = makeApp();
    const res = await app.request('/api/admin/issue', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 3, buyerNote: 'xianyu-001' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[] };
    expect(body.keys).toHaveLength(3);
    expect(body.keys[0]).toMatch(/^WHATSUB(-[2-9A-HJ-NP-Z]{4}){4}$/);
    // Side effect: 3 rows in DB with the buyer_note
    const { items } = await db.listLicenses({ search: 'xianyu', limit: 10, offset: 0 });
    expect(items).toHaveLength(3);
  });

  it('clamps count to [1, 50]', async () => {
    const { app, db } = makeApp();
    const r0 = await app.request('/api/admin/issue', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 9999 }),
    });
    expect(r0.status).toBe(200);
    expect(((await r0.json()) as any).keys).toHaveLength(50);

    const r1 = await app.request('/api/admin/issue', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 0 }),
    });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as any).keys).toHaveLength(1);
  });

  it('clamps maxDevices to [1, 20], default 3', async () => {
    const { app, db } = makeApp();
    await app.request('/api/admin/issue', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 1, maxDevices: 100 }),
    });
    const { items } = await db.listLicenses({ search: '', limit: 10, offset: 0 });
    expect(items[0].max_devices).toBe(20);
  });

  it('rejects malformed JSON', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/issue', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm test admin.test`
Expected: FAIL — issue route not implemented.

- [ ] **Step 3: Implement issue endpoint**

Append to `whatsub-license/src/routes/admin.ts` (before `return app`):

```typescript
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
```

- [ ] **Step 4: Run test**

Run: `pnpm test admin.test`
Expected: PASS — all issue tests green.

- [ ] **Step 5: Commit**

```bash
git add whatsub-license/src/routes/admin.ts whatsub-license/tests/admin.test.ts
git commit -m "feat(license): /api/admin/issue with sanity clamps"
```

---

### Task 13: `/api/admin/licenses` list + search + pagination

- [ ] **Step 1: Add the failing tests**

Append to `whatsub-license/tests/admin.test.ts`:

```typescript
describe('GET /api/admin/licenses', () => {
  it('returns paginated list with total + page metadata', async () => {
    const { app, db } = makeApp();
    for (let i = 0; i < 7; i++) {
      await db.insertLicense({
        key: `K-${i}`, max_devices: 3, created_at: i,
        buyer_note: null, email: null,
      });
    }
    const res = await app.request('/api/admin/licenses?page=1', { headers: authHeader() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ key: string; active_devices: number }>;
      total: number; page: number; pageSize: number;
    };
    expect(body.total).toBe(7);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(body.items).toHaveLength(7);
    // Sorted descending by created_at
    expect(body.items[0].key).toBe('K-6');
  });

  it('search param filters by key or buyer_note', async () => {
    const { app, db } = makeApp();
    await db.insertLicense({
      key: 'K-A', max_devices: 3, created_at: 1, buyer_note: 'xianyu', email: null,
    });
    await db.insertLicense({
      key: 'K-B', max_devices: 3, created_at: 2, buyer_note: 'xhs', email: null,
    });
    const res = await app.request('/api/admin/licenses?search=xianyu', {
      headers: authHeader(),
    });
    const body = (await res.json()) as { items: Array<{ key: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0].key).toBe('K-A');
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm test admin.test`
Expected: FAIL — list endpoint not implemented.

- [ ] **Step 3: Implement list endpoint**

Append to `whatsub-license/src/routes/admin.ts`:

```typescript
  app.get('/licenses', async (c) => {
    const search = c.req.query('search') ?? '';
    const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
    const pageSize = 50;
    const { items, total } = await db.listLicenses({
      search, limit: pageSize, offset: (page - 1) * pageSize,
    });
    return c.json({ items, total, page, pageSize });
  });
```

- [ ] **Step 4: Run test**

Run: `pnpm test admin.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add whatsub-license/src/routes/admin.ts whatsub-license/tests/admin.test.ts
git commit -m "feat(license): /api/admin/licenses list with search + pagination"
```

---

### Task 14: `/api/admin/licenses/:key` detail + activations

- [ ] **Step 1: Add the failing tests**

Append to `whatsub-license/tests/admin.test.ts`:

```typescript
describe('GET /api/admin/licenses/:key', () => {
  it('returns license + activations with redacted fingerprintTail', async () => {
    const { app, db } = makeApp();
    await db.insertLicense({
      key: 'K-DETAIL', max_devices: 3, created_at: 1,
      buyer_note: 'note', email: null,
    });
    await db.insertActivation({
      license_key: 'K-DETAIL',
      fingerprint: 'abcdef'.repeat(10) + 'abcd',
      device_label: 'mac',
      activated_at: 100, last_seen_at: 100, deactivated_at: null,
    });
    const res = await app.request('/api/admin/licenses/K-DETAIL', {
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      license: { key: string };
      activations: Array<{ fingerprintTail: string }>;
    };
    expect(body.license.key).toBe('K-DETAIL');
    expect(body.activations).toHaveLength(1);
    expect(body.activations[0].fingerprintTail).toHaveLength(6);
  });

  it('returns 404 for unknown key', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/licenses/NOPE', {
      headers: authHeader(),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm test admin.test`
Expected: FAIL — detail endpoint not implemented.

- [ ] **Step 3: Implement detail endpoint**

Append to `whatsub-license/src/routes/admin.ts`:

```typescript
  app.get('/licenses/:key', async (c) => {
    const key = c.req.param('key');
    const license = await db.findLicense(key);
    if (!license) return c.json({ error: 'not_found' }, 404);
    const activations = await db.listAllActivations(key);
    return c.json({
      license,
      activations: activations.map((a) => ({
        ...a,
        fingerprintTail: a.fingerprint.slice(-6),
      })),
    });
  });
```

- [ ] **Step 4: Run test**

Run: `pnpm test admin.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add whatsub-license/src/routes/admin.ts whatsub-license/tests/admin.test.ts
git commit -m "feat(license): /api/admin/licenses/:key returns detail + redacted activations"
```

---

### Task 15: `/api/admin/activations/:id/deactivate`

- [ ] **Step 1: Add the failing tests**

Append to `whatsub-license/tests/admin.test.ts`:

```typescript
describe('POST /api/admin/activations/:id/deactivate', () => {
  it('soft-deactivates the slot', async () => {
    const { app, db } = makeApp();
    await db.insertLicense({
      key: 'K-DA', max_devices: 3, created_at: 1, buyer_note: null, email: null,
    });
    await db.insertActivation({
      license_key: 'K-DA', fingerprint: 'a'.repeat(64), device_label: 'old',
      activated_at: 100, last_seen_at: 100, deactivated_at: null,
    });
    const a = await db.findActivation('K-DA', 'a'.repeat(64));
    const res = await app.request(
      `/api/admin/activations/${a!.id}/deactivate`,
      { method: 'POST', headers: authHeader() },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const active = await db.listActiveActivations('K-DA');
    expect(active).toHaveLength(0);
  });

  it('returns 400 for non-numeric id', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/activations/not-a-number/deactivate', {
      method: 'POST', headers: authHeader(),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm test admin.test`
Expected: FAIL — deactivate endpoint not implemented.

- [ ] **Step 3: Implement deactivate endpoint**

Append to `whatsub-license/src/routes/admin.ts`:

```typescript
  app.post('/activations/:id/deactivate', async (c) => {
    const idStr = c.req.param('id');
    const id = parseInt(idStr, 10);
    if (!Number.isFinite(id) || idStr !== String(id)) {
      return c.json({ error: 'bad_id' }, 400);
    }
    await db.softDeactivate(id, Date.now());
    return c.json({ ok: true });
  });
```

- [ ] **Step 4: Run test**

Run: `pnpm test admin.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add whatsub-license/src/routes/admin.ts whatsub-license/tests/admin.test.ts
git commit -m "feat(license): /api/admin/activations/:id/deactivate"
```

---

## Phase 6 — Download + version routes

### Task 16: `/download/win` + `/download/mac` (302 redirect with cache)

**Files:**
- Create: `whatsub-license/src/routes/download.ts`
- Create: `whatsub-license/tests/download.test.ts`

- [ ] **Step 1: Write the failing test**

Create `whatsub-license/tests/download.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { downloadRoutes, latestRoute, _resetCache } from '../src/routes/download.js';

const FAKE_LATEST_JSON = {
  version: '0.1.99',
  pub_date: '2026-05-09T00:00:00Z',
  platforms: {
    'windows-x86_64': { url: 'https://jihulab.com/.../whatsub_x64-setup.exe', signature: 'sig' },
    'darwin-aarch64': { url: 'https://jihulab.com/.../whatsub_aarch64.dmg',   signature: 'sig' },
  },
};

beforeEach(() => {
  _resetCache();
  vi.spyOn(global, 'fetch').mockImplementation(async () => {
    return new Response(JSON.stringify(FAKE_LATEST_JSON), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

function makeApp() {
  const app = new Hono();
  app.route('/download', downloadRoutes());
  app.route('/api', latestRoute());
  return app;
}

describe('GET /download/win', () => {
  it('redirects 302 to the latest Windows .exe URL', async () => {
    const res = await makeApp().request('/download/win');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://jihulab.com/.../whatsub_x64-setup.exe',
    );
  });

  it('falls back to GitHub mirror when upstream fetch throws', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('net'));
    _resetCache();
    const res = await makeApp().request('/download/win');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/github.com\/rjxznb\/whatsub-releases/);
  });
});

describe('GET /download/mac', () => {
  it('redirects 302 to the latest Mac .dmg URL', async () => {
    const res = await makeApp().request('/download/mac');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://jihulab.com/.../whatsub_aarch64.dmg',
    );
  });
});

describe('GET /api/latest', () => {
  it('returns the wrapped JSON for the website', async () => {
    const res = await makeApp().request('/api/latest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; winUrl: string; macUrl: string };
    expect(body.version).toBe('0.1.99');
    expect(body.winUrl).toContain('whatsub_x64-setup.exe');
    expect(body.macUrl).toContain('whatsub_aarch64.dmg');
  });

  it('returns 503 when upstream is unreachable', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('net'));
    _resetCache();
    const res = await makeApp().request('/api/latest');
    expect(res.status).toBe(503);
  });
});

describe('caching', () => {
  it('does NOT re-fetch within the cache window', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const app = makeApp();
    await app.request('/api/latest');
    await app.request('/api/latest');
    await app.request('/download/win');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test download.test`
Expected: FAIL — `Cannot find module '../src/routes/download.js'`.

- [ ] **Step 3: Implement download + latest routes**

Create `whatsub-license/src/routes/download.ts`:

```typescript
import { Hono } from 'hono';

const LATEST_JSON_URL =
  'https://jihulab.com/rjxznb-group/whatsub-release/-/releases/permalink/latest/downloads/latest.json';
const GITHUB_FALLBACK_BASE =
  'https://github.com/rjxznb/whatsub-releases/releases/latest/download';

interface LatestJson {
  version: string;
  pub_date?: string;
  platforms: Record<string, { url: string; signature?: string }>;
}

let cached: { data: LatestJson; expiresAt: number } | null = null;

/** Test hook — reset the in-process cache between cases. */
export function _resetCache() {
  cached = null;
}

async function fetchLatest(): Promise<LatestJson> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.data;
  const res = await fetch(LATEST_JSON_URL, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`latest.json fetch failed: ${res.status}`);
  const data = (await res.json()) as LatestJson;
  cached = { data, expiresAt: now + 60_000 };
  return data;
}

export function downloadRoutes() {
  const app = new Hono();

  app.get('/win', async (c) => {
    try {
      const latest = await fetchLatest();
      return c.redirect(latest.platforms['windows-x86_64']!.url, 302);
    } catch {
      return c.redirect(`${GITHUB_FALLBACK_BASE}/whatsub_x64-setup.exe`, 302);
    }
  });

  app.get('/mac', async (c) => {
    try {
      const latest = await fetchLatest();
      return c.redirect(latest.platforms['darwin-aarch64']!.url, 302);
    } catch {
      return c.redirect(`${GITHUB_FALLBACK_BASE}/whatsub_aarch64.dmg`, 302);
    }
  });

  return app;
}

export function latestRoute() {
  const app = new Hono();

  app.get('/latest', async (c) => {
    try {
      const latest = await fetchLatest();
      return c.json({
        version: latest.version,
        pubDate: latest.pub_date ?? null,
        winUrl: latest.platforms['windows-x86_64']?.url ?? null,
        macUrl: latest.platforms['darwin-aarch64']?.url ?? null,
      });
    } catch {
      return c.json({ version: null, error: 'upstream_unavailable' }, 503);
    }
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test download.test`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add whatsub-license/src/routes/download.ts whatsub-license/tests/download.test.ts
git commit -m "feat(license): /download/{win,mac} + /api/latest with 60s cache + GH fallback"
```

---

## Phase 7 — Wire it all together

### Task 17: Hono app entry — compose all routes + serve admin SPA

**Files:**
- Create: `whatsub-license/src/index.ts`
- Create: `whatsub-license/public/admin/index.html` (placeholder; real content lands in Task 18)
- Create: `whatsub-license/tests/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `whatsub-license/tests/index.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/lib/db.js';
import { buildApp } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeApp() {
  const mem = newDb();
  mem.public.none(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf-8'));
  const adapter = mem.adapters.createPg();
  const db = new Database(new adapter.Pool());
  return buildApp(db, 'TOKEN');
}

describe('buildApp routing', () => {
  it('mounts /api/activate', async () => {
    const app = makeApp();
    const res = await app.request('/api/activate', { method: 'GET' });
    // Hono auto-405s a wrong-method route; we just need NOT-404.
    expect(res.status).not.toBe(404);
  });

  it('mounts /api/admin/* under auth', async () => {
    const app = makeApp();
    const res = await app.request('/api/admin/whoami');
    expect(res.status).toBe(401); // proves middleware wired up
  });

  it('mounts /download/win', async () => {
    const app = makeApp();
    // We don't care about upstream — just route exists.
    const res = await app.request('/download/win');
    expect([200, 302, 503]).toContain(res.status);
  });

  it('mounts /api/latest', async () => {
    const app = makeApp();
    const res = await app.request('/api/latest');
    expect([200, 503]).toContain(res.status);
  });

  it('redirects bare / to /admin/', async () => {
    const app = makeApp();
    const res = await app.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/\/admin\/?$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test index.test`
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 3: Implement `src/index.ts`**

Create `whatsub-license/src/index.ts`:

```typescript
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import pg from 'pg';
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
const isMain = import.meta.url === `file://${process.argv[1]}`;
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
```

- [ ] **Step 4: Add a placeholder admin/index.html so serveStatic has something to serve**

Create `whatsub-license/public/admin/index.html`:

```html
<!doctype html>
<html><body><p>Admin SPA — placeholder. Real content in Task 18.</p></body></html>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS — all tests across all files green.

- [ ] **Step 6: Run typecheck + build**

Run: `pnpm typecheck`
Expected: PASS (no errors).

Run: `pnpm build`
Expected: PASS, produces `dist/index.js`.

- [ ] **Step 7: Commit**

```bash
git add whatsub-license/src/index.ts whatsub-license/public/admin/ whatsub-license/tests/index.test.ts
git commit -m "feat(license): compose Hono app entry — routes + admin static + CLI"
```

---

### Task 18: Port the admin SPA from license-server/

**Files:**
- Modify: `whatsub-license/public/admin/index.html`

The Alpine.js + Tailwind admin SPA from `license-server/public/admin/index.html` is portable verbatim. Only change: the hardcoded API base URL.

- [ ] **Step 1: Copy the admin SPA**

```bash
cp license-server/public/admin/index.html whatsub-license/public/admin/index.html
```

- [ ] **Step 2: Update the API base URL**

Open `whatsub-license/public/admin/index.html` and find the constant that points the SPA at the API. In the old file it's typically `const API_BASE = ''` (same-origin). Verify it's still same-origin (it is, since nginx routes both `/admin/` and `/api/` to the same container). If there's any hardcoded `whatsub-license.<sub>.workers.dev` URL, replace it with `''` (empty string → relative path → same origin).

Run a sanity check:

```bash
grep -nE "workers.dev|http(s)?://" whatsub-license/public/admin/index.html | grep -v "^//" || true
```

Expected: no matches pointing at the old Workers domain (only the static CDN URLs for Alpine.js / Tailwind, which are fine).

- [ ] **Step 3: Smoke test — build + run + curl**

Run: `pnpm build && node dist/index.js &`

Wait 1s, then:
```bash
curl -i http://localhost:3002/admin/index.html | head -5
```

Expected: `HTTP/1.1 200 OK` + `Content-Type: text/html`. Stop the server with `kill %1` (or `Ctrl+C` if foreground).

(Skip if `DATABASE_URL`/`ADMIN_TOKEN` aren't set; this is purely a static-asset smoke test.)

- [ ] **Step 4: Commit**

```bash
git add whatsub-license/public/admin/index.html
git commit -m "feat(license): port admin SPA from license-server/ verbatim"
```

---

## Phase 8 — Container packaging

### Task 19: Dockerfile

**Files:**
- Create: `whatsub-license/Dockerfile`
- Create: `whatsub-license/.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
dist
.env
.env.*
*.log
.git
.github
coverage
tests
*.test.ts
.vscode
.idea
```

- [ ] **Step 2: Write the Dockerfile**

Create `whatsub-license/Dockerfile`:

```dockerfile
# Multi-stage build to keep the runtime image small.
# Stage 1: install deps + build TS → dist
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# Stage 2: runtime — only dist + node_modules + public
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY public ./public
EXPOSE 3002
# tini for proper signal handling on container stop
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Build the image locally**

Run: `cd whatsub-license && docker build -t whatsub-license:latest .`
Expected: builds successfully. Final image size should be ~80-120 MB.

Verify:
```bash
docker images whatsub-license
```
Expected: shows the image with `latest` tag.

- [ ] **Step 4: Smoke test the image**

Run a quick test that the container starts (will exit with FATAL since no DB, but confirms the binary runs):

```bash
docker run --rm whatsub-license:latest
```

Expected: exits with `FATAL: DATABASE_URL not set`. That's correct — we just want to confirm the entrypoint fires.

- [ ] **Step 5: Commit**

```bash
git add whatsub-license/Dockerfile whatsub-license/.dockerignore
git commit -m "feat(license): multi-stage Dockerfile (node:20-alpine + tini)"
```

---

### Task 20: docker-compose.yml + .env.example

**Files:**
- Create: `whatsub-license/docker-compose.yml`
- Create: `whatsub-license/.env.example`

This compose file is the **source of truth**; at deploy time it's copied to `/opt/whatsub/docker-compose.yml` on the server.

- [ ] **Step 1: Write the compose**

Create `whatsub-license/docker-compose.yml`:

```yaml
# whatsub services compose. Lives at /opt/whatsub/docker-compose.yml on the server.
# Source of truth: whatsub-license/docker-compose.yml in the repo.
#
# This compose joins enghub's existing Docker network as `external: true` so
# the container can talk to enghub's nginx + postgres without owning either.
# enghub's compose stays untouched (after the one-time nginx-mount migration
# in the spec §9.4).

services:
  whatsub-license:
    image: whatsub-license:latest
    container_name: whatsub-license
    restart: unless-stopped
    environment:
      DATABASE_URL: ${WHATSUB_LICENSE_DATABASE_URL}
      ADMIN_TOKEN:  ${WHATSUB_LICENSE_ADMIN_TOKEN}
      PORT: 3002
      NODE_ENV: production
    networks:
      - default

networks:
  default:
    name: enghub_default
    external: true
```

- [ ] **Step 2: Write the env example**

Create `whatsub-license/.env.example`:

```
# Copy to /opt/whatsub/.env on the server (chmod 600).
# Generate strong random values — these gate the entire admin namespace
# and the database access.

# Postgres connection string. The user + password must match what was
# created in the schema-init step (spec §9.4 step 4).
WHATSUB_LICENSE_DATABASE_URL=postgres://whatsub_license_user:CHANGE_ME@postgres:5432/whatsub_license

# Admin SPA login token. Generate with:
#   openssl rand -hex 32
WHATSUB_LICENSE_ADMIN_TOKEN=CHANGE_ME
```

- [ ] **Step 3: Validate the compose syntax**

Run: `docker compose -f whatsub-license/docker-compose.yml config --quiet`
Expected: returns 0, no syntax errors. (Will warn about missing env vars but that's expected for a config-only check.)

- [ ] **Step 4: Commit**

```bash
git add whatsub-license/docker-compose.yml whatsub-license/.env.example
git commit -m "feat(license): docker-compose.yml (joins enghub_default external)"
```

---

### Task 21: nginx server block

**Files:**
- Create: `whatsub-license/nginx/whatsub.conf`

Source of truth for the nginx config — copied to `/data/nginx-conf.d/whatsub.conf` on the server at deploy time.

- [ ] **Step 1: Write the nginx conf**

Create `whatsub-license/nginx/whatsub.conf`:

```nginx
# whatsub.eversay.cc — landing page + license API.
# Source of truth: whatsub-license/nginx/whatsub.conf in the repo.
# Deployed to /data/nginx-conf.d/whatsub.conf on the server, mounted into
# the existing enghub nginx container at /etc/nginx/conf.d/whatsub.conf.
# nginx auto-loads everything in conf.d/ so this co-exists with eversay.conf.

server {
    listen 443 ssl http2;
    server_name whatsub.eversay.cc;

    # The cert covers eversay.cc + www.eversay.cc + whatsub.eversay.cc
    # after `certbot --expand` (run once during first-time setup).
    ssl_certificate     /etc/letsencrypt/live/eversay.cc/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/eversay.cc/privkey.pem;

    # License API + version proxy → Hono container
    location /api/license/ {
        proxy_pass         http://whatsub-license:3002/api/;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }

    # Download redirects → same container, separate path
    location /download/ {
        proxy_pass         http://whatsub-license:3002/download/;
        proxy_set_header   Host $host;
    }

    # Admin SPA → same container
    location /admin/ {
        proxy_pass         http://whatsub-license:3002/admin/;
        proxy_set_header   Host $host;
    }

    # Static marketing site — served directly by nginx (no proxy).
    # The /data/whatsub-web/ volume is populated by the marketing-site
    # plan (separate plan); for now an empty dir is fine — the API
    # endpoints above work either way.
    root /data/whatsub-web;
    index index.html;

    location / {
        try_files $uri $uri.html $uri/index.html /index.html =404;
    }

    location /_next/static/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    gzip on;
    gzip_types text/css text/javascript application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}

# HTTP → HTTPS redirect
server {
    listen 80;
    server_name whatsub.eversay.cc;
    return 301 https://$host$request_uri;
}
```

- [ ] **Step 2: Lint the conf locally with the nginx image**

Run:
```bash
docker run --rm -v "$(pwd)/whatsub-license/nginx:/etc/nginx/conf.d:ro" \
    --entrypoint nginx nginx:1.25-alpine -t -c /dev/null 2>&1 | tail -10
```

Expected: nginx will complain about missing cert files (fine — they only exist on the server). What we care about is no **syntax** errors. If the output mentions `unknown directive` or `directive ... is not allowed`, fix the conf and re-run.

(This step is a sanity-check; the real test happens during the server-side `nginx -t` reload in §9.4.)

- [ ] **Step 3: Commit**

```bash
git add whatsub-license/nginx/whatsub.conf
git commit -m "feat(license): nginx server block for whatsub.eversay.cc"
```

---

## Phase 9 — Server-side prep (one-time, manual on Aliyun)

These tasks run on the live server. They are **not idempotent** in the strict sense (e.g. `certbot --expand` succeeds once); each step explicitly says how to verify it succeeded.

> **Before starting Phase 9**, confirm: SSH access works (`ssh -i ~/.ssh/id_ed25519 root@47.93.87.206 'echo ok'` returns `ok`), and 家兴 has the strong random password + admin token ready (generated locally with `openssl rand -hex 16` and `openssl rand -hex 32`).

### Task 22: Audit current enghub nginx mount

**Files:** none (read-only inspection)

Find where enghub currently keeps its nginx conf so we know what to migrate.

- [ ] **Step 1: SSH in and inspect**

```bash
ssh -i ~/.ssh/id_ed25519 root@47.93.87.206
```

- [ ] **Step 2: Inspect the existing nginx volume mounts**

Run on the server:
```bash
docker compose -f /opt/enghub/docker-compose.yml config | grep -A 20 'nginx:'
```

Expected output: shows the `nginx` service definition with its `volumes:` list. Look for the volume that maps something to `/etc/nginx/conf.d` (e.g. `/opt/enghub/nginx/conf.d:/etc/nginx/conf.d:ro` or similar).

Record the exact source path. This is the path you'll be migrating from.

- [ ] **Step 3: Note current conf files**

```bash
ls -la /opt/enghub/nginx/conf.d/  # adjust path based on Step 2
```

Expected: lists the existing `eversay.conf` (or whatever it's named).

- [ ] **Step 4: Sanity-check enghub still serves traffic**

```bash
curl -I https://eversay.cc | head -3
```

Expected: `HTTP/2 200`.

(No commit — read-only step.)

---

### Task 23: Migrate enghub nginx mount to shared dir + restart

**Files:**
- Modify on server: `/opt/enghub/docker-compose.yml`
- Move on server: existing `eversay.conf` to `/data/nginx-conf.d/`

**This is the only step that touches enghub.** After it, the two products are independent forever.

- [ ] **Step 1: Create the shared dir + copy enghub's existing conf**

Run on the server:
```bash
mkdir -p /data/nginx-conf.d
cp /opt/enghub/nginx/conf.d/*.conf /data/nginx-conf.d/   # adjust source path per Task 22
ls /data/nginx-conf.d/   # verify the .conf files copied
```

- [ ] **Step 2: Edit `/opt/enghub/docker-compose.yml`**

Backup first:
```bash
cp /opt/enghub/docker-compose.yml /opt/enghub/docker-compose.yml.bak
```

Edit the `nginx` service. Change the existing conf.d volume from (example):
```yaml
- /opt/enghub/nginx/conf.d:/etc/nginx/conf.d:ro
```
to:
```yaml
- /data/nginx-conf.d:/etc/nginx/conf.d:ro
```

Keep all other volume mounts (TLS certs, html roots, etc.) untouched.

- [ ] **Step 3: Recreate nginx**

```bash
cd /opt/enghub
docker compose up -d --force-recreate nginx
```

- [ ] **Step 4: Verify enghub still serves**

```bash
curl -I https://eversay.cc | head -3
```

Expected: `HTTP/2 200`.

If it fails, **revert immediately**:
```bash
mv /opt/enghub/docker-compose.yml.bak /opt/enghub/docker-compose.yml
docker compose up -d --force-recreate nginx
```
Then debug the volume mount before proceeding.

- [ ] **Step 5: (no commit — server-side change, no repo file changed)**

---

### Task 24: Expand Let's Encrypt cert to cover whatsub subdomain

- [ ] **Step 1: Run certbot expand**

On the server:
```bash
certbot --expand -d eversay.cc -d www.eversay.cc -d whatsub.eversay.cc
```

When prompted, choose to keep the existing webroot path / DNS plugin (whatever Eversay uses).

- [ ] **Step 2: Verify the cert now lists whatsub.eversay.cc**

```bash
openssl x509 -in /etc/letsencrypt/live/eversay.cc/fullchain.pem -text -noout | \
    grep -A 1 'Subject Alternative Name'
```

Expected: includes `DNS:whatsub.eversay.cc`.

- [ ] **Step 3: Reload nginx so it picks up the new cert**

```bash
docker compose -f /opt/enghub/docker-compose.yml exec nginx nginx -t
docker compose -f /opt/enghub/docker-compose.yml exec nginx nginx -s reload
```

Expected: `nginx -t` reports `syntax is ok` + `test is successful`.

(No commit — server-side.)

---

### Task 25: Create whatsub_license database + user

- [ ] **Step 1: Generate a strong DB password**

Locally on your laptop:
```bash
openssl rand -hex 16
# Save this string — you'll need it in Task 27.
```

- [ ] **Step 2: Create database + user**

On the server, with your password substituted in:

```bash
docker compose -f /opt/enghub/docker-compose.yml exec postgres psql -U postgres <<'SQL'
CREATE DATABASE whatsub_license;
CREATE USER whatsub_license_user WITH PASSWORD 'PASTE_GENERATED_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE whatsub_license TO whatsub_license_user;
\c whatsub_license
GRANT ALL ON SCHEMA public TO whatsub_license_user;
SQL
```

(The second `GRANT ALL ON SCHEMA public` is needed in Postgres 15+ — `GRANT ALL PRIVILEGES ON DATABASE` alone doesn't grant table-creation rights anymore.)

- [ ] **Step 3: Verify login works**

```bash
docker compose -f /opt/enghub/docker-compose.yml exec postgres \
    psql "postgres://whatsub_license_user:PASTE_GENERATED_PASSWORD@localhost:5432/whatsub_license" \
    -c "SELECT current_user, current_database();"
```

Expected: returns `whatsub_license_user | whatsub_license`.

(No commit.)

---

### Task 26: Set up `/opt/whatsub/` + .env

- [ ] **Step 1: Create the directory + .env on the server**

```bash
mkdir -p /opt/whatsub
```

Generate the admin token locally:
```bash
openssl rand -hex 32
# Save this string for use here.
```

On the server:
```bash
cat > /opt/whatsub/.env <<'ENV'
WHATSUB_LICENSE_DATABASE_URL=postgres://whatsub_license_user:<DB_PASSWORD_FROM_TASK_25>@postgres:5432/whatsub_license
WHATSUB_LICENSE_ADMIN_TOKEN=<TOKEN_FROM_STEP_1>
ENV
chmod 600 /opt/whatsub/.env
```

- [ ] **Step 2: Verify read perms restricted**

```bash
ls -la /opt/whatsub/.env
```

Expected: `-rw------- 1 root root ... .env`.

(No commit.)

---

## Phase 10 — First deploy + smoke test

### Task 27: Build + ship + load + start the container

**Files:** none on the repo side (all server-side).

- [ ] **Step 1: Build the image locally**

```bash
cd whatsub-license
docker build -t whatsub-license:latest .
docker save whatsub-license:latest | gzip > /tmp/whatsub-license.tar.gz
ls -lh /tmp/whatsub-license.tar.gz   # expect ~30-50 MB compressed
```

- [ ] **Step 2: scp to the server**

```bash
scp -i ~/.ssh/id_ed25519 /tmp/whatsub-license.tar.gz \
    root@47.93.87.206:/tmp/
```

- [ ] **Step 3: Copy compose + nginx conf to the server**

```bash
scp -i ~/.ssh/id_ed25519 \
    whatsub-license/docker-compose.yml \
    root@47.93.87.206:/opt/whatsub/docker-compose.yml
scp -i ~/.ssh/id_ed25519 \
    whatsub-license/nginx/whatsub.conf \
    root@47.93.87.206:/data/nginx-conf.d/whatsub.conf
```

- [ ] **Step 4: Load + start on the server**

```bash
ssh -i ~/.ssh/id_ed25519 root@47.93.87.206 << 'EOF'
    docker load < /tmp/whatsub-license.tar.gz
    cd /opt/whatsub
    docker compose up -d
    rm /tmp/whatsub-license.tar.gz
EOF
```

- [ ] **Step 5: Verify the container is healthy**

```bash
ssh -i ~/.ssh/id_ed25519 root@47.93.87.206 \
    "docker logs --tail 10 whatsub-license"
```

Expected: `whatsub-license listening on :3002`.

- [ ] **Step 6: Reload nginx to pick up the new conf**

```bash
ssh -i ~/.ssh/id_ed25519 root@47.93.87.206 \
    "docker compose -f /opt/enghub/docker-compose.yml exec nginx nginx -t \
     && docker compose -f /opt/enghub/docker-compose.yml exec nginx nginx -s reload"
```

Expected: nginx -t reports `syntax is ok`.

(No commit — server-side state changed, repo files unchanged.)

---

### Task 28: Apply the schema to the new database

- [ ] **Step 1: Pipe `schema.sql` into psql via the postgres container**

From your local machine:

```bash
ssh -i ~/.ssh/id_ed25519 root@47.93.87.206 \
    "docker compose -f /opt/enghub/docker-compose.yml exec -T postgres \
     psql -U whatsub_license_user -d whatsub_license" \
    < whatsub-license/schema.sql
```

Expected: emits `CREATE TABLE` lines, no errors.

- [ ] **Step 2: Verify the tables exist**

```bash
ssh -i ~/.ssh/id_ed25519 root@47.93.87.206 \
    "docker compose -f /opt/enghub/docker-compose.yml exec -T postgres \
     psql -U whatsub_license_user -d whatsub_license -c '\\dt'"
```

Expected: shows `licenses` and `activations` tables.

- [ ] **Step 3: Smoke test the API end-to-end**

From your local machine:

```bash
# Should fail auth (no token)
curl -i https://whatsub.eversay.cc/api/license/admin/whoami | head -3
```

Expected: `HTTP/2 401`.

```bash
# With the right token (substitute your value)
curl -i -H "Authorization: Bearer <TOKEN>" \
    https://whatsub.eversay.cc/api/license/admin/whoami | head -3
```

Expected: `HTTP/2 200` + body `{"ok":true}`.

```bash
# Issue a test license key
curl -X POST -H "Authorization: Bearer <TOKEN>" \
    -H "Content-Type: application/json" \
    -d '{"count":1,"buyerNote":"e2e-smoketest"}' \
    https://whatsub.eversay.cc/api/license/admin/issue
```

Expected: `{"keys":["WHATSUB-XXXX-XXXX-XXXX-XXXX"]}`.

```bash
# Activate it from a fake fingerprint
curl -i -X POST -H "Content-Type: application/json" \
    -d '{"key":"<KEY_FROM_PREVIOUS>","fingerprint":"'$(printf 'a%.0s' {1..64})'","deviceLabel":"smoketest"}' \
    https://whatsub.eversay.cc/api/license/activate
```

Expected: `HTTP/2 200` + body `{"status":"active"}`.

```bash
# Verify the download endpoint redirects
curl -I https://whatsub.eversay.cc/download/win | head -3
```

Expected: `HTTP/2 302` + `location: https://jihulab.com/...whatsub_x64-setup.exe`.

If any of these fail, debug before proceeding to Phase 11. Likely culprits: missing nginx server block (re-check the conf), wrong DB credentials in `.env` (re-check Task 26), wrong admin token (re-check the Bearer header).

- [ ] **Step 4: Verify steady-state memory**

```bash
ssh -i ~/.ssh/id_ed25519 root@47.93.87.206 \
    "docker stats --no-stream whatsub-license"
```

Expected: `MEM USAGE` column shows under **150 MB** (success criterion from spec §12). Typical Hono+pg image is 70-100 MB at idle. If significantly higher, investigate (likely a connection pool or memory leak in dev deps that snuck into prod).

Also verify total server free memory is still healthy:

```bash
ssh -i ~/.ssh/id_ed25519 root@47.93.87.206 "free -h"
```

Expected: `available` column ≥ 700 MB (we have ~865 MB headroom budgeted in spec §9.5).

(No commit.)

---

## Phase 11 — Client-side endpoint switch

### Task 29: Update `ACTIVATE_ENDPOINT` in the Tauri client

**Files:**
- Modify: `client/src/types/license.ts`

- [ ] **Step 1: Read the current value**

Run:
```bash
grep -n "ACTIVATE_ENDPOINT" client/src/types/license.ts
```

Expected: shows the line with the old `whatsub-license.<sub>.workers.dev` URL.

- [ ] **Step 2: Edit the constant**

Open `client/src/types/license.ts`. Change:
```ts
export const ACTIVATE_ENDPOINT =
  'https://whatsub-license.<old-subdomain>.workers.dev/api/activate';
```
to:
```ts
export const ACTIVATE_ENDPOINT =
  'https://whatsub.eversay.cc/api/license/activate';
```

- [ ] **Step 3: Verify build still passes**

Run:
```bash
cd client
pnpm typecheck
```

Expected: no type errors.

- [ ] **Step 4: Run client-side tests if any cover the endpoint**

```bash
cd client
pnpm test
```

Expected: all tests pass. (Most likely no tests reference this constant; that's fine.)

- [ ] **Step 5: Commit**

```bash
git add client/src/types/license.ts
git commit -m "feat(client): point ACTIVATE_ENDPOINT at whatsub.eversay.cc"
```

---

### Task 30: End-to-end activation test from a dev client

- [ ] **Step 1: Start `pnpm tauri dev`**

```bash
cd client
pnpm tauri dev
```

Wait for the window to appear.

- [ ] **Step 2: Reach the activation gate**

If you have a previous `license.json` in `%APPDATA%/whatsub/` (Windows) or `~/Library/Application Support/whatsub/` (Mac), delete it so the app shows the activation gate:

```bash
# Windows PowerShell
Remove-Item -Force "$env:APPDATA\whatsub\license.json" -ErrorAction SilentlyContinue
# Mac
rm -f ~/Library/Application\ Support/whatsub/license.json
```

Restart the dev app.

- [ ] **Step 3: Issue a fresh test key**

```bash
curl -X POST -H "Authorization: Bearer <TOKEN>" \
    -H "Content-Type: application/json" \
    -d '{"count":1,"buyerNote":"client-e2e-test"}' \
    https://whatsub.eversay.cc/api/license/admin/issue
```

Copy the returned key.

- [ ] **Step 4: Paste into the activation gate**

In the dev app, paste the key. Watch the network call in the DevTools Network panel:

- The POST should go to `https://whatsub.eversay.cc/api/license/activate`
- Response time should be < 500ms (mainland network)
- Response body should be `{"status":"active"}`
- App should transition to the main library view

- [ ] **Step 5: Verify the row landed in DB**

```bash
ssh -i ~/.ssh/id_ed25519 root@47.93.87.206 \
    "docker compose -f /opt/enghub/docker-compose.yml exec -T postgres \
     psql -U whatsub_license_user -d whatsub_license \
     -c 'SELECT license_key, fingerprint, device_label FROM activations;'"
```

Expected: shows the row with the device_label that the client sent.

- [ ] **Step 6: Verify the admin UI works**

Open `https://whatsub.eversay.cc/admin/` in a browser. Login with the admin token. Verify:

- The license you just issued shows up in the list with `active_devices: 1`
- Click into the license, see the activation row with the right device label
- Click "释放" → confirm the slot is freed (active_devices goes to 0)

- [ ] **Step 7: Commit (this is verification, no file changes)**

No commit needed — the work for this task is the verification itself. If anything failed, return to the relevant earlier task to debug.

---

## Phase 12 — Cleanup

### Task 31: Delete the old `license-server/` directory

The CF Workers code is now superseded. Removing it ensures there's no confusion about which is current.

- [ ] **Step 1: Verify the new system is fully operational**

Re-run the smoke tests from Task 28 and the e2e from Task 30. Both must pass.

- [ ] **Step 2: Delete the old directory**

```bash
git rm -r license-server/
```

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: remove license-server/ (CF Workers, superseded by whatsub-license/)"
```

---

### Task 32: Decommission the Cloudflare Worker

- [ ] **Step 1: Confirm no traffic is hitting the old Worker**

If you still have access to the CF Workers dashboard, check the analytics for `whatsub-license` Worker — the request count for the last hour should be 0 (or only your own test traffic from before the migration). If it's higher than expected, **stop and investigate** — there may be leftover clients you didn't account for.

- [ ] **Step 2: Delete the Worker via the CF dashboard**

Cloudflare Dashboard → Workers & Pages → `whatsub-license` Worker → Manage → Delete.

Confirm by typing the Worker name.

- [ ] **Step 3: Delete the D1 database**

Cloudflare Dashboard → D1 → `whatsub-license` database → Settings → Delete.

(Since no real customers were on it, no data loss concern.)

- [ ] **Step 4: Update memory**

The project memory note in `memory/project_whatsub_website_aliyun_migration.md` says "CF Worker can be deleted after the new client is verified working." After this task, that condition is met. Update the memory:

```bash
# Edit memory/project_whatsub_website_aliyun_migration.md
# Change "Status as of 2026-05-09: spec written, awaiting user review before
#         writing the implementation plan."
# to:
# "Status as of 2026-XX-XX: license backend migrated to Aliyun, CF Worker + D1 deleted.
#  Next: marketing landing page (separate plan)."
```

- [ ] **Step 5: Commit the memory update**

```bash
git add C:/Users/renjx/.claude/projects/C--Users-renjx-Desktop-Get-Video/memory/project_whatsub_website_aliyun_migration.md
git commit -m "memory(project): mark license backend migration complete"
```

---

## Phase 13 — Coordinated client release

### Task 33: Cut whatSub v0.2.0 with the new endpoint

**Files:**
- Modify: `client/package.json`, `client/src-tauri/tauri.conf.json`, `client/src-tauri/Cargo.toml`

The endpoint change in Task 29 is in `main` but hasn't been released. Cut a new version so any new buyer downloads a binary that points at the new server.

- [ ] **Step 1: Bump version in 3 places**

Update each of these to `"0.2.0"` (or higher; pick whatever the next semver bump is given the prior version):

- `client/package.json` — `"version": "0.2.0"`
- `client/src-tauri/tauri.conf.json` — `"version": "0.2.0"`
- `client/src-tauri/Cargo.toml` — `version = "0.2.0"`

- [ ] **Step 2: Verify all three match**

```bash
grep -nE '"version"|^version' client/package.json client/src-tauri/tauri.conf.json client/src-tauri/Cargo.toml
```

Expected: all three show `0.2.0`.

- [ ] **Step 3: Commit the bump**

```bash
git add client/package.json client/src-tauri/tauri.conf.json client/src-tauri/Cargo.toml
git commit -m "release: v0.2.0 — license backend on Aliyun"
git push origin main
```

- [ ] **Step 4: Run the release workflow**

GitHub UI → Actions → Release → Run workflow.

Inputs:
- `targets`: `both`
- `release_notes`: `License activation 现已迁移至国内服务器 — 激活速度从 5-10 秒降到 200ms 以内。`
- Leave whisper_tag, vulkan_sdk_version, node_version at defaults
- `dry_run`: `false`

Wait ~25 min for both platforms to build + publish.

- [ ] **Step 5: Verify the new release is live**

```bash
curl -s https://github.com/rjxznb/whatsub-releases/releases/latest/download/latest.json | head -20
```

Expected: `version` field shows `0.2.0`.

- [ ] **Step 6: Verify the in-app updater can pick it up**

On a machine running v0.1.x: launch the app. Within 3 seconds the bottom-right toast should show "发现新版本 v0.2.0". Click 立即更新 → progress bar → restart → confirm new version in Settings.

- [ ] **Step 7: Verify a fresh install activates against the new server**

Download the v0.2.0 .msi or .dmg from the website. Install. On first launch, paste a new test license key. Confirm:

- Network tab in dev tools: POST goes to `whatsub.eversay.cc/api/license/activate`
- Activation succeeds in <500ms
- Postgres row appears in the `whatsub_license` database

If all checks pass, the migration is complete.

---

## Done.

After Task 33: the license backend lives on Aliyun, the CF Worker is gone, the new client is in users' hands, and `whatsub.eversay.cc` is ready to host the marketing landing page (covered by a separate plan).
