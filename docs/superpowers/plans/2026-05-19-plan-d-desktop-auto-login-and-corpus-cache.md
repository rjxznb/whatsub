# Plan D: Desktop Auto-Login + Corpus Cache + Admin Publish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip the desktop email-auth screen by exchanging the existing license key for a session token; cache corpus reads keyed by a server-side version flag; let the admin batch curate as drafts and explicitly publish.

**Architecture:** Two phases. Phase A modifies `whatsub-license` server (3 new endpoints + 1 modified endpoint + 1 schema row + admin SPA changes) and ships to production. Phase B modifies `Get_Video/client` (Tauri desktop) locally only — replaces the AuthCard with a LicenseSessionGate, adds a cache layer over the three corpus components, and adds nav to the Corpus page. **Server pushes + deploys normally; desktop is local-only (no git push, no Tauri bundle).**

**Tech Stack:** TypeScript + Hono + pg / pg-mem + vitest (server) · React + Vite + Tauri 2 + Rust + reqwest + tauri-plugin-store (desktop).

**Spec:** `Get_Video/docs/superpowers/specs/2026-05-19-plan-d-desktop-auto-login-and-corpus-cache-design.md`

**Plan A baseline:** `whatsub-license/main @ 6e9b291`. Auth subsystem + corpus model exist.
**Plan B baseline:** `whatsub-plugin/main @ 3dcb88f`. NOT modified by Plan D.
**Plan C baseline:** `Get_Video/main @ b287663` (Plan D spec commit). Desktop is on Plan C state.

---

## File Map

### Server (whatsub-license)

- **Create**
  - `src/routes/authFromLicense.ts` (or inline in existing `routes/auth.ts`)
  - `tests/auth-from-license.test.ts` (or extend `auth-routes.test.ts`)
  - `tests/corpus-versions.test.ts` (or extend `corpus-routes.test.ts`)
  - `tests/admin-publish.test.ts` (or extend `admin.test.ts`)
- **Modify**
  - `schema.sql` — append the `public_corpus_version` bootstrap INSERT
  - `src/lib/db.ts` — add `getPublicCorpusVersion`, `setPublicCorpusVersion`, `getMineVersion`, `countUnpublishedPhrases`
  - `src/routes/auth.ts` — add `POST /from-license` handler
  - `src/routes/corpus.ts` — add `GET /versions`; modify `/browse` + `/lookup?withScope=true` public path to apply published filter
  - `src/routes/admin.ts` — add `POST /corpus/publish`; modify `GET /corpus/list` to include `unpublishedCount` + `publicCorpusVersion`
  - `public/admin/index.html` — add 推送更新 button + draft indicators

### Desktop (Get_Video/client)

- **Create**
  - `src-tauri/src/commands/auth.rs` GETS a new function `auth_from_license` (file exists from C2)
  - `src/components/LicenseSessionGate.tsx`
  - `src/hooks/useCorpusList.ts`
  - `src/hooks/useCorpusPhrase.ts`
  - `src/lib/corpusCache.ts` (thin wrapper over tauri-plugin-store)
  - `src/components/CorpusNav.tsx` (extracted top-nav for the Corpus page)
- **Modify**
  - `src/store/auth.ts` — add `authFromLicense` action; remove unused `sendCode`/`verifyCode`
  - `src/App.tsx` — swap `<AuthGate>` for `<LicenseSessionGate>`
  - `src/pages/Corpus.tsx` — embed `<CorpusNav />` as a header above the 3-column layout
  - `src/components/CorpusPhraseList.tsx` — switch to `useCorpusList`
  - `src/components/CorpusPhraseDetail.tsx` — switch to `useCorpusPhrase`
  - `src-tauri/Cargo.toml` — confirm `tauri-plugin-store` is already there (yes from C1)
  - `package.json` (client) — add `@tauri-apps/plugin-store` JS dependency
- **Delete**
  - `src/components/AuthCard.tsx` + `src/components/AuthCard.test.tsx`

Test commands:
- Server: `pnpm test -- --run` from `whatsub-license/`
- Desktop frontend: `pnpm test -- --run` from `Get_Video/client/`
- Desktop Rust: `cargo check` from `Get_Video/client/src-tauri/`

---

# Phase A: Server

## Task D1: Schema bootstrap — `public_corpus_version` row

**Files:**
- Modify: `whatsub-license/schema.sql`

- [ ] **Step 1: Append bootstrap INSERT** at the end of `schema.sql`

```sql
-- Public-corpus publish version. Bumped by POST /admin/corpus/publish.
-- /browse and /lookup withScope filter phrases by last_seen_at <= this value
-- so admin curate writes are invisible until 推送更新.
-- Bootstrap inserts now() ms so any pre-existing curator data is implicitly
-- published on first deploy. ON CONFLICT DO NOTHING keeps re-applies safe.
INSERT INTO app_settings (key, value, updated_at)
VALUES ('public_corpus_version',
        (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint::text,
        (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 2: Verify schema loads in pg-mem**

Run from `whatsub-license/`:
```bash
pnpm test -- --run -t 'Database.listCorpusPhrases'
```

Expected: PASS — pg-mem accepts the new INSERT (it supports `ON CONFLICT DO NOTHING`, `NOW()`, and `EXTRACT EPOCH`).

If pg-mem chokes on `EXTRACT EPOCH`, use a hardcoded `0` as the bootstrap value instead — it'll be a no-op in tests and prod sees a real `NOW()` only on first apply.

- [ ] **Step 3: Commit**

```bash
git add schema.sql
git commit -m "chore(schema): bootstrap public_corpus_version in app_settings"
```

---

## Task D2: `Database` — versions + publish methods

**Files:**
- Modify: `whatsub-license/src/lib/db.ts`
- Test: `whatsub-license/tests/corpus-versions.test.ts` (new file)

- [ ] **Step 1: Write failing tests**

Create `tests/corpus-versions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeDb() {
  const mem = newDb();
  const sql = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf-8');
  mem.public.none(sql);
  const adapter = mem.adapters.createPg();
  return new Database(new adapter.Pool());
}

describe('Database.getPublicCorpusVersion', () => {
  it('returns the bootstrap value after schema load', async () => {
    const db = makeDb();
    const v = await db.getPublicCorpusVersion();
    expect(typeof v).toBe('number');
    expect(v).toBeGreaterThan(0);
  });

  it('returns updated value after setPublicCorpusVersion', async () => {
    const db = makeDb();
    await db.setPublicCorpusVersion(99_999, 99_999);
    expect(await db.getPublicCorpusVersion()).toBe(99_999);
  });
});

describe('Database.getMineVersion', () => {
  it('returns 0 when user has no contributions', async () => {
    const db = makeDb();
    expect(await db.getMineVersion('me-id')).toBe(0);
  });

  it('returns MAX(contributed_at) for contributor', async () => {
    const db = makeDb();
    await db.contributeCorpus({
      phraseNormalized: 'p', phraseRaw: 'p',
      contextSentence: 'c', source: { kind: 'webpage', url: 'https://x.com' },
      contributorId: 'me-id', now: 5000,
    });
    await db.contributeCorpus({
      phraseNormalized: 'q', phraseRaw: 'q',
      contextSentence: 'c', source: { kind: 'webpage', url: 'https://x.com' },
      contributorId: 'me-id', now: 7000,
    });
    expect(await db.getMineVersion('me-id')).toBe(7000);
  });
});

describe('Database.countUnpublishedPhrases', () => {
  it('counts phrases with last_seen_at > public_corpus_version', async () => {
    const db = makeDb();
    await db.setPublicCorpusVersion(1000, 1000);
    await db.contributeCorpus({
      phraseNormalized: 'old', phraseRaw: 'old',
      contextSentence: 'c', source: { kind: 'webpage', url: 'https://x.com' },
      contributorId: 'whatsub-curator', now: 500,  // BEFORE published
    });
    await db.contributeCorpus({
      phraseNormalized: 'new', phraseRaw: 'new',
      contextSentence: 'c', source: { kind: 'webpage', url: 'https://x.com' },
      contributorId: 'whatsub-curator', now: 1500,  // AFTER published
    });
    expect(await db.countUnpublishedPhrases()).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
pnpm test -- --run tests/corpus-versions.test.ts
```

Expected: `db.getPublicCorpusVersion is not a function`.

- [ ] **Step 3: Add methods to `Database`** (in `src/lib/db.ts`, append before the closing `}`)

```ts
async getPublicCorpusVersion(): Promise<number> {
  const r = await this.pool.query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = 'public_corpus_version'`,
  );
  return r.rows[0] ? parseInt(r.rows[0].value, 10) : 0;
}

async setPublicCorpusVersion(value: number, now: number): Promise<void> {
  await this.pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('public_corpus_version', $1, $2)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [String(value), now],
  );
}

async getMineVersion(contributorId: string): Promise<number> {
  const r = await this.pool.query<{ max: number | null }>(
    `SELECT MAX(contributed_at)::bigint AS max
       FROM corpus_contributions
      WHERE contributor_id = $1 AND hidden = FALSE`,
    [contributorId],
  );
  return r.rows[0]?.max ?? 0;
}

async countUnpublishedPhrases(): Promise<number> {
  const r = await this.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM corpus_phrases
      WHERE last_seen_at > COALESCE(
        (SELECT value::bigint FROM app_settings WHERE key = 'public_corpus_version'),
        0
      )`,
  );
  return parseInt(r.rows[0]!.count, 10);
}
```

- [ ] **Step 4: Run, verify PASS**

```bash
pnpm test -- --run tests/corpus-versions.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts tests/corpus-versions.test.ts
git commit -m "feat(db): version helpers — public/mine getters + publish setter + draft count"
```

---

## Task D3: `POST /api/auth/from-license`

**Files:**
- Modify: `whatsub-license/src/routes/auth.ts`
- Modify: `whatsub-license/tests/auth-routes.test.ts`

- [ ] **Step 1: Write failing tests** (append to `tests/auth-routes.test.ts`)

```ts
describe('POST /api/auth/from-license', () => {
  it('returns sessionToken when license exists with email', async () => {
    const { app, db } = makeFullAuthApp();
    await db.insertLicense({
      key: 'WHATSUB-AAAA-BBBB-CCCC-DDDD', max_devices: 3, created_at: 1,
      buyer_note: null, email: 'paid@x.com',
    });
    const res = await app.request('/api/auth/from-license', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: 'WHATSUB-AAAA-BBBB-CCCC-DDDD' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionToken: string; expiresAt: number };
    expect(body.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('400 license_not_found when license missing', async () => {
    const { app } = makeFullAuthApp();
    const res = await app.request('/api/auth/from-license', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: 'NOPE' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'license_not_found' });
  });

  it('400 license_has_no_email when license has no email', async () => {
    const { app, db } = makeFullAuthApp();
    await db.insertLicense({
      key: 'K-NULL', max_devices: 3, created_at: 1,
      buyer_note: null, email: null,
    });
    const res = await app.request('/api/auth/from-license', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: 'K-NULL' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'license_has_no_email' });
  });

  it('400 invalid_json on malformed body', async () => {
    const { app } = makeFullAuthApp();
    const res = await app.request('/api/auth/from-license', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
pnpm test -- --run -t 'POST /api/auth/from-license'
```

- [ ] **Step 3: Add route to `authRoutes`** in `src/routes/auth.ts` (before `return app`)

```ts
// POST /from-license — desktop client trades license key for session token.
// License key possession is the proof; no email round-trip needed.
app.post('/from-license', async (c) => {
  let body: { licenseKey?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const licenseKey = typeof body.licenseKey === 'string' ? body.licenseKey.trim() : '';
  if (!licenseKey) return c.json({ error: 'invalid_json' }, 400);

  const license = await db.findLicense(licenseKey);
  if (!license) return c.json({ error: 'license_not_found' }, 400);
  if (!license.email) return c.json({ error: 'license_has_no_email' }, 400);

  const email = normalizeEmail(license.email);
  const token = generateToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await db.insertSessionToken({
    tokenHash: hashToken(token),
    email,
    issuedAt: now,
    expiresAt,
  });
  return c.json({ sessionToken: token, expiresAt });
});
```

(`generateToken`, `hashToken`, `normalizeEmail`, `SESSION_TTL_MS` are all already imported at the top of this file from Plan A.)

- [ ] **Step 4: Run, verify PASS**

```bash
pnpm test -- --run -t 'POST /api/auth/from-license'
```

Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.ts tests/auth-routes.test.ts
git commit -m "feat(auth): POST /from-license — license key to session token"
```

---

## Task D4: `GET /api/corpus/versions`

**Files:**
- Modify: `whatsub-license/src/routes/corpus.ts`
- Modify: `whatsub-license/tests/corpus-routes.test.ts`

- [ ] **Step 1: Write failing tests** (append to `tests/corpus-routes.test.ts`)

```ts
describe('GET /api/corpus/versions', () => {
  it('returns mine + public timestamps for authed user', async () => {
    const rig = makeApp();
    const { hashToken } = await import('../src/lib/sessionTokens.js');
    const { createHash } = await import('node:crypto');
    const raw = 'versions-tok-' + 'x'.repeat(30);
    await rig.db.insertSessionToken({
      tokenHash: hashToken(raw), email: 'me@x.com',
      issuedAt: 1, expiresAt: Date.now() + 60_000,
    });
    await rig.db.setPublicCorpusVersion(1234, 1234);
    const myId = createHash('sha256').update('me@x.com').digest('hex').slice(0, 16);
    await rig.db.contributeCorpus({
      phraseNormalized: 'p', phraseRaw: 'p',
      contextSentence: 'c', source: { kind: 'webpage', url: 'https://x.com' },
      contributorId: myId, now: 5555,
    });
    const r = await rig.app.request('/api/corpus/versions', {
      headers: { Authorization: `Bearer ${raw}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { mine: number; public: number };
    expect(body.mine).toBe(5555);
    expect(body.public).toBe(1234);
  });

  it('401 without bearer', async () => {
    const rig = makeApp();
    const r = await rig.app.request('/api/corpus/versions');
    expect(r.status).toBe(401);
  });

  it('mine = 0 when user has no contributions', async () => {
    const rig = makeApp();
    const { hashToken } = await import('../src/lib/sessionTokens.js');
    const raw = 'fresh-tok-' + 'x'.repeat(32);
    await rig.db.insertSessionToken({
      tokenHash: hashToken(raw), email: 'fresh@x.com',
      issuedAt: 1, expiresAt: Date.now() + 60_000,
    });
    const r = await rig.app.request('/api/corpus/versions', {
      headers: { Authorization: `Bearer ${raw}` },
    });
    const body = (await r.json()) as { mine: number };
    expect(body.mine).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
pnpm test -- --run -t 'GET /api/corpus/versions'
```

- [ ] **Step 3: Add route in `src/routes/corpus.ts`** (next to other `app.get` handlers — `requireSession` is already imported)

```ts
app.get('/versions', requireSession(db), async (c) => {
  const email = c.get('email' as never) as string;
  const contributorId = deriveContributorId(email);
  const [mine, pub] = await Promise.all([
    db.getMineVersion(contributorId),
    db.getPublicCorpusVersion(),
  ]);
  return c.json({ mine, public: pub });
});
```

- [ ] **Step 4: Run, verify PASS**

```bash
pnpm test -- --run -t 'GET /api/corpus/versions'
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/corpus.ts tests/corpus-routes.test.ts
git commit -m "feat(corpus): GET /versions — mine + public timestamps"
```

---

## Task D5: `POST /api/admin/corpus/publish`

**Files:**
- Modify: `whatsub-license/src/routes/admin.ts`
- Modify: `whatsub-license/tests/admin.test.ts`

- [ ] **Step 1: Write failing tests** (append to `tests/admin.test.ts`)

```ts
describe('POST /api/admin/corpus/publish', () => {
  it('bumps public_corpus_version to now and returns it', async () => {
    const { app, db } = makeApp();
    const before = await db.getPublicCorpusVersion();
    const res = await app.request('/api/admin/corpus/publish', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { published_at: number };
    expect(body.published_at).toBeGreaterThan(before);
    const after = await db.getPublicCorpusVersion();
    expect(after).toBe(body.published_at);
  });

  it('401 without admin bearer', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/corpus/publish', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
pnpm test -- --run -t 'POST /api/admin/corpus/publish'
```

- [ ] **Step 3: Add route in `src/routes/admin.ts`** (alongside other admin handlers)

```ts
app.post('/corpus/publish', async (c) => {
  const now = Date.now();
  await db.setPublicCorpusVersion(now, now);
  return c.json({ published_at: now });
});
```

(`checkAdminAuth` middleware on `*` already gates this route.)

- [ ] **Step 4: Run, verify PASS**

```bash
pnpm test -- --run -t 'POST /api/admin/corpus/publish'
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.ts tests/admin.test.ts
git commit -m "feat(admin): POST /corpus/publish — bump public_corpus_version"
```

---

## Task D6: `/corpus/browse` + `/lookup withScope` publish filter

**Files:**
- Modify: `whatsub-license/src/lib/db.ts` — `browseCorpus` + `lookupCorpus` get filter
- Modify: `whatsub-license/tests/corpus-routes.test.ts`

- [ ] **Step 1: Write failing tests** (append)

```ts
describe('browse filters drafts (last_seen_at > public_corpus_version)', () => {
  it('hides phrases added after last publish', async () => {
    const rig = makeApp();
    await rig.db.setPublicCorpusVersion(1000, 1000);
    // 'published' phrase: last_seen_at <= 1000 → visible
    rig.mem.public.none(`
      INSERT INTO corpus_phrases (phrase_normalized, phrase_raw, tags, first_seen_at, last_seen_at, contribution_count)
      VALUES ('pub', 'pub', '{"scene":"social"}'::jsonb, 500, 500, 1)
    `);
    // 'draft' phrase: last_seen_at > 1000 → hidden
    rig.mem.public.none(`
      INSERT INTO corpus_phrases (phrase_normalized, phrase_raw, tags, first_seen_at, last_seen_at, contribution_count)
      VALUES ('draft', 'draft', '{"scene":"social"}'::jsonb, 1500, 1500, 1)
    `);
    // Authed + license
    const { hashToken } = await import('../src/lib/sessionTokens.js');
    const raw = 'browse-pub-tok-' + 'x'.repeat(28);
    await rig.db.insertSessionToken({
      tokenHash: hashToken(raw), email: 'paid@x.com',
      issuedAt: 1, expiresAt: Date.now() + 60_000,
    });
    await rig.db.insertLicense({
      key: 'BROWSE-PUB-K', max_devices: 3, created_at: 1, buyer_note: null,
      email: 'paid@x.com',
    });
    const r = await rig.app.request('/api/corpus/browse?scene=social', {
      headers: { Authorization: `Bearer ${raw}` },
    });
    const body = (await r.json()) as { phrases: Array<{ phrase_normalized: string }> };
    expect(body.phrases.map((p) => p.phrase_normalized)).toEqual(['pub']);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
pnpm test -- --run -t 'browse filters drafts'
```

- [ ] **Step 3: Modify `browseCorpus`** in `src/lib/db.ts` — add the WHERE clause

Find the existing `browseCorpus` method. The query already has a dynamic `${where}` clause. Append the publish filter to `conds`:

```ts
async browseCorpus(filter: BrowseCorpusFilter): Promise<{ phrases: CorpusPhraseRow[]; total: number }> {
  const conds: string[] = [];
  const args: unknown[] = [];
  if (filter.scene) {
    args.push(filter.scene);
    conds.push(`tags->>'scene' = $${args.length}`);
  }
  // NEW: only show phrases added on or before the last publish
  conds.push(`last_seen_at <= COALESCE(
    (SELECT value::bigint FROM app_settings WHERE key = 'public_corpus_version'),
    0
  )`);
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  // ... rest unchanged
```

- [ ] **Step 4: Apply same filter to `lookupCorpus` public-contribution path**

In `src/routes/corpus.ts`, find the `withScope=true` branch of `/lookup`. It currently does:

```ts
const result = await db.lookupCorpus(phrase, null);
// ...
const pub = hasActiveLicense
  ? result.contributions.filter((c) => c.contributor_id === 'whatsub-curator')
  : [];
```

Need to also filter by phrase.last_seen_at <= published. The simplest approach: don't return the `phrase` object at all if the phrase itself is a draft:

```ts
if (result.phrase && hasActiveLicense) {
  const publishedVersion = await db.getPublicCorpusVersion();
  if ((result.phrase.last_seen_at ?? 0) > publishedVersion) {
    return c.json({
      phrase: null,
      publicContributions: [],
      personalContributions: result.contributions.filter((c) => c.contributor_id !== 'whatsub-curator'),
    });
  }
}
// ... rest unchanged (already returns publicContributions only when license)
```

(Adjust to match the existing code shape; the principle is: phrase-level draft = hide the phrase entirely from public side.)

- [ ] **Step 5: Run, verify PASS**

```bash
pnpm test -- --run tests/corpus-routes.test.ts
```

All corpus tests including the new draft-filter test should pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db.ts src/routes/corpus.ts tests/corpus-routes.test.ts
git commit -m "feat(corpus): /browse + /lookup hide drafts (last_seen_at > publish version)"
```

---

## Task D7: `/api/admin/corpus/list` includes `unpublishedCount` + `publicCorpusVersion`

**Files:**
- Modify: `whatsub-license/src/routes/admin.ts`
- Modify: `whatsub-license/tests/admin.test.ts`

- [ ] **Step 1: Write failing test** (append)

```ts
describe('GET /api/admin/corpus/list — unpublishedCount + publicCorpusVersion', () => {
  it('returns counts + version alongside items', async () => {
    const { app, db } = makeApp();
    await db.setPublicCorpusVersion(1000, 1000);
    await seedPhrase(db, 'old-pub', { tags: { scene: 'social' }, now: 500 });
    await seedPhrase(db, 'new-draft', { tags: { scene: 'travel' }, now: 1500 });
    const res = await app.request('/api/admin/corpus/list', { headers: authHeader() });
    const body = (await res.json()) as {
      items: unknown[];
      total: number;
      unpublishedCount: number;
      publicCorpusVersion: number;
    };
    expect(body.total).toBe(2);
    expect(body.unpublishedCount).toBe(1);
    expect(body.publicCorpusVersion).toBe(1000);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
pnpm test -- --run -t 'unpublishedCount'
```

- [ ] **Step 3: Update `/corpus/list` handler** in `src/routes/admin.ts`

```ts
app.get('/corpus/list', async (c) => {
  const scene = c.req.query('scene') || undefined;
  const search = c.req.query('search') || undefined;
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const rawSize = parseInt(c.req.query('pageSize') ?? '50', 10);
  const pageSize = Math.max(
    1,
    Math.min(100, Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 50),
  );
  const [{ items, total }, unpublishedCount, publicCorpusVersion] = await Promise.all([
    db.listCorpusPhrases({ scene, search, limit: pageSize, offset: (page - 1) * pageSize }),
    db.countUnpublishedPhrases(),
    db.getPublicCorpusVersion(),
  ]);
  return c.json({ items, total, page, pageSize, unpublishedCount, publicCorpusVersion });
});
```

- [ ] **Step 4: Run, verify PASS**

```bash
pnpm test -- --run -t 'unpublishedCount'
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.ts tests/admin.test.ts
git commit -m "feat(admin): /corpus/list adds unpublishedCount + publicCorpusVersion"
```

---

## Task D8: Admin SPA — 推送更新 button + draft indicators

**Files:**
- Modify: `whatsub-license/public/admin/index.html`

No unit tests for the SPA (HTML + Alpine). Manual verification at deploy time.

- [ ] **Step 1: Read the existing 语料 tab structure**

```bash
grep -n "+ 添加\|公共语料库\|corpusFilters" public/admin/index.html | head -20
```

Find the "+ 添加" button + its surrounding flex container (from Plan A Task A23).

- [ ] **Step 2: Add 推送更新 button + draft count badge** alongside the existing "+ 添加" button

Find the block:

```html
<div class="flex justify-between items-center mb-3">
  <span class="text-sm text-zinc-400">公共语料库（你手动整理的部分）</span>
  <button @click="curateOpen = true; curateReset()"
          class="px-3 py-1.5 text-sm rounded font-medium bg-emerald-500 hover:bg-emerald-400 text-black">
    + 添加
  </button>
</div>
```

Replace with:

```html
<div class="flex justify-between items-center mb-3">
  <span class="text-sm text-zinc-400">公共语料库（你手动整理的部分）</span>
  <div class="flex items-center gap-3">
    <span x-show="(corpusData?.unpublishedCount ?? 0) > 0"
          class="text-xs text-amber-400"
          x-text="`${corpusData.unpublishedCount} 条草稿未推送`"></span>
    <button @click="publishCorpus()"
            :disabled="publishBusy || (corpusData?.unpublishedCount ?? 0) === 0"
            class="px-3 py-1.5 text-sm rounded font-medium bg-amber-500 hover:bg-amber-400 text-black disabled:bg-zinc-700 disabled:text-zinc-500 disabled:cursor-not-allowed">
      <span x-show="!publishBusy">📢 推送更新</span>
      <span x-show="publishBusy">推送中…</span>
    </button>
    <button @click="curateOpen = true; curateReset()"
            class="px-3 py-1.5 text-sm rounded font-medium bg-emerald-500 hover:bg-emerald-400 text-black">
      + 添加
    </button>
  </div>
</div>
```

- [ ] **Step 3: Add draft indicator to table rows**

Find the table row template (look for `x-for="row in corpusData?.items"`). The current row likely renders `phraseRaw` as the first cell. Insert a "📋 草稿" badge next to it when the row is unpublished:

```html
<td class="px-3 py-2 font-mono">
  <span x-text="row.phraseRaw"></span>
  <span x-show="row.lastSeenAt > (corpusData?.publicCorpusVersion ?? 0)"
        class="ml-2 inline-block px-2 py-0.5 text-[10px] rounded bg-amber-900/40 border border-amber-700 text-amber-200">
    📋 草稿
  </span>
</td>
```

Note: the row shape from `listCorpusPhrases` uses `lastSeenAt` (camelCase) — confirm by reading the existing render template; if the existing code uses snake_case (`row.last_seen_at`), match that.

- [ ] **Step 4: Add Alpine state + method**

Find the `function adminApp()` factory. Add to the returned state object:

```js
publishBusy: false,
```

Add to the methods:

```js
async publishCorpus() {
  if (!confirm('推送当前所有草稿到客户端？所有用户下次打开会看到新内容。')) return;
  this.publishBusy = true;
  try {
    const r = await fetch(`${API_BASE}/admin/corpus/publish`, {
      method: 'POST',
      headers: this.apiHeaders(),
      body: '{}',
    });
    if (r.ok) {
      // Refresh the list to clear the unpublished count + draft badges
      await this.loadCorpus();
    } else {
      alert(`推送失败: ${r.status}`);
    }
  } finally {
    this.publishBusy = false;
  }
},
```

- [ ] **Step 5: Commit**

```bash
git add public/admin/index.html
git commit -m "feat(admin-spa): 推送更新 button + draft indicators in 语料 tab"
```

---

## Task D9: Server full verify + push + deploy

- [ ] **Step 1: Full typecheck + tests + build**

```bash
cd whatsub-license/
pnpm typecheck
pnpm test -- --run
pnpm build
```

All three must be green.

- [ ] **Step 2: Push**

```bash
git log --oneline origin/main..HEAD
git push origin main
```

- [ ] **Step 3: Apply schema**

```bash
scp schema.sql root@47.93.87.206:/tmp/schema.sql
ssh root@47.93.87.206 "docker exec -i enghub-postgres-1 \
  psql -U whatsub_license_user -d whatsub_license < /tmp/schema.sql"
```

Verify the new row:

```bash
ssh root@47.93.87.206 "docker exec enghub-postgres-1 \
  psql -U whatsub_license_user -d whatsub_license \
       -c \"SELECT * FROM app_settings WHERE key = 'public_corpus_version'\""
```

Expected: one row with a non-zero numeric value (ms timestamp at deploy time).

- [ ] **Step 4: Docker build + deploy**

```bash
docker build -t whatsub-license:latest .
docker save whatsub-license:latest | gzip > /tmp/whatsub-license.tar.gz
scp /tmp/whatsub-license.tar.gz root@47.93.87.206:/tmp/
ssh root@47.93.87.206 "docker load < /tmp/whatsub-license.tar.gz && \
  cd /opt/whatsub && docker compose --env-file .env up -d --force-recreate whatsub-license && \
  sleep 2 && docker logs whatsub-license --tail 10"
```

Expected: `whatsub-license listening on :3002` + no errors.

- [ ] **Step 5: Smoke test the new endpoints**

```bash
# Pull admin token from server env
ADMIN_TOKEN=$(ssh root@47.93.87.206 "docker exec whatsub-license sh -c 'echo \$ADMIN_TOKEN'")

# Get an admin's license key for from-license test
LICENSE_KEY=$(ssh root@47.93.87.206 "docker exec enghub-postgres-1 \
  psql -U whatsub_license_user -d whatsub_license -t -c \
  \"SELECT key FROM licenses WHERE email IS NOT NULL LIMIT 1\"" | tr -d ' ')
echo "Using license: $LICENSE_KEY"

# /from-license
curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"licenseKey\":\"$LICENSE_KEY\"}" \
  https://whatsub.eversay.cc/api/license/auth/from-license

# /versions (need a session token from above)
TOKEN=$(...)  # extract sessionToken from /from-license response
curl -s -H "Authorization: Bearer $TOKEN" \
  https://whatsub.eversay.cc/api/license/corpus/versions

# /publish
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://whatsub.eversay.cc/api/license/admin/corpus/publish

# Open https://whatsub.eversay.cc/admin/, log in, click 语料,
# see "📢 推送更新" + draft indicators rendered correctly.
```

---

# Phase B: Desktop (local only)

## Task D10: Rust `auth_from_license` command

**Files:**
- Modify: `Get_Video/client/src-tauri/src/commands/auth.rs`
- Modify: `Get_Video/client/src-tauri/src/lib.rs` (register command in `generate_handler!`)

- [ ] **Step 1: Add the command** in `commands/auth.rs` (sibling to existing `auth_send_code`, etc.)

```rust
#[derive(Serialize)]
struct FromLicenseReq<'a> {
    #[serde(rename = "licenseKey")]
    license_key: &'a str,
}

#[tauri::command]
pub async fn auth_from_license<R: Runtime>(
    app: AppHandle<R>,
    license_key: String,
) -> Result<AuthResult, String> {
    let client = Client::new();
    let req_body = serde_json::to_string(&FromLicenseReq { license_key: &license_key })
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{}/auth/from-license", SERVER_BASE))
        .header("Content-Type", "application/json")
        .body(req_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        let body = resp.text().await.map_err(|e| e.to_string())?;
        let v: VerifyCodeResp = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        // Server returns the license's stored email — fetch it via /me using the new token.
        // Simpler: hit /me right after storing the token so AuthState.email comes from server.
        auth::set_auth(&app, &AuthState {
            session_token: v.session_token.clone(),
            email: String::new(),  // filled in by /me on next refresh
            expires_at: v.expires_at,
        })?;
        Ok(AuthResult { ok: true, reason: None })
    } else {
        let body = resp.text().await.unwrap_or_default();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::json!({}));
        Ok(AuthResult {
            ok: false,
            reason: Some(map_reason(&v)),
        })
    }
}
```

Reuses `VerifyCodeResp` (since `/from-license` returns the same shape). If the email field is needed before `/me` fires (e.g. UI shows logged-in email immediately), the simpler path: have the React layer call `useAuth.refresh()` after `authFromLicense` so `auth_me` populates the email field.

- [ ] **Step 2: Register the command** in `lib.rs` `tauri::generate_handler!`

```rust
commands::auth::auth_from_license,
```

- [ ] **Step 3: cargo check**

```bash
cd Get_Video/client/src-tauri
cargo check
```

- [ ] **Step 4: Commit**

```bash
cd Get_Video
git add client/src-tauri/src/commands/auth.rs client/src-tauri/src/lib.rs
git commit -m "feat(client/commands): auth_from_license — license key to session"
```

---

## Task D11: `useAuth` store: add `authFromLicense`, remove unused actions

**Files:**
- Modify: `Get_Video/client/src/store/auth.ts`
- Modify: `Get_Video/client/src/store/auth.test.ts`

- [ ] **Step 1: Update tests** in `store/auth.test.ts`

Remove the tests for `sendCode` and `verifyCode` (those actions are being deleted). Add a new test for `authFromLicense`:

```ts
it('authFromLicense: on ok refreshes status', async () => {
  invokeMock
    .mockResolvedValueOnce({ ok: true })       // auth_from_license
    .mockResolvedValueOnce({                   // refresh (auth_me)
      authenticated: true, email: 'paid@x.com', hasActiveLicense: true,
    });
  const r = await useAuth.getState().authFromLicense('WHATSUB-AAAA-BBBB-CCCC-DDDD');
  expect(r.ok).toBe(true);
  expect(useAuth.getState().status).toBe('authed');
  expect(useAuth.getState().email).toBe('paid@x.com');
});

it('authFromLicense: on failure does not refresh', async () => {
  invokeMock.mockResolvedValueOnce({ ok: false, reason: 'license_not_found' });
  const r = await useAuth.getState().authFromLicense('NOPE');
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('license_not_found');
  expect(useAuth.getState().status).toBe('unknown');  // unchanged
});
```

- [ ] **Step 2: Update the store** in `store/auth.ts`

Remove `sendCode`, `verifyCode` from the interface + implementation. Add `authFromLicense`:

```ts
interface AuthStore {
  status: AuthStatus;
  email: string | null;
  hasActiveLicense: boolean;
  refresh: () => Promise<void>;
  authFromLicense: (licenseKey: string) => Promise<{ ok: boolean; reason?: string }>;
  logout: () => Promise<void>;
}

// inside create<AuthStore>:
authFromLicense: async (licenseKey: string) => {
  const r = await invoke<AuthResult>('auth_from_license', { licenseKey });
  if (r.ok) await get().refresh();
  return r;
},
```

- [ ] **Step 3: Run, verify PASS**

```bash
cd Get_Video/client
pnpm test -- --run src/store/auth.test.ts
```

- [ ] **Step 4: Commit**

```bash
cd Get_Video
git add client/src/store/auth.ts client/src/store/auth.test.ts
git commit -m "refactor(client/auth): replace sendCode/verifyCode with authFromLicense"
```

---

## Task D12: `LicenseSessionGate` component (replaces AuthGate)

**Files:**
- Create: `Get_Video/client/src/components/LicenseSessionGate.tsx`
- Modify: `Get_Video/client/src/App.tsx`

- [ ] **Step 1: Read existing license-key state**

The desktop already has a license-key store from the pre-Plan-C era. Find where the license key is stored:

```bash
grep -rn "licenseKey\|license_key\|activated_at\|useLicense" client/src/ 2>&1 | head -20
```

Likely it's in `useLicense` store or `chrome.storage`-equivalent. Identify the existing API to read it (e.g. `useLicense.getState().licenseKey` or `await invoke('get_license_key')`).

If it's a Tauri command, use `invoke<{key: string}>('get_license_info')` or similar.

- [ ] **Step 2: Implement `LicenseSessionGate.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useAuth } from '../store/auth';
// Adjust this import to whatever the existing license-key API is:
import { useLicense } from '../store/license';  // hypothetical

interface Props {
  children: React.ReactNode;
}

export function LicenseSessionGate({ children }: Props) {
  const status = useAuth((s) => s.status);
  const refresh = useAuth((s) => s.refresh);
  const authFromLicense = useAuth((s) => s.authFromLicense);
  // Adjust to the actual store API:
  const licenseKey = useLicense((s) => s.licenseKey);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      await refresh();   // try existing session first
      // useAuth.status is now 'authed' or 'unauthed'
      if (useAuth.getState().status === 'authed') return;
      // No session — exchange license key
      if (!licenseKey) return;  // existing license-gate flow handles this
      const r = await authFromLicense(licenseKey);
      if (!r.ok) setError(r.reason ?? 'unknown');
    })();
  }, [licenseKey, refresh, authFromLicense]);

  if (status === 'unknown') return <div className="p-8 text-zinc-400">加载中…</div>;
  if (status === 'unauthed' && error) {
    return (
      <div className="min-h-screen bg-zinc-900 flex items-center justify-center p-4">
        <div className="max-w-sm p-6 bg-zinc-800 rounded-lg border border-zinc-700 space-y-3">
          <h2 className="text-base font-semibold">无法登录云端</h2>
          <p className="text-xs text-zinc-400">原因: {error}</p>
          <p className="text-xs text-zinc-400">请检查激活码或联系客服。</p>
        </div>
      </div>
    );
  }
  // status === 'unauthed' && !licenseKey: existing LicenseGate handles activation
  // status === 'unauthed' && !error: still trying — fall through to children
  // status === 'authed': render children
  return <>{children}</>;
}
```

This component assumes there's already a license-key activation flow in `App.tsx` (the `<LicenseGate>` from Plan C). LicenseSessionGate sits INSIDE LicenseGate so by the time we get here, the license key has been activated.

- [ ] **Step 3: Update `App.tsx`** — replace `<AuthGate>` with `<LicenseSessionGate>`

Read the existing App.tsx, find the `<AuthGate>` wrapper, swap:

```tsx
// before
<AuthGate>
  <BrowserRouter>...</BrowserRouter>
</AuthGate>

// after
<LicenseSessionGate>
  <BrowserRouter>...</BrowserRouter>
</LicenseSessionGate>
```

Remove the `AuthGate` inline definition + its imports (`useAuth` selectors, `AuthCard`).

- [ ] **Step 4: Typecheck + tests**

```bash
pnpm typecheck
pnpm test -- --run
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/LicenseSessionGate.tsx client/src/App.tsx
git commit -m "feat(client): LicenseSessionGate replaces AuthCard-based AuthGate"
```

---

## Task D13: Delete AuthCard

**Files:**
- Delete: `Get_Video/client/src/components/AuthCard.tsx`
- Delete: `Get_Video/client/src/components/AuthCard.test.tsx`

- [ ] **Step 1: Confirm no references remain**

```bash
grep -rn "AuthCard" client/src 2>&1 | head
```

Expected: no matches. If anything still imports AuthCard, fix that first.

- [ ] **Step 2: Delete**

```bash
git rm client/src/components/AuthCard.tsx client/src/components/AuthCard.test.tsx
```

- [ ] **Step 3: Tests + typecheck**

```bash
pnpm typecheck
pnpm test -- --run
```

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(client): delete AuthCard (replaced by LicenseSessionGate)"
```

---

## Task D14: Corpus page top nav

**Files:**
- Create: `Get_Video/client/src/components/CorpusNav.tsx`
- Modify: `Get_Video/client/src/pages/Corpus.tsx`

- [ ] **Step 1: Look at Library page's nav** for the existing pattern

```bash
grep -nE "NavLink|to=\"/\"" client/src/pages/Library.tsx | head -10
```

- [ ] **Step 2: Implement `CorpusNav.tsx`**

```tsx
import { NavLink } from 'react-router-dom';

interface Props {
  onRefresh?: () => void;
  refreshing?: boolean;
}

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 text-sm rounded ${
    isActive
      ? 'bg-zinc-800 text-zinc-100'
      : 'text-zinc-400 hover:text-zinc-200'
  }`;

export function CorpusNav({ onRefresh, refreshing }: Props) {
  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-950">
      <nav className="flex gap-2">
        <NavLink to="/library" className={linkClass}>字幕本</NavLink>
        <NavLink to="/corpus" className={linkClass}>📚 语料库</NavLink>
        <NavLink to="/settings" className={linkClass}>设置</NavLink>
      </nav>
      {onRefresh && (
        <button
          onClick={onRefresh}
          disabled={refreshing}
          title="刷新语料库"
          className="px-2 py-1 text-sm text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
        >
          {refreshing ? '↻ 刷新中…' : '↻'}
        </button>
      )}
    </header>
  );
}
```

(Adapt nav entries to whatever Library.tsx has — if there's a Player back link or a 试用 indicator, copy those too for consistency.)

- [ ] **Step 3: Update Corpus.tsx** to include the nav

```tsx
import { useState } from 'react';
import { CorpusSceneTree } from '../components/CorpusSceneTree';
import { CorpusPhraseList } from '../components/CorpusPhraseList';
import { CorpusPhraseDetail } from '../components/CorpusPhraseDetail';
import { CorpusNav } from '../components/CorpusNav';

export function Corpus() {
  const [scene, setScene] = useState<string | null>('social');
  const [phrase, setPhrase] = useState<string | null>(null);
  // Refresh wiring is added in D17 — for now pass undefined to hide the button
  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <CorpusNav />
      <div className="flex flex-1 overflow-hidden">
        <CorpusSceneTree
          selected={scene}
          onSelect={(s) => { setScene(s); setPhrase(null); }}
        />
        <CorpusPhraseList
          scene={scene}
          selected={phrase}
          onSelect={setPhrase}
        />
        <CorpusPhraseDetail phraseNormalized={phrase} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + tests**

```bash
pnpm typecheck
pnpm test -- --run
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/CorpusNav.tsx client/src/pages/Corpus.tsx
git commit -m "feat(client/corpus): top nav with library/corpus/settings links"
```

---

## Task D15: `corpusCache.ts` + `useCorpusList` + `useCorpusPhrase` hooks

**Files:**
- Create: `Get_Video/client/src/lib/corpusCache.ts`
- Create: `Get_Video/client/src/hooks/useCorpusList.ts`
- Create: `Get_Video/client/src/hooks/useCorpusPhrase.ts`
- Modify: `Get_Video/client/package.json` (add `@tauri-apps/plugin-store`)

- [ ] **Step 1: Add the JS dep**

```bash
cd Get_Video/client
pnpm add @tauri-apps/plugin-store
```

Confirm `package.json` and lockfile updated.

- [ ] **Step 2: Implement `corpusCache.ts`**

```ts
import { LazyStore } from '@tauri-apps/plugin-store';

const CACHE_FILE = 'corpus_cache.json';
let _store: LazyStore | null = null;

function store(): LazyStore {
  if (!_store) _store = new LazyStore(CACHE_FILE);
  return _store;
}

export async function getCachedVersion(key: 'mineVersion' | 'publicVersion'): Promise<number> {
  const v = await store().get<number>(key);
  return typeof v === 'number' ? v : 0;
}

export async function setCachedVersion(key: 'mineVersion' | 'publicVersion', v: number): Promise<void> {
  await store().set(key, v);
  await store().save();
}

export async function getCachedData<T>(key: string): Promise<T | null> {
  const v = await store().get<T>(key);
  return v ?? null;
}

export async function setCachedData<T>(key: string, data: T): Promise<void> {
  await store().set(key, data);
  await store().save();
}

export async function invalidate(...keys: string[]): Promise<void> {
  for (const k of keys) await store().delete(k);
  await store().save();
}
```

- [ ] **Step 3: Implement `useCorpusList.ts`**

```ts
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  getCachedVersion, setCachedVersion,
  getCachedData, setCachedData,
} from '../lib/corpusCache';

type Scope = { mode: 'mine' } | { mode: 'browse'; scene: string };

interface VersionsResp { mine: number; public: number }

function cacheKeyForScope(scope: Scope): string {
  return scope.mode === 'mine' ? 'mineData' : `publicData:${scope.scene}`;
}

export function useCorpusList<T>(scope: Scope) {
  const [data, setData] = useState<T | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (force = false) => {
    setRefreshing(true);
    try {
      // 1. Check versions
      const serverV: VersionsResp = await invoke('corpus_versions');
      const myV = scope.mode === 'mine' ? 'mineVersion' : 'publicVersion';
      const cachedV = await getCachedVersion(myV);
      const serverVal = scope.mode === 'mine' ? serverV.mine : serverV.public;
      if (!force && cachedV === serverVal && cachedV > 0) {
        // Cache is fresh; skip the full fetch
        return;
      }
      // 2. Full fetch
      const fresh = scope.mode === 'mine'
        ? await invoke<T>('corpus_mine', { pageSize: 100 })
        : await invoke<T>('corpus_browse', { scene: scope.scene, pageSize: 100 });
      // 3. Update cache
      await setCachedData(cacheKeyForScope(scope), fresh);
      await setCachedVersion(myV, serverVal);
      setData(fresh);
    } catch {
      // On error keep showing whatever cached data we already have
    } finally {
      setRefreshing(false);
    }
  }, [scope.mode === 'mine' ? 'mine' : scope.scene]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1. Immediate cache render
      const cached = await getCachedData<T>(cacheKeyForScope(scope));
      if (cached && !cancelled) setData(cached);
      // 2. Background refresh
      if (!cancelled) await refresh();
    })();
    return () => { cancelled = true; };
  }, [scope.mode === 'mine' ? 'mine' : scope.scene]);

  return { data, refreshing, refresh: () => refresh(true) };
}
```

(`corpus_versions` is a new Tauri command needed in `commands/corpus.rs` — see step 4.)

- [ ] **Step 4: Add `corpus_versions` Rust command** in `commands/corpus.rs`

```rust
#[derive(Serialize, Deserialize, Debug)]
pub struct VersionsResp {
    pub mine: i64,
    pub public: i64,
}

#[tauri::command]
pub async fn corpus_versions<R: Runtime>(
    app: AppHandle<R>,
) -> Result<VersionsResp, String> {
    let token = require_token(&app)?;
    let client = Client::new();
    let resp = client
        .get(format!("{}/corpus/versions", SERVER_BASE))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http_{}", resp.status().as_u16()));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str::<VersionsResp>(&body).map_err(|e| e.to_string())
}
```

Register in `lib.rs`:
```rust
commands::corpus::corpus_versions,
```

- [ ] **Step 5: Implement `useCorpusPhrase.ts`** (parallel to `useCorpusList` but for the detail endpoint)

```ts
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCachedData, setCachedData, invalidate } from '../lib/corpusCache';

const KEY_PREFIX = 'phrase:';

export function useCorpusPhrase<T>(phraseNormalized: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!phraseNormalized) { setData(null); return; }
    setRefreshing(true);
    try {
      const fresh = await invoke<T>('corpus_phrase_detail', { phrase: phraseNormalized });
      await setCachedData(`${KEY_PREFIX}${phraseNormalized}`, fresh);
      setData(fresh);
    } catch {
      // keep stale
    } finally {
      setRefreshing(false);
    }
  }, [phraseNormalized]);

  useEffect(() => {
    let cancelled = false;
    if (!phraseNormalized) { setData(null); return; }
    (async () => {
      const cached = await getCachedData<T>(`${KEY_PREFIX}${phraseNormalized}`);
      if (cached && !cancelled) setData(cached);
      // Phrase detail is volatile (contributions are added often); always re-fetch
      if (!cancelled) await refresh();
    })();
    return () => { cancelled = true; };
  }, [phraseNormalized]);

  return { data, refreshing, refresh };
}

export async function invalidatePhrase(phraseNormalized: string): Promise<void> {
  await invalidate(`${KEY_PREFIX}${phraseNormalized}`);
}
```

- [ ] **Step 6: cargo check + typecheck + tests**

```bash
cd Get_Video/client/src-tauri && cargo check
cd Get_Video/client && pnpm typecheck && pnpm test -- --run
```

- [ ] **Step 7: Commit**

```bash
cd Get_Video
git add client/src/lib/corpusCache.ts client/src/hooks/useCorpusList.ts client/src/hooks/useCorpusPhrase.ts client/src-tauri/src/commands/corpus.rs client/src-tauri/src/lib.rs client/package.json client/pnpm-lock.yaml
git commit -m "feat(client/corpus): tauri-plugin-store cache + useCorpusList + useCorpusPhrase + corpus_versions cmd"
```

---

## Task D16: Refactor 3 corpus components to use the new hooks

**Files:**
- Modify: `Get_Video/client/src/components/CorpusPhraseList.tsx`
- Modify: `Get_Video/client/src/components/CorpusPhraseDetail.tsx`

- [ ] **Step 1: Update `CorpusPhraseList.tsx`** — replace inline `useEffect+invoke` with `useCorpusList`

```tsx
import { useCorpusList } from '../hooks/useCorpusList';

interface MineItem {
  phraseNormalized: string;
  phraseRaw: string;
  meaningZh: string | null;
}
interface PublicItem extends MineItem {
  tags: { scene?: string };
}

interface BrowseResp { items: PublicItem[] }
interface MineResp   { items: MineItem[] }

interface Props {
  scene: string | null;
  selected: string | null;
  onSelect: (phraseNormalized: string) => void;
}

export function CorpusPhraseList({ scene, selected, onSelect }: Props) {
  const { data, refreshing } = useCorpusList<BrowseResp | MineResp>(
    scene === null ? { mode: 'mine' } : { mode: 'browse', scene }
  );

  if (!data) return <div className="p-4 text-zinc-500 text-sm w-64 border-r border-zinc-800">加载中…</div>;
  const items = data.items;
  if (items.length === 0) return <div className="p-4 text-zinc-500 text-sm w-64 border-r border-zinc-800">暂无</div>;

  return (
    <ul className="w-64 border-r border-zinc-800 overflow-y-auto min-w-0">
      {items.map((item) => (
        <li
          key={item.phraseNormalized}
          onClick={() => onSelect(item.phraseNormalized)}
          className={`px-3 py-2 cursor-pointer hover:bg-zinc-800 ${
            selected === item.phraseNormalized ? 'bg-zinc-800' : ''
          }`}
        >
          <div className="text-sm font-medium">{item.phraseRaw}</div>
          {item.meaningZh && (
            <div className="text-xs text-zinc-400 truncate">{item.meaningZh}</div>
          )}
        </li>
      ))}
    </ul>
  );
}
```

Note: the error-state handling (license_required → "需购买后可见") is dropped here since useCorpusList swallows errors. If we want to preserve it, the hook needs to also return an `error` field. For MVP, "no data renders empty" is acceptable.

- [ ] **Step 2: Update `CorpusPhraseDetail.tsx`** — replace inline `useEffect+invoke` with `useCorpusPhrase`

```tsx
import { useState } from 'react';
import { useCorpusPhrase } from '../hooks/useCorpusPhrase';
import { YouTubeEmbed, parseYouTubeUrl } from './YouTubeEmbed';

interface Contribution {
  id: number;
  contextSentence: string;
  source: { kind: string; url: string; title?: string; timestampSec?: number };
  contributedAt: number;
}
interface PhraseDetail {
  phrase: { phraseNormalized: string; phraseRaw: string; meaningZh: string | null };
  publicContributions: Contribution[];
  personalContributions: Contribution[];
}

interface Props { phraseNormalized: string | null }

export function CorpusPhraseDetail({ phraseNormalized }: Props) {
  const { data: detail } = useCorpusPhrase<PhraseDetail>(phraseNormalized);
  const [selectedInstance, setSelectedInstance] = useState<Contribution | null>(null);

  if (!phraseNormalized) {
    return <div className="flex-1 p-6 text-zinc-500">选择一个短语查看实例</div>;
  }
  if (!detail) return <div className="flex-1 p-6 text-zinc-500">加载中…</div>;

  // ... rest of the component identical to Plan C C13, just using `detail` instead of state
  const instance = selectedInstance ?? detail.publicContributions[0] ?? detail.personalContributions[0] ?? null;
  const parsed = instance ? parseYouTubeUrl(instance.source.url) : null;

  return (
    <div className="flex-1 p-4 overflow-y-auto space-y-4 min-w-0">
      <div>
        <h2 className="text-xl font-semibold">{detail.phrase.phraseRaw}</h2>
        {detail.phrase.meaningZh && (
          <p className="text-zinc-400 mt-1">{detail.phrase.meaningZh}</p>
        )}
      </div>
      {parsed && <YouTubeEmbed videoId={parsed.videoId} startSec={parsed.startSec} />}
      {detail.publicContributions.length > 0 && (
        <section>
          <h3 className="text-sm text-zinc-400 mb-2">📚 公共实例</h3>
          <ul className="space-y-1">
            {detail.publicContributions.map((c) => (
              <li key={c.id} onClick={() => setSelectedInstance(c)}
                  className={`px-3 py-2 rounded text-sm cursor-pointer hover:bg-zinc-800 ${
                    instance?.id === c.id ? 'bg-zinc-800' : 'bg-zinc-900'
                  }`}>
                {c.source.title && <div className="text-xs text-zinc-500">{c.source.title}</div>}
                <div>{c.contextSentence}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {detail.personalContributions.length > 0 && (
        <section>
          <h3 className="text-sm text-zinc-400 mb-2">⭐ 你的实例</h3>
          <ul className="space-y-1">
            {detail.personalContributions.map((c) => (
              <li key={c.id} onClick={() => setSelectedInstance(c)}
                  className={`px-3 py-2 rounded text-sm cursor-pointer hover:bg-zinc-800 ${
                    instance?.id === c.id ? 'bg-zinc-800' : 'bg-zinc-900'
                  }`}>
                {c.source.title && <div className="text-xs text-zinc-500">{c.source.title}</div>}
                <div>{c.contextSentence}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 3: typecheck + tests**

```bash
pnpm typecheck
pnpm test -- --run
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/CorpusPhraseList.tsx client/src/components/CorpusPhraseDetail.tsx
git commit -m "refactor(client/corpus): components use cache-aware hooks"
```

---

## Task D17: Wire refresh button into Corpus page

**Files:**
- Modify: `Get_Video/client/src/pages/Corpus.tsx`
- Modify: `Get_Video/client/src/lib/corpusCache.ts` — add `invalidateAll`

- [ ] **Step 1: Add `invalidateAll` helper** to `corpusCache.ts`

```ts
export async function invalidateAll(): Promise<void> {
  await store().clear();
  await store().save();
}
```

- [ ] **Step 2: Update Corpus.tsx** to pass refresh handler to nav

```tsx
import { useState } from 'react';
import { CorpusSceneTree } from '../components/CorpusSceneTree';
import { CorpusPhraseList } from '../components/CorpusPhraseList';
import { CorpusPhraseDetail } from '../components/CorpusPhraseDetail';
import { CorpusNav } from '../components/CorpusNav';
import { invalidateAll } from '../lib/corpusCache';

export function Corpus() {
  const [scene, setScene] = useState<string | null>('social');
  const [phrase, setPhrase] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    await invalidateAll();
    setRefreshKey((k) => k + 1);  // forces hooks to re-mount + re-fetch
    setRefreshing(false);
  };

  return (
    <div key={refreshKey} className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <CorpusNav onRefresh={handleRefresh} refreshing={refreshing} />
      <div className="flex flex-1 overflow-hidden">
        <CorpusSceneTree selected={scene} onSelect={(s) => { setScene(s); setPhrase(null); }} />
        <CorpusPhraseList scene={scene} selected={phrase} onSelect={setPhrase} />
        <CorpusPhraseDetail phraseNormalized={phrase} />
      </div>
    </div>
  );
}
```

The `key={refreshKey}` trick forces the inner subtree to remount when refresh fires, causing the hooks' useEffect to re-run from scratch with cleared caches.

- [ ] **Step 3: typecheck + tests**

```bash
pnpm typecheck
pnpm test -- --run
```

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/corpusCache.ts client/src/pages/Corpus.tsx
git commit -m "feat(client/corpus): ↻ refresh button invalidates cache + re-fetches"
```

---

## Task D18: Local verification

- [ ] **Step 1: Full Rust check**

```bash
cd Get_Video/client/src-tauri
cargo check
cargo clippy --no-deps 2>&1 | tail -10
```

Expected: 0 new warnings from Plan D code (pre-existing warnings are out of scope).

- [ ] **Step 2: Full frontend check**

```bash
cd Get_Video/client
pnpm typecheck
pnpm test -- --run
pnpm build
```

Expected: all green.

- [ ] **Step 3: Local Tauri smoke** (manual; needs server deploy from D9)

```bash
cd Get_Video/client
pnpm tauri dev
```

Manual checklist (mark each):

- [ ] App opens; no AuthCard, no email prompt
- [ ] Already-activated license → straight to Library (or whatever the post-LicenseGate landing is)
- [ ] Top nav has "📚 语料库" link
- [ ] Click 公共语料库 → 3-column layout with top nav visible (back path to 字幕本 + 设置 works)
- [ ] First time: empty caches; second time: 立即渲染 (instant) without flicker
- [ ] Click a scene → middle column either shows data or "暂无" (depending on what's been 推送更新 by you)
- [ ] Click a phrase → right column renders detail + YouTube iframe + 公共/你的 sections
- [ ] ↻ refresh button → spinner briefly, list refreshes
- [ ] Settings → 退出登录 → app re-auths automatically via license-key (no email form)
- [ ] `/vocab` URL → redirects to `/corpus` (existing behavior from C15)

- [ ] **Step 4: NO push, NO bundle.**

```bash
git log --oneline origin/main..HEAD
echo "Plan D phase B (desktop) complete locally. Awaiting user push approval."
```

If the user wants to ship desktop changes later: `git push origin main`.

---

## Self-Review

**Spec coverage:**
- §1 auth-from-license — D3 (server), D10 (rust cmd), D11 (TS store), D12 (gate component), D13 (delete AuthCard)
- §2 versions + publish workflow — D1 (schema), D2 (db methods), D4 (versions endpoint), D5 (publish endpoint), D6 (browse + lookup filter), D7 (admin list extras)
- §3 admin SPA — D8
- §4 desktop auto-login — D10-D13
- §5 corpus nav — D14
- §6 cache layer — D15, D16, D17
- §7 deploy — D9 (server only); desktop local only per spec

**Placeholders:** Scanned. No "TBD" / "implement later" / vague directives. Some "if existing structure differs, adapt" notes (D12 license-key lookup; D14 nav matching Library.tsx) — these are flagged as conditional adaptations, not unresolved gaps.

**Type consistency:**
- `authFromLicense` signature: store action D11, used by D12 gate
- `corpus_versions` Rust cmd: D15 defines, D15's `useCorpusList` hook consumes
- `VersionsResp` shape (`mine: number, public: number`): server D4, Rust D15
- `useCorpusList` scope shape (`{mode:'mine'} | {mode:'browse', scene}`): D15 defines, D16 uses

**Known assumptions (not blockers):**
- D12 assumes a `useLicense` store exists with `licenseKey` field. If the actual store is named differently (e.g. `useLicenseGate`), implementer adapts. The principle stays: read license key from existing store.
- D14 assumes Library.tsx's nav is the canonical pattern. If Library uses a different layout (e.g. `<TopBar />` component), implementer reuses that instead.

Ready for execution.
