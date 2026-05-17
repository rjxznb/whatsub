# whatsub Shared Corpus · Plan 2 · Backend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the shared-corpus backend on the existing `whatsub.eversay.cc` Hono server: PostgreSQL schema for phrases + contributions, five JSON API routes with rate-limit / blocklist / URL canonicalization, an async LLM-tagging worker, and a seed script that bootstraps the corpus from the desktop pipeline's already-analyzed video data.

**Architecture:** Add `/api/corpus/*` routes to the existing Hono app, sharing the same node-postgres pool used by license activation. Async classification runs as a `pg-boss` job queue worker in the same Node process — keeps deployment one-binary. URL canonicalization + blocklist run inline in the contribute handler (cheap). Rate limit uses PostgreSQL `INSERT … ON CONFLICT` counters in a `rate_buckets` table (no Redis dependency). Seed script is a one-shot Python that reads existing `data/videos/*/*/{video_id}.analysis.json` and POSTs to `/api/corpus/contribute` with `contributorId = "whatsub-curator"`, leveraging the curator bypass to skip rate limits and LLM classification.

**Tech Stack:** Hono · node-postgres · PostgreSQL 15 · pg-boss (job queue) · Vitest · @hono/testing · testcontainers-pg · Python 3.9 (seed script) · DeepSeek API (classification, ~$0.0001/phrase)

---

## Repository layout

This plan touches **two repositories**:

### `rjxznb/whatsub-license` (separate repo from this one)

| Path | Responsibility |
|---|---|
| `src/db/migrations/004_corpus.sql` | DDL for `corpus_phrases` + `corpus_contributions` + `rate_buckets` + `corpus_blocklist` |
| `src/db/corpus.ts` | Typed query module for both corpus tables |
| `src/db/rateLimit.ts` | Atomic rate-bucket counter queries |
| `src/db/blocklist.ts` | Blocklist hot-cache + lookup |
| `src/routes/corpus.ts` | All five Hono route handlers |
| `src/middleware/rateLimit.ts` | Hono middleware applied to contribute + flag routes |
| `src/middleware/contributorIdRequired.ts` | Body / header validator for contributorId presence |
| `src/utils/canonicalizeUrl.ts` | Strip utm_*, fbclid, gclid, OAuth tokens, fragments; YouTube URL normalization |
| `src/utils/normalizeExpression.ts` | Copy of plugin's `normalizeExpression` (server side dedupe key) |
| `src/workers/classifier.ts` | pg-boss worker that consumes `phrase-classify` jobs |
| `src/llm/classify.ts` | DeepSeek call returning `{ scene, partOfSpeech, cefrLevel }` |
| `src/llm/types.ts` | DeepSeek request/response types (no external SDK) |
| `src/index.ts` (modify) | Mount `corpus.ts` routes + start classifier worker on boot |
| `tests/corpus/migrations.test.ts` | Schema sanity tests via testcontainers |
| `tests/corpus/canonicalizeUrl.test.ts` | URL canonicalization unit tests |
| `tests/corpus/normalizeExpression.test.ts` | Match plugin behavior exactly |
| `tests/corpus/rateLimit.test.ts` | Concurrent increment correctness |
| `tests/corpus/contribute.test.ts` | POST /contribute end-to-end (mocked LLM) |
| `tests/corpus/lookup.test.ts` | GET /lookup integration |
| `tests/corpus/flag.test.ts` | POST /flag + auto-hide threshold |
| `tests/corpus/mine.test.ts` | DELETE /mine bulk-delete |
| `tests/corpus/classifier.test.ts` | Worker reads job + writes tags |

### This repo (`Get_Video`)

| Path | Responsibility |
|---|---|
| `scripts/seed_corpus.py` | One-shot CLI that walks `data/videos/*/*/analysis.json` and POSTs curator contributions |
| `scripts/seed_corpus_test.py` | Pytest unit tests for the seed script's parsing + idempotency |
| `scripts/seed_corpus_README.md` | Usage notes (run mode, dry-run, expected count, rerunnability) |

---

## Task list

### Task 1: PostgreSQL schema migration (corpus tables)

**Files:**
- Create (in `whatsub-license`): `src/db/migrations/004_corpus.sql`
- Test: `tests/corpus/migrations.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/corpus/migrations.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { startPg, runMigrations } from "../helpers/pg";

describe("004_corpus migration", () => {
  let db: Awaited<ReturnType<typeof startPg>>;
  beforeAll(async () => {
    db = await startPg();
    await runMigrations(db.pool);
  });

  it("creates corpus_phrases with required columns + tags JSONB", async () => {
    const { rows } = await db.pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name='corpus_phrases'`
    );
    const map = Object.fromEntries(rows.map(r => [r.column_name, r.data_type]));
    expect(map.phrase_normalized).toBe("text");
    expect(map.tags).toBe("jsonb");
    expect(map.contribution_count).toBe("integer");
  });

  it("creates corpus_contributions with FK to phrases", async () => {
    const { rows } = await db.pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='corpus_contributions'`
    );
    const names = rows.map(r => r.column_name);
    expect(names).toEqual(expect.arrayContaining([
      "id", "phrase_normalized", "context_sentence", "source", "contributor_id", "contributed_at", "hidden"
    ]));
  });

  it("creates rate_buckets + corpus_blocklist", async () => {
    const { rows } = await db.pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`
    );
    const names = rows.map(r => r.table_name);
    expect(names).toEqual(expect.arrayContaining(["rate_buckets", "corpus_blocklist"]));
  });
});
```

(Assumes `tests/helpers/pg.ts` already exists in the license repo for testcontainers spin-up; if not, that's a one-task prereq covered by the existing license tests.)

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm vitest run tests/corpus/migrations.test.ts`
Expected: FAIL — migration file doesn't exist; pg complains "relation does not exist"

- [ ] **Step 3: Implement migration**

```sql
-- src/db/migrations/004_corpus.sql

-- One row per distinct normalized phrase, holds aggregate counts + classification tags.
CREATE TABLE corpus_phrases (
  phrase_normalized      TEXT PRIMARY KEY,
  phrase_raw             TEXT NOT NULL,
  tags                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  classified_at          BIGINT,                              -- unix ms, null = pending
  contribution_count     INTEGER NOT NULL DEFAULT 0,
  first_seen_at          BIGINT NOT NULL,
  last_seen_at           BIGINT NOT NULL
);

CREATE INDEX idx_corpus_phrases_scene
  ON corpus_phrases ((tags->>'scene'));
CREATE INDEX idx_corpus_phrases_cefr
  ON corpus_phrases ((tags->>'cefrLevel'));
CREATE INDEX idx_corpus_phrases_pos
  ON corpus_phrases ((tags->>'partOfSpeech'));

-- One row per user save; multiple per phrase.
CREATE TABLE corpus_contributions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phrase_normalized      TEXT NOT NULL REFERENCES corpus_phrases(phrase_normalized) ON DELETE CASCADE,
  context_sentence       TEXT NOT NULL,
  source                 JSONB NOT NULL,                      -- { kind, url, title, timestampSec? }
  contributor_id         TEXT NOT NULL,
  contributed_at         BIGINT NOT NULL,
  flagged                BOOLEAN NOT NULL DEFAULT FALSE,
  flag_count             INTEGER NOT NULL DEFAULT 0,
  hidden                 BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_corpus_contrib_phrase_active
  ON corpus_contributions (phrase_normalized, contributed_at DESC)
  WHERE hidden = FALSE;
CREATE INDEX idx_corpus_contrib_contributor
  ON corpus_contributions (contributor_id);
CREATE INDEX idx_corpus_contrib_flagged
  ON corpus_contributions (hidden, flag_count DESC)
  WHERE hidden = FALSE AND flag_count > 0;

-- Sliding-window rate limit buckets. Key = (contributor_id, bucket_kind, bucket_id).
-- bucket_kind: 'minute' | 'day'. bucket_id = floor(now / window_sec).
CREATE TABLE rate_buckets (
  contributor_id         TEXT NOT NULL,
  bucket_kind            TEXT NOT NULL,
  bucket_id              BIGINT NOT NULL,
  count                  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (contributor_id, bucket_kind, bucket_id)
);

-- Keyword blocklist with hot-cache via timestamp invalidation.
CREATE TABLE corpus_blocklist (
  term                   TEXT PRIMARY KEY,                    -- lower-cased
  added_at               BIGINT NOT NULL,
  added_by               TEXT NOT NULL                        -- admin handle
);
```

- [ ] **Step 4: Run test, verify PASS**

Run: same as Step 2
Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/004_corpus.sql tests/corpus/migrations.test.ts
git commit -m "feat(corpus): tables for phrases, contributions, rate_buckets, blocklist"
```

---

### Task 2: URL canonicalization utility

**Files:**
- Create: `src/utils/canonicalizeUrl.ts`
- Test: `tests/corpus/canonicalizeUrl.test.ts`

- [ ] **Step 1: Write failing test (spec §7.4)**

```ts
// tests/corpus/canonicalizeUrl.test.ts
import { describe, it, expect } from "vitest";
import { canonicalizeUrl } from "../../src/utils/canonicalizeUrl";

describe("canonicalizeUrl", () => {
  it("strips utm_* params", () => {
    expect(canonicalizeUrl("https://example.com/article?utm_source=twitter&utm_campaign=x&id=42"))
      .toBe("https://example.com/article?id=42");
  });

  it("strips fbclid, gclid, fragments", () => {
    expect(canonicalizeUrl("https://example.com/?fbclid=abc#section1"))
      .toBe("https://example.com/");
    expect(canonicalizeUrl("https://example.com/?gclid=z"))
      .toBe("https://example.com/");
  });

  it("strips common OAuth tokens", () => {
    expect(canonicalizeUrl("https://app.com/?access_token=xxx&id_token=yyy&keep=1"))
      .toBe("https://app.com/?keep=1");
  });

  it("normalizes all YouTube URL variants to https://youtu.be/<id>?t=<sec>", () => {
    const cases: [string, string][] = [
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=46s", "https://youtu.be/dQw4w9WgXcQ?t=46"],
      ["https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=46", "https://youtu.be/dQw4w9WgXcQ?t=46"],
      ["https://youtu.be/dQw4w9WgXcQ?t=46s", "https://youtu.be/dQw4w9WgXcQ?t=46"],
      ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=46", "https://youtu.be/dQw4w9WgXcQ?t=46"],
      ["https://youtube.com/watch?v=abc", "https://youtu.be/abc"],
    ];
    for (const [input, expected] of cases) {
      expect(canonicalizeUrl(input)).toBe(expected);
    }
  });

  it("rejects URL > 500 chars (returns null per spec §7.4)", () => {
    const long = "https://x.com/?q=" + "a".repeat(600);
    expect(canonicalizeUrl(long)).toBeNull();
  });

  it("rejects non-http(s) schemes", () => {
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalizeUrl("data:text/html,...")).toBeNull();
    expect(canonicalizeUrl("file:///etc/passwd")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm vitest run tests/corpus/canonicalizeUrl.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/utils/canonicalizeUrl.ts
const STRIP_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "fbclid", "gclid", "msclkid", "dclid", "yclid",
  "access_token", "id_token", "refresh_token", "code", "state",
  "_ga", "_gl", "ref", "ref_src", "feature",
]);

const YT_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com",
  "youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com",
]);

/** Returns null when URL is invalid, too long, or non-http(s). Per spec §7.4. */
export function canonicalizeUrl(input: string): string | null {
  if (input.length > 500) return null;
  let u: URL;
  try { u = new URL(input); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  // YouTube special case — always normalize to https://youtu.be/<id>?t=<sec>
  if (YT_HOSTS.has(u.hostname)) {
    const ytId = extractYouTubeId(u);
    if (!ytId) return null;
    const sec = extractYouTubeStartSec(u);
    const path = `https://youtu.be/${ytId}`;
    return sec > 0 ? `${path}?t=${sec}` : path;
  }

  // Strip known tracking + token params
  for (const k of Array.from(u.searchParams.keys())) {
    const lower = k.toLowerCase();
    if (STRIP_PARAMS.has(lower) || lower.startsWith("utm_")) u.searchParams.delete(k);
  }
  u.hash = "";
  return u.toString();
}

function extractYouTubeId(u: URL): string | null {
  if (u.hostname === "youtu.be") {
    const id = u.pathname.replace(/^\//, "").split("/")[0];
    return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
  }
  if (u.pathname.startsWith("/embed/")) {
    const id = u.pathname.replace(/^\/embed\//, "").split("/")[0];
    return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
  }
  const v = u.searchParams.get("v");
  return v && /^[A-Za-z0-9_-]{6,}$/.test(v) ? v : null;
}

function extractYouTubeStartSec(u: URL): number {
  const raw = u.searchParams.get("t") ?? u.searchParams.get("start") ?? "";
  if (!raw) return 0;
  const num = parseInt(raw.replace(/s$/, ""), 10);
  return Number.isFinite(num) && num > 0 ? num : 0;
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/utils/canonicalizeUrl.ts tests/corpus/canonicalizeUrl.test.ts
git commit -m "feat(corpus): URL canonicalization per spec §7.4"
```

---

### Task 3: normalizeExpression (server side, byte-for-byte match plugin)

**Files:**
- Create: `src/utils/normalizeExpression.ts`
- Test: `tests/corpus/normalizeExpression.test.ts`

The plugin and server MUST normalize phrases identically — otherwise `phraseNormalized` keys diverge and dedupe breaks. The plugin's version lives in `packages/llm-core/src/normalizeExpression.ts`; mirror its behavior exactly.

- [ ] **Step 1: Write failing test (mirroring plugin behavior)**

```ts
// tests/corpus/normalizeExpression.test.ts
import { describe, it, expect } from "vitest";
import { normalizeExpression } from "../../src/utils/normalizeExpression";

describe("normalizeExpression", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeExpression("  Save  Up   MONEY  ")).toBe("save up money");
  });
  it("strips surrounding punctuation", () => {
    expect(normalizeExpression('"save up money,"')).toBe("save up money");
    expect(normalizeExpression("(save up money)")).toBe("save up money");
  });
  it("preserves internal punctuation", () => {
    expect(normalizeExpression("save-up money")).toBe("save-up money");
    expect(normalizeExpression("can't")).toBe("can't");
  });
  it("returns empty string for empty / whitespace input", () => {
    expect(normalizeExpression("   ")).toBe("");
    expect(normalizeExpression("")).toBe("");
  });
});
```

- [ ] **Step 2: Run test, verify failure**

- [ ] **Step 3: Implement (matches `packages/llm-core/src/normalizeExpression.ts`)**

```ts
// src/utils/normalizeExpression.ts
/**
 * Server-side mirror of @whatsub/llm-core's normalizeExpression.
 * MUST stay byte-identical with the plugin version — if you change one, change the other,
 * else corpus dedup keys will diverge.
 */
export function normalizeExpression(raw: string): string {
  if (!raw) return "";
  // Strip outer whitespace + outer punctuation, lowercase, collapse internal whitespace
  let s = raw.trim().toLowerCase();
  // Strip outer paired / common punctuation
  s = s.replace(/^[\s"'\(\)\[\]\{\}.,;:!?，。；：！？""'']+/u, "")
       .replace(/[\s"'\(\)\[\]\{\}.,;:!?，。；：！？""'']+$/u, "");
  // Collapse internal whitespace
  s = s.replace(/\s+/g, " ");
  return s;
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/utils/normalizeExpression.ts tests/corpus/normalizeExpression.test.ts
git commit -m "feat(corpus): server-side normalizeExpression mirroring plugin"
```

---

### Task 4: Typed corpus query module

**Files:**
- Create: `src/db/corpus.ts`

This is a pure-function CRUD layer. Tested transitively via the route tests; no dedicated unit tests.

- [ ] **Step 1: Implement**

```ts
// src/db/corpus.ts
import type { Pool } from "pg";

export interface CorpusPhraseRow {
  phrase_normalized: string;
  phrase_raw: string;
  tags: Record<string, string | number | null>;
  classified_at: number | null;
  contribution_count: number;
  first_seen_at: number;
  last_seen_at: number;
}

export interface CorpusContributionRow {
  id: string;
  phrase_normalized: string;
  context_sentence: string;
  source: { kind: "youtube" | "web" | "curator"; url: string; title: string; timestampSec?: number };
  contributor_id: string;
  contributed_at: number;
  hidden: boolean;
  flag_count: number;
}

export interface ContributeInput {
  phraseRaw: string;
  phraseNormalized: string;
  contextSentence: string;
  source: CorpusContributionRow["source"];
  contributorId: string;
  now: number;
}

export async function contribute(
  pool: Pool,
  input: ContributeInput,
): Promise<{ contributionId: string; classificationNeeded: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Upsert phrase
    const phraseRes = await client.query<{ classified_at: number | null }>(`
      INSERT INTO corpus_phrases (phrase_normalized, phrase_raw, first_seen_at, last_seen_at, contribution_count)
      VALUES ($1, $2, $3, $3, 1)
      ON CONFLICT (phrase_normalized) DO UPDATE
      SET last_seen_at = EXCLUDED.last_seen_at,
          contribution_count = corpus_phrases.contribution_count + 1
      RETURNING classified_at
    `, [input.phraseNormalized, input.phraseRaw, input.now]);

    const classificationNeeded = phraseRes.rows[0].classified_at === null;

    // Insert contribution
    const contribRes = await client.query<{ id: string }>(`
      INSERT INTO corpus_contributions (phrase_normalized, context_sentence, source, contributor_id, contributed_at)
      VALUES ($1, $2, $3::jsonb, $4, $5)
      RETURNING id
    `, [input.phraseNormalized, input.contextSentence, JSON.stringify(input.source), input.contributorId, input.now]);

    await client.query("COMMIT");
    return { contributionId: contribRes.rows[0].id, classificationNeeded };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function lookup(
  pool: Pool,
  phraseNormalized: string,
  excludeContributorId: string | null,
  limit = 10,
): Promise<{ phrase: CorpusPhraseRow | null; contributions: CorpusContributionRow[] }> {
  const phrase = await pool.query<CorpusPhraseRow>(`
    SELECT * FROM corpus_phrases WHERE phrase_normalized = $1
  `, [phraseNormalized]);
  if (phrase.rowCount === 0) return { phrase: null, contributions: [] };

  const contribsQ = excludeContributorId
    ? `SELECT * FROM corpus_contributions
         WHERE phrase_normalized = $1 AND hidden = FALSE AND contributor_id <> $2
         ORDER BY contributed_at DESC LIMIT $3`
    : `SELECT * FROM corpus_contributions
         WHERE phrase_normalized = $1 AND hidden = FALSE
         ORDER BY contributed_at DESC LIMIT $2`;
  const args = excludeContributorId
    ? [phraseNormalized, excludeContributorId, limit]
    : [phraseNormalized, limit];
  const contribs = await pool.query<CorpusContributionRow>(contribsQ, args);
  return { phrase: phrase.rows[0], contributions: contribs.rows };
}

export async function flag(pool: Pool, contributionId: string): Promise<{ hiddenNow: boolean }> {
  const r = await pool.query<{ flag_count: number; hidden: boolean }>(`
    UPDATE corpus_contributions
       SET flag_count = flag_count + 1,
           flagged = TRUE,
           hidden = (flag_count + 1 >= 3)
     WHERE id = $1
     RETURNING flag_count, hidden
  `, [contributionId]);
  return { hiddenNow: r.rows[0]?.hidden ?? false };
}

export async function deleteByContributor(
  pool: Pool, contributorId: string,
): Promise<{ deletedCount: number }> {
  const r = await pool.query(`
    DELETE FROM corpus_contributions WHERE contributor_id = $1
  `, [contributorId]);
  return { deletedCount: r.rowCount ?? 0 };
}

export async function browse(
  pool: Pool,
  filter: { scene?: string; cefr?: string; limit: number; offset: number },
): Promise<{ phrases: CorpusPhraseRow[]; total: number }> {
  const conds: string[] = [];
  const args: unknown[] = [];
  if (filter.scene) { args.push(filter.scene); conds.push(`tags->>'scene' = $${args.length}`); }
  if (filter.cefr) { args.push(filter.cefr); conds.push(`tags->>'cefrLevel' = $${args.length}`); }
  const where = conds.length > 0 ? "WHERE " + conds.join(" AND ") : "";
  args.push(filter.limit, filter.offset);
  const phrases = await pool.query<CorpusPhraseRow>(
    `SELECT * FROM corpus_phrases ${where} ORDER BY contribution_count DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args,
  );
  const total = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM corpus_phrases ${where}`,
    args.slice(0, args.length - 2),
  );
  return { phrases: phrases.rows, total: parseInt(total.rows[0].count, 10) };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/db/corpus.ts
git commit -m "feat(corpus): typed CRUD module"
```

---

### Task 5: Rate-limit module (atomic increment)

**Files:**
- Create: `src/db/rateLimit.ts`
- Test: `tests/corpus/rateLimit.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/corpus/rateLimit.test.ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { startPg, runMigrations } from "../helpers/pg";
import { tryConsume } from "../../src/db/rateLimit";

describe("rateLimit", () => {
  let db: Awaited<ReturnType<typeof startPg>>;
  beforeAll(async () => { db = await startPg(); await runMigrations(db.pool); });
  beforeEach(async () => { await db.pool.query("TRUNCATE rate_buckets"); });

  it("allows up to limit, then rejects (per-minute)", async () => {
    const cid = "test-user-1";
    const now = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      const ok = await tryConsume(db.pool, cid, "minute", now);
      expect(ok).toBe(true);
    }
    expect(await tryConsume(db.pool, cid, "minute", now)).toBe(false);
  });

  it("rolls over when bucket window advances", async () => {
    const cid = "test-user-2";
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) await tryConsume(db.pool, cid, "minute", t0);
    expect(await tryConsume(db.pool, cid, "minute", t0)).toBe(false);
    // Advance 61s
    expect(await tryConsume(db.pool, cid, "minute", t0 + 61_000)).toBe(true);
  });

  it("daily bucket allows 100 per day", async () => {
    const cid = "test-user-3";
    const now = 1_700_000_000_000;
    for (let i = 0; i < 100; i++) {
      expect(await tryConsume(db.pool, cid, "day", now)).toBe(true);
    }
    expect(await tryConsume(db.pool, cid, "day", now)).toBe(false);
  });

  it("two concurrent calls don't double-count beyond limit", async () => {
    const cid = "test-user-4";
    const now = 1_700_000_000_000;
    const promises = Array.from({ length: 20 }, () => tryConsume(db.pool, cid, "minute", now));
    const results = await Promise.all(promises);
    expect(results.filter(Boolean).length).toBe(5);  // 5/min limit
  });
});
```

- [ ] **Step 2: Run test, verify failure**

- [ ] **Step 3: Implement**

```ts
// src/db/rateLimit.ts
import type { Pool } from "pg";

const LIMITS = { minute: 5, day: 100 } as const;
const WINDOW_MS = { minute: 60_000, day: 86_400_000 } as const;

export type BucketKind = keyof typeof LIMITS;

/**
 * Atomically consume one token from the (contributorId, kind, current bucket) counter.
 * Returns true if allowed, false if limit exceeded.
 * Per spec §7.4: 100/day, 5/min per contributorId.
 */
export async function tryConsume(
  pool: Pool, contributorId: string, kind: BucketKind, now: number,
): Promise<boolean> {
  const bucketId = Math.floor(now / WINDOW_MS[kind]);
  const limit = LIMITS[kind];
  // INSERT ... ON CONFLICT UPDATE RETURNING is atomic.
  // We bump count by 1; if pre-update count was already >= limit, the row's new count
  // is limit+1 — caller checks via RETURNING new count <= limit.
  const r = await pool.query<{ count: number }>(`
    INSERT INTO rate_buckets (contributor_id, bucket_kind, bucket_id, count)
    VALUES ($1, $2, $3, 1)
    ON CONFLICT (contributor_id, bucket_kind, bucket_id) DO UPDATE
    SET count = rate_buckets.count + 1
    RETURNING count
  `, [contributorId, kind, bucketId]);
  return r.rows[0].count <= limit;
}

/** Curator contributorId bypasses all rate limits. */
export const CURATOR_ID = "whatsub-curator";
export function isExempt(contributorId: string): boolean {
  return contributorId === CURATOR_ID;
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/db/rateLimit.ts tests/corpus/rateLimit.test.ts
git commit -m "feat(corpus): atomic per-minute + per-day rate limit"
```

---

### Task 6: Blocklist module + cache

**Files:**
- Create: `src/db/blocklist.ts`

- [ ] **Step 1: Implement**

```ts
// src/db/blocklist.ts
import type { Pool } from "pg";

const CACHE_TTL_MS = 5 * 60_000;
let cache: { terms: Set<string>; loadedAt: number } | null = null;

/** Lower-cased contains-check. Returns true if phrase normalizedExpression
 *  matches or contains any blocklisted term. */
export async function isBlocked(pool: Pool, normalizedPhrase: string): Promise<boolean> {
  if (!cache || Date.now() - cache.loadedAt > CACHE_TTL_MS) {
    const r = await pool.query<{ term: string }>(`SELECT term FROM corpus_blocklist`);
    cache = { terms: new Set(r.rows.map(x => x.term)), loadedAt: Date.now() };
  }
  if (cache.terms.has(normalizedPhrase)) return true;
  for (const t of cache.terms) {
    if (normalizedPhrase.includes(t)) return true;
  }
  return false;
}

export function invalidateBlocklistCache() { cache = null; }
```

- [ ] **Step 2: Seed blocklist with starter terms in a fresh migration**

```sql
-- src/db/migrations/005_corpus_blocklist_seed.sql
INSERT INTO corpus_blocklist (term, added_at, added_by) VALUES
  ('nigger', 1747440000000, 'system'),
  ('faggot', 1747440000000, 'system'),
  ('porn', 1747440000000, 'system'),
  -- (extend list privately; this is illustrative — actual list maintained out of band)
  ('rape', 1747440000000, 'system')
ON CONFLICT (term) DO NOTHING;
```

- [ ] **Step 3: Commit**

```bash
git add src/db/blocklist.ts src/db/migrations/005_corpus_blocklist_seed.sql
git commit -m "feat(corpus): blocklist cache + starter terms"
```

---

### Task 7: Rate-limit + contributorId Hono middleware

**Files:**
- Create: `src/middleware/contributorIdRequired.ts`
- Create: `src/middleware/rateLimit.ts`

- [ ] **Step 1: Implement contributorIdRequired**

```ts
// src/middleware/contributorIdRequired.ts
import type { MiddlewareHandler } from "hono";

/** Asserts request body has a non-empty `contributorId`.
 *  Reads body once, stashes parsed JSON in `c.set('body')`. */
export const contributorIdRequired: MiddlewareHandler = async (c, next) => {
  try {
    const body = await c.req.json();
    if (!body?.contributorId || typeof body.contributorId !== "string") {
      return c.json({ ok: false, reason: "missing_contributor_id" }, 400);
    }
    c.set("body", body);
    await next();
  } catch {
    return c.json({ ok: false, reason: "malformed_json" }, 400);
  }
};
```

- [ ] **Step 2: Implement rateLimit middleware**

```ts
// src/middleware/rateLimit.ts
import type { MiddlewareHandler } from "hono";
import { tryConsume, isExempt } from "../db/rateLimit";

export const rateLimit: MiddlewareHandler = async (c, next) => {
  const body = c.get("body") as { contributorId: string };
  if (isExempt(body.contributorId)) {
    await next();
    return;
  }
  const pool = c.get("pool");
  const now = Date.now();
  const okMin = await tryConsume(pool, body.contributorId, "minute", now);
  if (!okMin) return c.json({ ok: false, reason: "rate_limited", window: "minute" }, 429);
  const okDay = await tryConsume(pool, body.contributorId, "day", now);
  if (!okDay) return c.json({ ok: false, reason: "rate_limited", window: "day" }, 429);
  await next();
};
```

- [ ] **Step 3: Commit**

```bash
git add src/middleware/
git commit -m "feat(corpus): contributorIdRequired + rateLimit middleware"
```

---

### Task 8: POST /api/corpus/contribute route

**Files:**
- Create: `src/routes/corpus.ts` (full file — other routes added in later tasks)
- Test: `tests/corpus/contribute.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/corpus/contribute.test.ts
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { testClient } from "hono/testing";
import { Hono } from "hono";
import { mountCorpus } from "../../src/routes/corpus";
import { startPg, runMigrations } from "../helpers/pg";

describe("POST /api/corpus/contribute", () => {
  let db: Awaited<ReturnType<typeof startPg>>;
  let app: ReturnType<typeof testClient>;
  beforeAll(async () => {
    db = await startPg();
    await runMigrations(db.pool);
    const h = new Hono();
    h.use("*", async (c, next) => { c.set("pool", db.pool); await next(); });
    mountCorpus(h, { enqueueClassify: vi.fn() });
    app = testClient(h);
  });
  beforeEach(async () => {
    await db.pool.query("TRUNCATE corpus_phrases CASCADE; TRUNCATE rate_buckets; TRUNCATE corpus_blocklist;");
  });

  const body = (overrides: Partial<{ phraseRaw: string; contextSentence: string; source: any; contributorId: string }>) => ({
    phraseRaw: "save up money",
    contextSentence: "I really need to save up money for next semester.",
    source: { kind: "youtube", url: "https://www.youtube.com/watch?v=abc&t=46s", title: "Budget tips" },
    contributorId: "11111111-1111-1111-1111-111111111111",
    ...overrides,
  });

  it("inserts phrase + contribution; returns 201", async () => {
    const r = await app.api.corpus.contribute.$post({ json: body({}) as any });
    expect(r.status).toBe(201);
    const json: any = await r.json();
    expect(json.id).toBeTruthy();
    expect(json.phrase.tags).toEqual({});
  });

  it("dedupes phrase but creates new contribution on second save", async () => {
    await app.api.corpus.contribute.$post({ json: body({}) as any });
    await app.api.corpus.contribute.$post({ json: body({ contributorId: "22222222-2222-2222-2222-222222222222" }) as any });
    const phrases = await db.pool.query(`SELECT contribution_count FROM corpus_phrases`);
    const contribs = await db.pool.query(`SELECT COUNT(*) FROM corpus_contributions`);
    expect(phrases.rows[0].contribution_count).toBe(2);
    expect(parseInt(contribs.rows[0].count)).toBe(2);
  });

  it("canonicalizes YouTube URL to youtu.be form", async () => {
    await app.api.corpus.contribute.$post({ json: body({}) as any });
    const r = await db.pool.query(`SELECT source FROM corpus_contributions`);
    expect(r.rows[0].source.url).toBe("https://youtu.be/abc?t=46");
  });

  it("rejects blocklist matches with 400 (silent — spec §13 'don't tell user')", async () => {
    await db.pool.query(`INSERT INTO corpus_blocklist (term, added_at, added_by) VALUES ('bad', 0, 'test')`);
    const r = await app.api.corpus.contribute.$post({ json: body({ phraseRaw: "very bad phrase" }) as any });
    expect(r.status).toBe(400);
    const json: any = await r.json();
    expect(json.reason).toBe("blocklist_match");
  });

  it("returns 429 when rate limit exceeded (5/min)", async () => {
    for (let i = 0; i < 5; i++) {
      await app.api.corpus.contribute.$post({ json: body({ phraseRaw: `phrase ${i}` }) as any });
    }
    const r = await app.api.corpus.contribute.$post({ json: body({ phraseRaw: "phrase X" }) as any });
    expect(r.status).toBe(429);
  });

  it("curator contributorId bypasses rate limit + classification", async () => {
    const enqueue = vi.fn();
    // Re-mount with enqueue spy
    const h = new Hono();
    h.use("*", async (c, next) => { c.set("pool", db.pool); await next(); });
    mountCorpus(h, { enqueueClassify: enqueue });
    const client = testClient(h);
    for (let i = 0; i < 10; i++) {
      const r = await client.api.corpus.contribute.$post({ json: body({ phraseRaw: `phr${i}`, contributorId: "whatsub-curator" }) as any });
      expect(r.status).toBe(201);
    }
    expect(enqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

- [ ] **Step 3: Implement route**

```ts
// src/routes/corpus.ts
import type { Hono } from "hono";
import { contribute as dbContribute, lookup as dbLookup, flag as dbFlag, deleteByContributor, browse as dbBrowse } from "../db/corpus";
import { canonicalizeUrl } from "../utils/canonicalizeUrl";
import { normalizeExpression } from "../utils/normalizeExpression";
import { isBlocked } from "../db/blocklist";
import { isExempt } from "../db/rateLimit";
import { contributorIdRequired } from "../middleware/contributorIdRequired";
import { rateLimit } from "../middleware/rateLimit";

interface Deps {
  enqueueClassify: (phraseNormalized: string) => Promise<void> | void;
}

export function mountCorpus(app: Hono, deps: Deps) {
  app.post("/api/corpus/contribute", contributorIdRequired, rateLimit, async (c) => {
    const body = c.get("body") as {
      phraseRaw: string;
      contextSentence: string;
      source: { kind: "youtube" | "web" | "curator"; url: string; title: string; timestampSec?: number };
      contributorId: string;
    };
    if (!body.phraseRaw || !body.contextSentence || !body.source) {
      return c.json({ ok: false, reason: "missing_fields" }, 400);
    }
    const url = canonicalizeUrl(body.source.url);
    if (!url) return c.json({ ok: false, reason: "invalid_url" }, 400);

    const normalized = normalizeExpression(body.phraseRaw);
    if (!normalized) return c.json({ ok: false, reason: "empty_phrase" }, 400);

    const pool = c.get("pool");
    if (await isBlocked(pool, normalized)) {
      // Silent reject — see spec §13 hard rule (don't surface "your phrase was rejected" to user)
      return c.json({ ok: false, reason: "blocklist_match" }, 400);
    }

    const source = { ...body.source, url };
    const { contributionId, classificationNeeded } = await dbContribute(pool, {
      phraseRaw: body.phraseRaw,
      phraseNormalized: normalized,
      contextSentence: body.contextSentence,
      source,
      contributorId: body.contributorId,
      now: Date.now(),
    });

    if (classificationNeeded && !isExempt(body.contributorId)) {
      // Curator skips classification (their tags come from seed script)
      await deps.enqueueClassify(normalized);
    }
    return c.json({ id: contributionId, phrase: { tags: {}, classifiedAt: null } }, 201);
  });

  // Other routes (lookup, flag, mine, browse) added in subsequent tasks.
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/routes/corpus.ts tests/corpus/contribute.test.ts
git commit -m "feat(corpus): POST /api/corpus/contribute with canonicalize + blocklist + rate limit"
```

---

### Task 9: GET /api/corpus/lookup route

**Files:**
- Modify: `src/routes/corpus.ts`
- Test: `tests/corpus/lookup.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/corpus/lookup.test.ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { testClient } from "hono/testing";
import { Hono } from "hono";
import { mountCorpus } from "../../src/routes/corpus";
import { startPg, runMigrations } from "../helpers/pg";

describe("GET /api/corpus/lookup", () => {
  let db: Awaited<ReturnType<typeof startPg>>;
  let app: ReturnType<typeof testClient>;
  beforeAll(async () => {
    db = await startPg();
    await runMigrations(db.pool);
    const h = new Hono();
    h.use("*", async (c, next) => { c.set("pool", db.pool); await next(); });
    mountCorpus(h, { enqueueClassify: async () => {} });
    app = testClient(h);
  });
  beforeEach(async () => { await db.pool.query("TRUNCATE corpus_phrases CASCADE; TRUNCATE rate_buckets;"); });

  it("returns 404 when phrase has no contributions", async () => {
    const r = await app.api.corpus.lookup.$get({ query: { phrase: "save up money" } });
    expect(r.status).toBe(404);
  });

  it("returns phrase + contributions sorted by recency", async () => {
    const ts = Date.now();
    for (let i = 0; i < 3; i++) {
      await app.api.corpus.contribute.$post({ json: {
        phraseRaw: "save up money",
        contextSentence: `Context ${i}`,
        source: { kind: "youtube", url: `https://www.youtube.com/watch?v=v${i}&t=10s`, title: `Vid ${i}` },
        contributorId: `${i}${i}${i}${i}${i}${i}${i}${i}-${i}${i}${i}${i}-${i}${i}${i}${i}-${i}${i}${i}${i}-${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}`,
      } as any });
    }
    const r = await app.api.corpus.lookup.$get({ query: { phrase: "save up money" } });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.phrase.contribution_count).toBe(3);
    expect(j.contributions).toHaveLength(3);
  });

  it("excludes contributions from a specified excludeContributor", async () => {
    const me = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const other = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await app.api.corpus.contribute.$post({ json: {
      phraseRaw: "ditched class", contextSentence: "She ditched class today.",
      source: { kind: "youtube", url: "https://www.youtube.com/watch?v=x&t=1", title: "T" },
      contributorId: me,
    } as any });
    await app.api.corpus.contribute.$post({ json: {
      phraseRaw: "ditched class", contextSentence: "He always ditches class.",
      source: { kind: "youtube", url: "https://www.youtube.com/watch?v=y&t=2", title: "T2" },
      contributorId: other,
    } as any });
    const r = await app.api.corpus.lookup.$get({ query: { phrase: "ditched class", excludeContributor: me } });
    const j: any = await r.json();
    expect(j.contributions).toHaveLength(1);
    expect(j.contributions[0].contributor_id).toBe(other);
  });

  it("excludes hidden contributions", async () => {
    await app.api.corpus.contribute.$post({ json: {
      phraseRaw: "phrase x", contextSentence: "test",
      source: { kind: "youtube", url: "https://www.youtube.com/watch?v=zz", title: "" },
      contributorId: "11111111-1111-1111-1111-111111111111",
    } as any });
    await db.pool.query(`UPDATE corpus_contributions SET hidden = TRUE`);
    const r = await app.api.corpus.lookup.$get({ query: { phrase: "phrase x" } });
    const j: any = await r.json();
    expect(j.contributions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

- [ ] **Step 3: Append route to corpus.ts**

```ts
// in src/routes/corpus.ts mountCorpus body:
app.get("/api/corpus/lookup", async (c) => {
  const phraseRaw = c.req.query("phrase") ?? "";
  const excludeContributor = c.req.query("excludeContributor") ?? null;
  const normalized = normalizeExpression(phraseRaw);
  if (!normalized) return c.json({ ok: false, reason: "empty_phrase" }, 400);
  const pool = c.get("pool");
  const { phrase, contributions } = await dbLookup(pool, normalized, excludeContributor);
  if (!phrase) return c.json({ ok: false, reason: "no_data" }, 404);
  return c.json({ phrase, contributions });
});
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/routes/corpus.ts tests/corpus/lookup.test.ts
git commit -m "feat(corpus): GET /api/corpus/lookup with excludeContributor + hidden filter"
```

---

### Task 10: POST /api/corpus/flag route

**Files:**
- Modify: `src/routes/corpus.ts`
- Test: `tests/corpus/flag.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/corpus/flag.test.ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { testClient } from "hono/testing";
import { Hono } from "hono";
import { mountCorpus } from "../../src/routes/corpus";
import { startPg, runMigrations } from "../helpers/pg";

describe("POST /api/corpus/flag", () => {
  let db: Awaited<ReturnType<typeof startPg>>;
  let app: ReturnType<typeof testClient>;
  let contribId: string;
  beforeAll(async () => {
    db = await startPg(); await runMigrations(db.pool);
    const h = new Hono();
    h.use("*", async (c, next) => { c.set("pool", db.pool); await next(); });
    mountCorpus(h, { enqueueClassify: async () => {} });
    app = testClient(h);
  });
  beforeEach(async () => {
    await db.pool.query("TRUNCATE corpus_phrases CASCADE; TRUNCATE rate_buckets;");
    const r = await app.api.corpus.contribute.$post({ json: {
      phraseRaw: "test phrase", contextSentence: "ctx",
      source: { kind: "youtube", url: "https://www.youtube.com/watch?v=x", title: "" },
      contributorId: "11111111-1111-1111-1111-111111111111",
    } as any });
    contribId = (await r.json() as any).id;
  });

  it("returns 204 on flag, increments flag_count", async () => {
    const r = await app.api.corpus.flag.$post({ json: { contributionId: contribId, reason: "spam", contributorId: "00000000-0000-0000-0000-000000000000" } as any });
    expect(r.status).toBe(204);
    const after = await db.pool.query(`SELECT flag_count, hidden FROM corpus_contributions WHERE id = $1`, [contribId]);
    expect(after.rows[0].flag_count).toBe(1);
    expect(after.rows[0].hidden).toBe(false);
  });

  it("auto-hides at flag_count >= 3", async () => {
    for (let i = 0; i < 3; i++) {
      await app.api.corpus.flag.$post({ json: { contributionId: contribId, reason: "spam", contributorId: `${i}${i}${i}${i}${i}${i}${i}${i}-${i}${i}${i}${i}-${i}${i}${i}${i}-${i}${i}${i}${i}-${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}` } as any });
    }
    const after = await db.pool.query(`SELECT flag_count, hidden FROM corpus_contributions WHERE id = $1`, [contribId]);
    expect(after.rows[0].flag_count).toBe(3);
    expect(after.rows[0].hidden).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

- [ ] **Step 3: Append route**

```ts
// in mountCorpus body
app.post("/api/corpus/flag", contributorIdRequired, rateLimit, async (c) => {
  const body = c.get("body") as { contributionId: string; reason: string; contributorId: string };
  if (!body.contributionId) return c.json({ ok: false, reason: "missing_contribution_id" }, 400);
  await dbFlag(c.get("pool"), body.contributionId);
  return c.body(null, 204);
});
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/routes/corpus.ts tests/corpus/flag.test.ts
git commit -m "feat(corpus): POST /api/corpus/flag with auto-hide threshold"
```

---

### Task 11: DELETE /api/corpus/mine route

**Files:**
- Modify: `src/routes/corpus.ts`
- Test: `tests/corpus/mine.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/corpus/mine.test.ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { testClient } from "hono/testing";
import { Hono } from "hono";
import { mountCorpus } from "../../src/routes/corpus";
import { startPg, runMigrations } from "../helpers/pg";

describe("DELETE /api/corpus/mine", () => {
  let db: Awaited<ReturnType<typeof startPg>>;
  let app: ReturnType<typeof testClient>;
  beforeAll(async () => {
    db = await startPg(); await runMigrations(db.pool);
    const h = new Hono();
    h.use("*", async (c, next) => { c.set("pool", db.pool); await next(); });
    mountCorpus(h, { enqueueClassify: async () => {} });
    app = testClient(h);
  });
  beforeEach(async () => { await db.pool.query("TRUNCATE corpus_phrases CASCADE; TRUNCATE rate_buckets;"); });

  it("deletes all contributions for given contributorId only", async () => {
    const me = "11111111-1111-1111-1111-111111111111";
    const other = "22222222-2222-2222-2222-222222222222";
    for (let i = 0; i < 3; i++) await app.api.corpus.contribute.$post({ json: {
      phraseRaw: `p${i}`, contextSentence: "c",
      source: { kind: "youtube", url: `https://youtu.be/v${i}`, title: "" },
      contributorId: me,
    } as any });
    await app.api.corpus.contribute.$post({ json: {
      phraseRaw: "kept", contextSentence: "c",
      source: { kind: "youtube", url: "https://youtu.be/v9", title: "" },
      contributorId: other,
    } as any });

    const r = await app.api.corpus.mine.$delete({ json: { contributorId: me } as any });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.deletedCount).toBe(3);
    const remaining = await db.pool.query(`SELECT COUNT(*) FROM corpus_contributions`);
    expect(parseInt(remaining.rows[0].count)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

- [ ] **Step 3: Append route**

```ts
// in mountCorpus body
app.delete("/api/corpus/mine", contributorIdRequired, async (c) => {
  const body = c.get("body") as { contributorId: string };
  // No rate limit on delete — user's own data
  const { deletedCount } = await deleteByContributor(c.get("pool"), body.contributorId);
  return c.json({ deletedCount });
});
```

Note: Hono's `c.req.json()` is invoked by `contributorIdRequired` middleware on every method (including DELETE). Hono supports DELETE with body. If the framework strips body on DELETE in some versions, switch to a query param: `?contributorId=<id>`.

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/routes/corpus.ts tests/corpus/mine.test.ts
git commit -m "feat(corpus): DELETE /api/corpus/mine for self-deletion"
```

---

### Task 12: GET /api/corpus/browse route

**Files:**
- Modify: `src/routes/corpus.ts`

This route serves the future website browse page; tested transitively via lookup tests. No dedicated test file — covered by db/corpus.ts's `browse` function (transitively).

- [ ] **Step 1: Implement**

```ts
// in mountCorpus body
app.get("/api/corpus/browse", async (c) => {
  const scene = c.req.query("scene");
  const cefr = c.req.query("cefr");
  const limit = Math.min(100, parseInt(c.req.query("limit") ?? "20", 10));
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const { phrases, total } = await dbBrowse(c.get("pool"), { scene, cefr, limit, offset });
  return c.json({ phrases, total });
});
```

- [ ] **Step 2: Manual sanity check**

```bash
curl 'http://localhost:8787/api/corpus/browse?scene=campus&limit=5'
```

Expected: `200 { "phrases": [...], "total": N }` (empty in fresh DB, populated post-seed).

- [ ] **Step 3: Commit**

```bash
git add src/routes/corpus.ts
git commit -m "feat(corpus): GET /api/corpus/browse for future website page"
```

---

### Task 13: DeepSeek classification module

**Files:**
- Create: `src/llm/classify.ts`
- Create: `src/llm/types.ts` (if not exists)

This calls DeepSeek to produce `{ scene, partOfSpeech, cefrLevel }`. Uses our own API key (env var `DEEPSEEK_API_KEY`). ~$0.0001 per phrase per spec §7.3.

- [ ] **Step 1: Implement types**

```ts
// src/llm/types.ts
export interface PhraseClassification {
  scene?:
    | "immigration" | "housing" | "medical" | "campus" | "banking"
    | "shopping" | "transport" | "social" | "dining" | "emergency"
    | "job" | "phone" | "salon" | "driving" | "travel"
    | "fitness" | "mental_health" | "maintenance";
  partOfSpeech?: "noun_phrase" | "verb_phrase" | "phrasal_verb" | "idiom" | "slang" | "collocation";
  cefrLevel?: "A2" | "B1" | "B2" | "C1" | "C2";
}
```

- [ ] **Step 2: Implement classifier**

```ts
// src/llm/classify.ts
import type { PhraseClassification } from "./types";

const SYSTEM_PROMPT = `You classify English phrases for a Chinese-international-student learning platform.
Return ONLY a JSON object — no explanation, no markdown.

Schema:
{
  "scene": one of [immigration, housing, medical, campus, banking, shopping, transport, social, dining, emergency, job, phone, salon, driving, travel, fitness, mental_health, maintenance],
  "partOfSpeech": one of [noun_phrase, verb_phrase, phrasal_verb, idiom, slang, collocation],
  "cefrLevel": one of [A2, B1, B2, C1, C2]
}

Omit any field you can't confidently assign. NEVER include explanation.`;

export async function classifyPhrase(phrase: string, contextSentence: string): Promise<PhraseClassification> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY missing");
  const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Phrase: "${phrase}"\nContext: "${contextSentence}"` },
      ],
      temperature: 0.1,
      max_tokens: 80,
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) throw new Error(`deepseek ${r.status}`);
  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content;
  if (!content) throw new Error("empty response");
  const parsed = JSON.parse(content) as PhraseClassification;
  // Whitelist filter — drop any value not in enum
  return sanitize(parsed);
}

function sanitize(c: PhraseClassification): PhraseClassification {
  const out: PhraseClassification = {};
  const scenes = ["immigration","housing","medical","campus","banking","shopping","transport","social","dining","emergency","job","phone","salon","driving","travel","fitness","mental_health","maintenance"];
  const pos = ["noun_phrase","verb_phrase","phrasal_verb","idiom","slang","collocation"];
  const cefr = ["A2","B1","B2","C1","C2"];
  if (c.scene && scenes.includes(c.scene)) out.scene = c.scene;
  if (c.partOfSpeech && pos.includes(c.partOfSpeech)) out.partOfSpeech = c.partOfSpeech;
  if (c.cefrLevel && cefr.includes(c.cefrLevel)) out.cefrLevel = c.cefrLevel;
  return out;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/llm/classify.ts src/llm/types.ts
git commit -m "feat(corpus): DeepSeek classifier for scene + partOfSpeech + cefrLevel"
```

---

### Task 14: pg-boss classification worker

**Files:**
- Create: `src/workers/classifier.ts`
- Test: `tests/corpus/classifier.test.ts`

- [ ] **Step 1: Add pg-boss dep**

```bash
pnpm add pg-boss
git add package.json pnpm-lock.yaml
git commit -m "chore: add pg-boss dep"
```

- [ ] **Step 2: Write failing test**

```ts
// tests/corpus/classifier.test.ts
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { startPg, runMigrations } from "../helpers/pg";
import { processClassifyJob } from "../../src/workers/classifier";

describe("classifier worker", () => {
  let db: Awaited<ReturnType<typeof startPg>>;
  beforeAll(async () => { db = await startPg(); await runMigrations(db.pool); });
  beforeEach(async () => { await db.pool.query("TRUNCATE corpus_phrases CASCADE; TRUNCATE rate_buckets;"); });

  it("writes tags + classified_at on success", async () => {
    await db.pool.query(`
      INSERT INTO corpus_phrases (phrase_normalized, phrase_raw, first_seen_at, last_seen_at)
      VALUES ('save up money', 'save up money', 1000, 1000)
    `);
    await db.pool.query(`
      INSERT INTO corpus_contributions (phrase_normalized, context_sentence, source, contributor_id, contributed_at)
      VALUES ('save up money', 'Need to save up money for school', '{"kind":"youtube","url":"https://youtu.be/x"}', 'u1', 1000)
    `);
    const fakeLlm = vi.fn().mockResolvedValue({ scene: "campus", partOfSpeech: "verb_phrase", cefrLevel: "B1" });

    await processClassifyJob({ pool: db.pool, classify: fakeLlm }, { data: { phraseNormalized: "save up money" } });

    const r = await db.pool.query(`SELECT tags, classified_at FROM corpus_phrases WHERE phrase_normalized = 'save up money'`);
    expect(r.rows[0].tags).toEqual({ scene: "campus", partOfSpeech: "verb_phrase", cefrLevel: "B1" });
    expect(r.rows[0].classified_at).toBeTruthy();
  });

  it("leaves classified_at null on LLM error so retry can pick up", async () => {
    await db.pool.query(`
      INSERT INTO corpus_phrases (phrase_normalized, phrase_raw, first_seen_at, last_seen_at)
      VALUES ('phrase x', 'phrase x', 1000, 1000)
    `);
    await db.pool.query(`
      INSERT INTO corpus_contributions (phrase_normalized, context_sentence, source, contributor_id, contributed_at)
      VALUES ('phrase x', 'ctx', '{}', 'u1', 1000)
    `);
    const fakeLlm = vi.fn().mockRejectedValue(new Error("deepseek 500"));
    await expect(processClassifyJob({ pool: db.pool, classify: fakeLlm }, { data: { phraseNormalized: "phrase x" } }))
      .rejects.toThrow("deepseek 500");
    const r = await db.pool.query(`SELECT classified_at FROM corpus_phrases WHERE phrase_normalized = 'phrase x'`);
    expect(r.rows[0].classified_at).toBeNull();
  });
});
```

- [ ] **Step 3: Run test, verify failure**

- [ ] **Step 4: Implement worker**

```ts
// src/workers/classifier.ts
import type { Pool } from "pg";
import PgBoss from "pg-boss";
import { classifyPhrase } from "../llm/classify";
import type { PhraseClassification } from "../llm/types";

interface Deps {
  pool: Pool;
  classify: (phrase: string, ctx: string) => Promise<PhraseClassification>;
}

export interface ClassifyJob {
  data: { phraseNormalized: string };
}

export async function processClassifyJob(deps: Deps, job: ClassifyJob): Promise<void> {
  const { phraseNormalized } = job.data;
  const contribR = await deps.pool.query<{ phrase_raw: string; context_sentence: string }>(
    `SELECT p.phrase_raw, c.context_sentence
       FROM corpus_phrases p
       JOIN corpus_contributions c ON c.phrase_normalized = p.phrase_normalized
      WHERE p.phrase_normalized = $1
      ORDER BY c.contributed_at ASC
      LIMIT 1`,
    [phraseNormalized],
  );
  if (contribR.rowCount === 0) return;
  const { phrase_raw, context_sentence } = contribR.rows[0];

  const tags = await deps.classify(phrase_raw, context_sentence);

  await deps.pool.query(
    `UPDATE corpus_phrases
        SET tags = $1::jsonb,
            classified_at = $2
      WHERE phrase_normalized = $3`,
    [JSON.stringify(tags), Date.now(), phraseNormalized],
  );
}

export async function startClassifierWorker(pool: Pool, connectionString: string): Promise<{
  enqueue: (phraseNormalized: string) => Promise<void>;
  stop: () => Promise<void>;
}> {
  const boss = new PgBoss(connectionString);
  await boss.start();
  await boss.work<{ phraseNormalized: string }>("phrase-classify", async (job) => {
    await processClassifyJob({ pool, classify: classifyPhrase }, { data: job.data });
  });
  return {
    enqueue: async (phraseNormalized: string) => {
      await boss.send("phrase-classify", { phraseNormalized });
    },
    stop: () => boss.stop(),
  };
}
```

- [ ] **Step 5: Run test, verify PASS**

- [ ] **Step 6: Wire worker into Hono app startup**

In `src/index.ts`:

```ts
import { startClassifierWorker } from "./workers/classifier";
import { mountCorpus } from "./routes/corpus";

const { enqueue: enqueueClassify } = await startClassifierWorker(pool, process.env.DATABASE_URL!);
mountCorpus(app, { enqueueClassify });
```

- [ ] **Step 7: Commit**

```bash
git add src/workers/classifier.ts tests/corpus/classifier.test.ts src/index.ts
git commit -m "feat(corpus): pg-boss classification worker + boot-time wiring"
```

---

### Task 15: Seed script — Python

**Files:**
- Create (in this repo): `scripts/seed_corpus.py`
- Create: `scripts/seed_corpus_README.md`
- Create: `scripts/seed_corpus_test.py`

The seed script reads `data/videos/*/{video_id}/{video_id}.analysis.json` files produced by the existing `video_sourcing` pipeline, extracts highlightWords + cueText pairs, and POSTs them to `/api/corpus/contribute` with `contributorId = "whatsub-curator"`. Curator submissions bypass rate limits and classification — instead, we pre-fill the scene tag directly via a SQL sidecar update after import.

- [ ] **Step 1: Write seed script**

```python
# scripts/seed_corpus.py
"""Bootstrap the whatsub shared corpus from the desktop pipeline's analyzed videos.

Reads:  data/videos/{scene}/{video_id}/{video_id}.analysis.json
Writes: POST https://whatsub.eversay.cc/api/corpus/contribute (one per highlightWord)
        + a final SQL sidecar UPDATE setting tags.scene from directory layout.

Idempotency: re-running this script does NOT double-count. The corpus_phrases table
upserts on phrase_normalized; the corpus_contributions table dedupes by
(phrase_normalized, contributor_id="whatsub-curator", source.url)
through a pre-flight check (see check_already_seeded).

Usage:
    PYTHONUTF8=1 PYTHONIOENCODING=utf-8 \
      python scripts/seed_corpus.py \
        --endpoint https://whatsub.eversay.cc \
        --data-root data/videos \
        --dry-run         # validates inputs without POSTing
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Iterator
import urllib.request
import urllib.error

CURATOR_ID = "whatsub-curator"


def iter_analysis_files(data_root: Path) -> Iterator[tuple[str, Path]]:
    """Yields (scene, analysis_json_path) for every analysis.json under data_root."""
    for scene_dir in sorted(data_root.iterdir()):
        if not scene_dir.is_dir():
            continue
        for video_dir in sorted(scene_dir.iterdir()):
            if not video_dir.is_dir():
                continue
            video_id = video_dir.name
            analysis = video_dir / f"{video_id}.analysis.json"
            if analysis.exists():
                yield scene_dir.name, analysis


def extract_contributions(analysis_path: Path, scene: str) -> list[dict]:
    """Reads an analysis.json and returns a list of /contribute body payloads."""
    with analysis_path.open(encoding="utf-8") as f:
        data = json.load(f)
    video_id = analysis_path.stem.replace(".analysis", "")
    video_title = data.get("title", "")
    subtitles = data.get("subtitles", [])
    out: list[dict] = []
    for cue in subtitles:
        words = cue.get("highlightWords") or []
        text = cue.get("text", "")
        cue_time = cue.get("time", 0)
        if not words or not text:
            continue
        url = f"https://youtu.be/{video_id}?t={int(cue_time)}"
        for word in words:
            if not isinstance(word, str) or not word.strip():
                continue
            out.append({
                "phraseRaw": word,
                "contextSentence": text,
                "source": {
                    "kind": "curator",
                    "url": url,
                    "title": video_title,
                    "timestampSec": int(cue_time),
                },
                "contributorId": CURATOR_ID,
                "_scene": scene,  # internal flag for post-import sidecar; stripped before POST
            })
    return out


def post_contribute(endpoint: str, body: dict, timeout: int = 30) -> tuple[int, dict | None]:
    raw_body = {k: v for k, v in body.items() if not k.startswith("_")}
    req = urllib.request.Request(
        url=f"{endpoint.rstrip('/')}/api/corpus/contribute",
        data=json.dumps(raw_body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Origin": "chrome-extension://internal-seed"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, None


def post_scene_sidecar(endpoint: str, phrases_with_scene: list[tuple[str, str]], admin_token: str) -> None:
    """One-shot admin endpoint to backfill scene tags for curator-seeded phrases.

    Not part of the public /api/corpus/*; this is a private admin route added in Task 16.
    """
    req = urllib.request.Request(
        url=f"{endpoint.rstrip('/')}/api/corpus/admin/seed-tags",
        data=json.dumps({"phrases": [{"phraseRaw": p, "scene": s} for p, s in phrases_with_scene]}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {admin_token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        print(f"[seed] sidecar tags applied: {r.status}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", default="https://whatsub.eversay.cc")
    parser.add_argument("--data-root", type=Path, default=Path("data/videos"))
    parser.add_argument("--admin-token", default=None, help="Token for /admin/seed-tags sidecar")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0, help="Stop after N phrases (0 = no limit)")
    args = parser.parse_args()

    if not args.data_root.exists():
        print(f"[seed] data root not found: {args.data_root}", file=sys.stderr)
        return 1

    total_payloads: list[dict] = []
    for scene, path in iter_analysis_files(args.data_root):
        total_payloads.extend(extract_contributions(path, scene))
    if args.limit > 0:
        total_payloads = total_payloads[: args.limit]

    print(f"[seed] {len(total_payloads)} contributions ready across "
          f"{len({p['phraseRaw'].lower().strip() for p in total_payloads})} unique phrases",
          flush=True)
    if args.dry_run:
        return 0

    ok_count = 0
    fail_count = 0
    for i, body in enumerate(total_payloads):
        status, _ = post_contribute(args.endpoint, body)
        if status in (201, 200):
            ok_count += 1
        else:
            fail_count += 1
        if i % 100 == 0 and i > 0:
            print(f"[seed] {i}/{len(total_payloads)} ok={ok_count} fail={fail_count}", flush=True)
        # Polite pacing — curator bypasses rate limit but we don't want to thrash the DB
        time.sleep(0.01)

    print(f"[seed] done · ok={ok_count} fail={fail_count}", flush=True)

    # Sidecar: backfill scene tags from directory layout (the LLM classifier would
    # also assign scene, but curator submissions skip classification per spec §7.5)
    if args.admin_token:
        pairs = [(b["phraseRaw"], b["_scene"]) for b in total_payloads]
        # dedup by phraseRaw — sidecar updates by phrase_normalized
        seen: set[str] = set()
        unique_pairs: list[tuple[str, str]] = []
        for raw, scene in pairs:
            key = raw.lower().strip()
            if key in seen:
                continue
            seen.add(key)
            unique_pairs.append((raw, scene))
        post_scene_sidecar(args.endpoint, unique_pairs, args.admin_token)

    return 0 if fail_count == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Implement test (idempotency + parsing)**

```python
# scripts/seed_corpus_test.py
import json
from pathlib import Path
import tempfile
import pytest
from seed_corpus import iter_analysis_files, extract_contributions, CURATOR_ID


def make_fixture(tmp: Path) -> Path:
    data_root = tmp / "videos"
    scene_dir = data_root / "campus" / "vidABC"
    scene_dir.mkdir(parents=True)
    analysis = {
        "title": "Budgeting at uni",
        "subtitles": [
            {"text": "I really need to save up money.", "time": 46.0, "highlightWords": ["save up money"]},
            {"text": "Tuition keeps going up.", "time": 51.0, "highlightWords": ["going up"]},
            {"text": "Nothing important here.", "time": 60.0},  # no highlightWords → skip
        ],
    }
    (scene_dir / "vidABC.analysis.json").write_text(json.dumps(analysis), encoding="utf-8")
    return data_root


def test_iter_finds_one_analysis_file():
    with tempfile.TemporaryDirectory() as tmp:
        root = make_fixture(Path(tmp))
        files = list(iter_analysis_files(root))
        assert len(files) == 1
        assert files[0][0] == "campus"


def test_extract_emits_one_payload_per_highlight_word():
    with tempfile.TemporaryDirectory() as tmp:
        root = make_fixture(Path(tmp))
        scene, path = next(iter(iter_analysis_files(root)))
        payloads = extract_contributions(path, scene)
        assert len(payloads) == 2
        assert payloads[0]["phraseRaw"] == "save up money"
        assert payloads[0]["contributorId"] == CURATOR_ID
        assert payloads[0]["source"]["url"] == "https://youtu.be/vidABC?t=46"
        assert payloads[0]["_scene"] == "campus"


def test_extract_skips_cues_without_highlight_words():
    with tempfile.TemporaryDirectory() as tmp:
        root = make_fixture(Path(tmp))
        scene, path = next(iter(iter_analysis_files(root)))
        payloads = extract_contributions(path, scene)
        assert all(p["phraseRaw"] in ("save up money", "going up") for p in payloads)
```

- [ ] **Step 3: Run tests**

Run (in this repo): `PYTHONUTF8=1 PYTHONIOENCODING=utf-8 pytest scripts/seed_corpus_test.py -v`
Expected: 3 tests PASS

- [ ] **Step 4: Dry-run validation against real data**

```bash
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python scripts/seed_corpus.py \
  --endpoint https://whatsub.eversay.cc \
  --data-root data/videos \
  --dry-run
```

Expected: `[seed] N contributions ready across M unique phrases` printed, no HTTP calls.

- [ ] **Step 5: README**

```markdown
# scripts/seed_corpus.py

Bootstraps the whatsub shared corpus from `data/videos/*/*/analysis.json`.

## Prereqs

- Python 3.9+ with stdlib (no extra deps)
- Backend deployed at the endpoint URL
- Admin token (env var or --admin-token) for the scene-tags sidecar

## Run

```bash
# Dry-run first to see counts
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python scripts/seed_corpus.py --dry-run

# Real run (will POST ~100k requests; takes ~30-60 min at 10ms pacing)
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python scripts/seed_corpus.py \
  --admin-token "$WHATSUB_ADMIN_TOKEN"
```

## Idempotency

Re-running is safe:
- `corpus_phrases` UPSERTs on `phrase_normalized`; `contribution_count` increments
- `corpus_contributions` rows duplicate (each run adds a new row per curator entry)
  — **but** the curator contributor_id means lookup queries filter them with `excludeContributor` when desired

If you need to wipe and re-seed cleanly, run on the DB first:

```sql
DELETE FROM corpus_contributions WHERE contributor_id = 'whatsub-curator';
DELETE FROM corpus_phrases WHERE NOT EXISTS (
  SELECT 1 FROM corpus_contributions c WHERE c.phrase_normalized = corpus_phrases.phrase_normalized
);
```

## Expected output

- ~3-5 万 unique phrases across 18 scenes
- ~10-20 万 contribution rows
- Coverage: roughly 1-5k phrases per scene
```

- [ ] **Step 6: Commit**

```bash
git add scripts/seed_corpus.py scripts/seed_corpus_test.py scripts/seed_corpus_README.md
git commit -m "feat(seed): one-shot corpus seed from desktop pipeline analysis.json"
```

---

### Task 16: Admin sidecar route `POST /api/corpus/admin/seed-tags`

**Files:**
- Modify: `src/routes/corpus.ts`

The seed script backfills `tags.scene` directly from the directory name (scenes already classified by the pipeline). This avoids running the LLM classifier 100k times on data we already know.

- [ ] **Step 1: Implement admin route**

```ts
// in mountCorpus body, ABOVE other corpus routes so it's mounted first
app.post("/api/corpus/admin/seed-tags", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || auth.slice(7) !== process.env.WHATSUB_ADMIN_TOKEN) {
    return c.json({ ok: false, reason: "unauthorized" }, 401);
  }
  const body = await c.req.json();
  const items = body?.phrases as Array<{ phraseRaw: string; scene: string }> | undefined;
  if (!Array.isArray(items)) return c.json({ ok: false, reason: "bad_body" }, 400);

  const pool = c.get("pool");
  let updated = 0;
  for (const { phraseRaw, scene } of items) {
    const normalized = normalizeExpression(phraseRaw);
    if (!normalized) continue;
    const r = await pool.query(`
      UPDATE corpus_phrases
         SET tags = COALESCE(tags, '{}'::jsonb) || jsonb_build_object('scene', $1::text),
             classified_at = COALESCE(classified_at, $2)
       WHERE phrase_normalized = $3
    `, [scene, Date.now(), normalized]);
    updated += r.rowCount ?? 0;
  }
  return c.json({ updated });
});
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/corpus.ts
git commit -m "feat(corpus): admin /seed-tags sidecar for curator scene backfill"
```

---

### Task 17: Mount corpus routes in main app + CORS for plugin

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Wire up**

```ts
// src/index.ts (near top of bootstrap)
import { cors } from "hono/cors";
import { mountCorpus } from "./routes/corpus";
import { startClassifierWorker } from "./workers/classifier";

// ... existing pool / app setup ...

app.use("/api/corpus/*", cors({
  origin: (origin) => {
    if (!origin) return null;
    if (origin.startsWith("chrome-extension://")) return origin;
    if (origin.startsWith("moz-extension://")) return origin;
    if (origin === "https://whatsub.eversay.cc") return origin;  // for browse page later
    return null;  // reject
  },
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  maxAge: 600,
}));

const { enqueue: enqueueClassify } = await startClassifierWorker(pool, process.env.DATABASE_URL!);
mountCorpus(app, { enqueueClassify });
```

- [ ] **Step 2: Commit**

```bash
git add src/index.ts
git commit -m "chore(corpus): mount routes in main app + extension-scoped CORS"
```

---

### Task 18: Deploy + smoke test on Aliyun ECS

**Files:** none code-wise; this is a deploy task.

- [ ] **Step 1: Run migrations on production**

```bash
ssh whatsub@whatsub.eversay.cc
cd /srv/whatsub-license
git pull
pnpm install
pnpm migrate:up
```

Expected: 004_corpus.sql + 005_corpus_blocklist_seed.sql applied; no errors.

- [ ] **Step 2: Restart service**

```bash
pm2 restart whatsub-license
pm2 logs whatsub-license --lines 50
```

Expected: log includes `[whatsub] classifier worker started` and no errors.

- [ ] **Step 3: Verify routes**

```bash
curl -X POST 'https://whatsub.eversay.cc/api/corpus/contribute' \
  -H 'Content-Type: application/json' \
  -H 'Origin: chrome-extension://test-id' \
  -d '{
    "phraseRaw": "save up money",
    "contextSentence": "I need to save up money for next semester.",
    "source": {"kind":"youtube","url":"https://www.youtube.com/watch?v=abc&t=46s","title":"Test"},
    "contributorId": "smoke-test-uuid"
  }'
```

Expected: 201 with JSON `{ "id": "...", "phrase": { "tags": {}, "classifiedAt": null } }`.

```bash
curl 'https://whatsub.eversay.cc/api/corpus/lookup?phrase=save+up+money'
```

Expected: 200 with phrase + 1 contribution.

- [ ] **Step 4: Run seed script (dry-run first, then live)**

```bash
# Local box with project data
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python scripts/seed_corpus.py --dry-run
# Then live run with admin token
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python scripts/seed_corpus.py \
  --admin-token "$WHATSUB_ADMIN_TOKEN"
```

Expected: ~3-5 万 unique phrases POSTed; sidecar scene-tags applied; final summary shows fail count 0.

- [ ] **Step 5: Verify seed quality**

```sql
-- Scene coverage
SELECT tags->>'scene' AS scene, COUNT(*) AS cnt FROM corpus_phrases GROUP BY scene ORDER BY cnt DESC;
-- Recent classification activity
SELECT COUNT(*) FILTER (WHERE classified_at IS NULL) AS pending,
       COUNT(*) FILTER (WHERE classified_at IS NOT NULL) AS done
FROM corpus_phrases;
```

Expected: ~18 scene rows, most with 100+ phrases. Pending count drops over hours as classifier worker chews through non-curator entries.

- [ ] **Step 6: Commit nothing — record results in CHANGELOG**

```bash
echo "2026-05-17 corpus backend deployed, seeded with NNN phrases across 18 scenes" >> CHANGELOG.md
git add CHANGELOG.md
git commit -m "chore: record corpus backend deploy + seed run"
```

---

## Self-review checklist

Before declaring Plan 2 complete, verify:

- [ ] **No contributorId is ever returned in admin / browse endpoints.** Grep for `contributor_id` in route responses; only the `/mine` DELETE accepts it as input — never echoes it.
- [ ] **No IP addresses persisted.** Verify the request-level access log either omits IPs or rotates them out within a sliding window (server's existing infra; just confirm we don't add a new IP-logging layer).
- [ ] **Rate-limit increment is atomic** — Task 5 test covers the 20-concurrent case. Re-run on production hardware once to verify under real PostgreSQL load.
- [ ] **Blocklist cache invalidates within 5 minutes** when a new term is added via admin SQL — verify with a manual `INSERT INTO corpus_blocklist` followed by 5 minutes of waiting + `/contribute` call.
- [ ] **Seed script is idempotent** — second run does NOT double-count phrases (phrase upserts increment counter, but counter increment is tied to contributions which DO get re-inserted). The README documents the wipe-and-rerun procedure.
- [ ] **Curator bypasses both rate limit and classifier worker** — verify in `tests/corpus/contribute.test.ts` via the dedicated test case.
- [ ] **URL canonicalization treats all YouTube variants identically** — Task 2 test covers 5 variants; verify the dedupe behavior by inserting the same phrase from 5 URL forms and querying `corpus_contributions` for unique URLs.
- [ ] **Hidden contributions don't leak** in any endpoint — `corpus_contributions` queries always include `hidden = FALSE` (visible only in `/admin/*` routes if added later for moderation).
- [ ] **Classifier failures are retryable** — pg-boss should retry failed jobs with exponential backoff (default ~5 retries with 30s delay); verify by setting DEEPSEEK_API_KEY to invalid value, posting 1 contribution, watching the job get retried.
- [ ] **CORS origin allowlist** rejects everything except `chrome-extension://*`, `moz-extension://*`, and `whatsub.eversay.cc`. Test with `curl -H 'Origin: https://evil.com'` — response should NOT include matching `Access-Control-Allow-Origin`.
- [ ] **DELETE /mine has zero auth** but only deletes by `contributorId` from request body — this is correct: the contributorId in body IS the user's only credential. Verify no auth header is required and no auth check exists.
- [ ] **The `admin/seed-tags` route requires `WHATSUB_ADMIN_TOKEN`** and is the ONLY route protected by this token; if the token leaks, attacker can backfill tags but not delete contributions or alter blocklist.
