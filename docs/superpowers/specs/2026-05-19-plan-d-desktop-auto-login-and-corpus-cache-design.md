# Plan D: Desktop Auto-Login + Corpus Cache + Admin Publish Workflow

Date: 2026-05-19
Status: design approved, pending implementation plan

Spans two repos: `whatsub-license` (server + admin SPA) and `Get_Video/client` (Tauri desktop). Plugin is intentionally NOT modified.

## Goal

Three coupled UX fixes for the Plan A → C cloud-corpus product:

1. **Desktop auto-login** — replace the email+6-digit-code login screen with automatic session issuance from the existing license key. User bought license → desktop opens → corpus is already synced. No login screen.

2. **Corpus cache** — clients keep a local snapshot keyed by a server-side version. On open, fetch only a tiny `/versions` endpoint; full corpus body only refetches when version changed.

3. **Admin publish workflow** — admin can stage corpus phrases as drafts (invisible to clients) and explicitly publish a batch. Drafts hidden from `/browse` until publish bumps the public version.

Plus a small nav fix on the desktop Corpus page (currently no way back to other tabs).

## Out of scope

- Plugin changes. Plugin's email+code login stays as-is (selected option 1 in design conversation). Users who want plugin↔desktop sync must use their purchase email in the plugin manually.
- Trial users on desktop. Spec C assumed paid users for desktop; trial users without a license can't auto-login. They see "请先购买" instead of AuthCard. Acceptable.
- ETag-style HTTP cache. We're using application-level versioning instead — simpler client logic, easier mental model.
- Per-scene granularity for public corpus version. One global version covers all 18 scenes. Acceptable because admin curate frequency is low (you batch + push manually).
- Plugin cache. Plugin reads are session-scoped (5-min cache already exists in `lookupCache.ts`). Cross-session caching for plugin is a future concern.

---

## 1. Server: auth-from-license

### New endpoint

```
POST /api/auth/from-license
Body: { licenseKey: string }
```

**Behavior:**
1. `SELECT email FROM licenses WHERE key = $1`
2. If no row: 400 `{error: 'license_not_found'}`
3. If row but `email IS NULL`: 400 `{error: 'license_has_no_email'}` (shouldn't happen post-2026-05; older licenses might be email-less)
4. Otherwise: same code path as `/verify-code` post-match — generate token, hash, insert into `session_tokens` with that email, 30-day expiry. Return `{sessionToken, expiresAt}`

**Auth semantics:** No middleware required. License key possession is the proof. There's no shortcut for "I bought the license but it's not active yet" — server only requires that the license row exists with an email.

**Rate limiting:** Light (e.g. 10 attempts per IP per minute) to discourage license-key brute force. Reuses existing rate_buckets table with `bucket_kind = 'auth_from_license_ip'`.

### Why this is acceptable security-wise

- License key is a 25-character secret already sent over TLS during activation. Stolen license key = stolen account already (the buyer has no recovery against this in the current system).
- The session token issued is bound to the linked email — if you steal a license key you become that email, but you can't change the email or steal something the email doesn't have.
- Compare to plugin's email+code path: plugin user proves email ownership via OTP. Desktop user proves license possession, which post-purchase is equivalent.

---

## 2. Server: corpus version + publish workflow

### Schema

`app_settings` (already exists from Plan A) gets two more rows:

- `key='public_corpus_version', value=<ms timestamp>` — bumped only by `POST /admin/corpus/publish`.
- `key='public_corpus_initial_version', value=<ms>` — set once at deploy time to `now()` so existing curator data (if any) is "pre-published" and visible.

Bootstrap is idempotent: deploy time runs `INSERT ... ON CONFLICT DO NOTHING` with `value = now() ms`.

### New endpoint: `GET /api/corpus/versions`

```
Headers: Authorization: Bearer <session>
Response: {
  "mine":   1731234567890,   // MAX(contributed_at) for caller's contributions, or 0 if none
  "public": 1731234567890    // from app_settings 'public_corpus_version'
}
```

Implementation: 2 small queries (`SELECT MAX(...)` + `SELECT value`). Indexed; ~1ms.

### New endpoint: `POST /api/admin/corpus/publish`

```
Headers: Authorization: Bearer <admin-token>
Body: {}                              // no body needed
Response: { published_at: <ms> }
```

Effect: `UPSERT INTO app_settings (key, value, updated_at) VALUES ('public_corpus_version', $now, $now) ON CONFLICT ... UPDATE`.

### Browse endpoint filter (drafts invisible)

`GET /api/corpus/browse` gains a server-side filter:

```sql
WHERE tags->>'scene' = $1
  AND last_seen_at <= (
    SELECT value::bigint FROM app_settings
     WHERE key = 'public_corpus_version'
  )
```

Same filter for `/api/corpus/lookup?withScope=true` on the **public** half of the split — personal half is not filtered (you can always see your own writes, even before any publish has happened).

Mine `/api/corpus/mine` is **not** filtered — personal entries are always visible to their owner.

Admin `/api/admin/corpus/list` is **not** filtered — admin sees draft + published.

### "Has unpublished drafts" indicator

To support the "you have N unpublished drafts" badge in the admin SPA, add a derived field to `GET /api/admin/corpus/list` response:

```json
{
  "items": [...],
  "total": ...,
  "unpublishedCount": 3     // NEW: phrases with last_seen_at > public_corpus_version
}
```

One extra COUNT(*) query, indexed.

---

## 3. Admin SPA: publish button + draft indicator

Two additions to `public/admin/index.html`:

### Publish button

At the top of the 语料 tab, alongside the existing "+ 添加" button:

```
公共语料库
[+ 添加]                              [📢 推送更新]  3 条草稿未推送
```

Click `📢 推送更新` → `POST /api/admin/corpus/publish` → toast "已推送，所有客户端下次打开会更新" → refresh the list (which removes the draft indicator since `unpublishedCount` now = 0).

If `unpublishedCount === 0`: button is disabled / greyed out + label "无新草稿".

### Draft visual hint in the table

Each phrase row gets a tiny indicator if it's a draft (i.e. `last_seen_at > public_corpus_version`):

```
small talk    [📋 草稿]   social    B1   3      0    [删除]
```

Frontend computes this client-side by comparing the row's `lastSeenAt` against the table-wide `publicCorpusVersion` field (also new in the list response — same value as the one fetched by `/versions`).

---

## 4. Desktop: license-based auto-login

### Replace AuthGate with LicenseSessionGate

The current `<AuthGate>` (Plan C, App.tsx) wraps routes with:
- `status === 'unknown'` → loading
- `status === 'unauthed'` → render `<AuthCard>` (email+code form)
- `status === 'authed'` → children

**New behavior:**
- `status === 'unknown'` → loading
- `status === 'unauthed'`:
  - Read license key from existing license-key store (it's already there post-activation)
  - If no license key → render the existing "请先购买" / activation flow (NOT AuthCard)
  - If license key present → call `auth_from_license` → on success, `useAuth.refresh()` re-flips to `'authed'` → render children
- `status === 'authed'` → children

### New Rust command: `auth_from_license`

```rust
#[tauri::command]
pub async fn auth_from_license<R: Runtime>(
    app: AppHandle<R>,
    license_key: String,
) -> Result<AuthResult, String> {
    // POST /api/auth/from-license { licenseKey }
    // on 200: auth::set_auth({ session_token, email, expires_at })
    // on 4xx: return ok=false with reason
}
```

Frontend `useAuth` store adds an action:

```ts
authFromLicense(licenseKey: string): Promise<{ok: boolean; reason?: string}>
```

### LicenseSessionGate boot flow

```tsx
useEffect(() => {
  (async () => {
    const ok = await refresh();  // existing path: try /me with stored session
    if (ok) return;
    // No session → try license
    const licenseKey = await readStoredLicenseKey();
    if (!licenseKey) {
      // Falls through to existing "activate license" flow
      return;
    }
    const r = await authFromLicense(licenseKey);
    if (r.ok) await refresh();
    // else: error toast + fallback to manual activation
  })();
}, []);
```

### Delete files

- `client/src/components/AuthCard.tsx` + `AuthCard.test.tsx` — no longer used
- The "AuthGate uses AuthCard" branch in `App.tsx` — replaced as above

The `useAuth` store stays (used by `auth_from_license`, `/me`, logout, license fields). Its `sendCode` / `verifyCode` actions can be DELETED since neither desktop nor any other caller invokes them.

---

## 5. Desktop: Corpus page nav

Plan C's `Corpus.tsx` is `flex h-screen` — fills the whole viewport with no header. There's no path back to `/library` / `/settings`.

**Fix:** Add a top nav header to `Corpus.tsx`. Reuse the same nav structure as `Library.tsx` (which I confirmed in C15 holds the top-bar links inline). Simplest: extract the nav into a `<TopNav />` component if it's worth it; otherwise copy the link block into Corpus.tsx for now.

Minimum header:

```tsx
<header className="flex items-center gap-4 px-4 py-2 border-b border-zinc-800">
  <NavLink to="/library">字幕本</NavLink>
  <NavLink to="/corpus">📚 语料库</NavLink>
  <NavLink to="/settings">设置</NavLink>
</header>
<div className="flex flex-1 overflow-hidden">
  {/* three columns */}
</div>
```

If Library.tsx already has more nav entries (Settings, Player back, etc.), match its full set.

---

## 6. Desktop: cache layer + version-aware fetcher

### Cache storage

Reuse `tauri-plugin-store` (already added in Plan C task C1). New file: `corpus_cache.json` in app data dir, sibling to `auth.json`.

Shape:

```jsonc
{
  "mineVersion": 1731234567890,
  "mineData": { "items": [...], "total": 42 },
  "publicVersion": 1731234567890,
  "publicData": {
    "social":  { "items": [...], "total": 17 },
    "travel":  { "items": [...], "total": 9 },
    // ... 18 scenes lazy-populated
  },
  "phraseData": {
    "small talk": { "phrase": {...}, "publicContributions": [...], "personalContributions": [...] }
  }
}
```

### Rust command: `corpus_get_cache` / `corpus_set_cache`

Generic key-value get/set over the cache file, exposed to JS via Tauri invoke. Or simpler: do cache reads/writes purely in JS via `@tauri-apps/plugin-store` JS API. The Rust commands for corpus reads themselves don't need to know about the cache.

**Recommended:** JS-side caching using `@tauri-apps/plugin-store` directly (Tauri 2 ships JS bindings for the store plugin). No new Rust code; cache logic lives in React hooks.

### Fetcher hook

New file: `client/src/hooks/useCorpus.ts`:

```ts
import { Store } from '@tauri-apps/plugin-store';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

const CACHE_FILE = 'corpus_cache.json';

export function useCorpusList(scope: 'mine' | { scene: string }) {
  const [data, setData] = useState<unknown | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async (force = false) => { /* ... see below ... */ };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = await readCache(scope);
      if (cached && !cancelled) setData(cached);
      await refresh();
    })();
    return () => { cancelled = true; };
  }, [JSON.stringify(scope)]);

  return { data, refreshing, refresh: () => refresh(true) };
}
```

Inside `refresh`:

1. Call Rust `corpus_versions` command → `{mine, public}` from `/api/corpus/versions`
2. Read cached versions from store
3. If `scope === 'mine'` and `cached.mineVersion === server.mine`, skip the fetch
4. If `scope === {scene: 'X'}` and `cached.publicVersion === server.public`, skip the fetch (assuming all-scenes-share-one-version)
5. Otherwise: fetch full data, update cache, return

If `force` is true, skip the version check and always fetch.

### Components

`CorpusPhraseList.tsx` (C12) and `MyCorpusCard` (Plan B equivalent — N/A here since desktop doesn't have MyCorpusCard; CorpusPhraseList covers both modes) replace their internal `useEffect + invoke` with `useCorpusList(scope)`.

`CorpusPhraseDetail.tsx` (C13) gets a similar `useCorpusPhrase(phraseNormalized)` hook backed by the `phraseData` cache.

### Refresh button

A small ↻ icon button in the Corpus page header, next to the nav. Click → forces all caches to invalidate + re-fetch. Calls the `refresh(true)` returned by the active hook.

For the initial implementation, the button can just `invalidate('mine')` + force-refresh both lists. Simpler.

### Cache invalidation on write

Out of scope for Plan D (desktop doesn't write yet — in-player save still local per C scope, and there's no DeleteMineButton on desktop). When Plan E rewires in-player saves to cloud, add `invalidate('mine')` after each successful contribute.

---

## 7. Migration / deployment

**Plan D is local-only per user instruction.** No git push, no docker deploy, no server schema apply on the live DB. Everything below describes the eventual deploy path; implementer's job ends at "all tests pass locally + desktop `tauri dev` smoke works against a locally-running server".

### Server (local only)

1. **Schema bootstrap SQL** lives in `schema.sql`:

   ```sql
   INSERT INTO app_settings (key, value, updated_at)
   VALUES ('public_corpus_version',
           (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint::text,
           (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)
   ON CONFLICT (key) DO NOTHING;
   ```

   Applied automatically by pg-mem in tests; goes live on 47.93.87.206 only when user manually runs the existing `scp + docker exec psql` recipe.

2. **Build:** `pnpm build` locally; no `docker build` for prod image; no `docker compose up -d`.

3. **For end-to-end smoke:** implementer runs `pnpm start` (or equivalent) to bring up the server on localhost:3002 against a local Postgres OR runs `pnpm test` against pg-mem. Either is sufficient to validate the new endpoints.

### Admin SPA (local only)

Static change to `public/admin/index.html` ships with the server. Implementer can verify by visiting `http://localhost:3002/admin/` after starting the local server.

### Desktop (local only)

Implementer runs `cargo check`, `pnpm typecheck`, `pnpm test -- --run`, `pnpm build`, and `pnpm tauri dev` smoke. Point the `SERVER_BASE` constant temporarily at `http://localhost:3002/api/license` if testing against local server; otherwise it still hits prod (and the new endpoints will 404 there since prod hasn't been updated — that's expected).

**No push, no bundle, no release.**

### Plugin

No changes.

### When user is ready to ship

1. `git push` from both repos
2. Apply schema (1 INSERT) via existing recipe
3. Docker build + scp + load + compose up -d for `whatsub-license`
4. Desktop: future Tauri auto-update release (not Plan D's job)

---

## 8. Testing

### Server (pg-mem + vitest)

- `POST /api/auth/from-license`: success path, license not found, missing-email license, rate-limit
- `GET /api/corpus/versions`: returns mine + public correctly, mine=0 when no contributions, requires auth
- `POST /api/admin/corpus/publish`: bumps app_settings, requires admin auth
- `/api/corpus/browse` filter: phrases with `last_seen_at > public_corpus_version` are excluded; after publish, all visible
- `/api/admin/corpus/list`: returns `unpublishedCount`

### Desktop

- No new unit tests for the cache layer beyond a trivial useCorpusList test (mock invoke + store)
- `auth_from_license` Rust command tested via mock HTTP server (or just smoke via tauri dev)

### Manual smoke (after server deploy + desktop local)

- Open desktop with a license key already activated → no AuthCard, lands on Library
- Switch to 公共语料库 tab → empty (since no public phrases have been published yet)
- Admin SPA: add a phrase → 推送更新 → desktop close + reopen → phrase visible
- Add second phrase but DON'T 推送更新 → desktop close + reopen → only first phrase visible (cache hit on /versions, no re-fetch)
- 推送更新 → desktop close + reopen → both phrases visible
- Desktop: click ↻ refresh → re-fetches both /mine and /browse

---

## 9. Open risks

- **License-key copy from machine A to machine B:** Anyone with the license key can `/api/auth/from-license` and get a session. This is the existing trust model; we're not weakening it. Worth a future hardening with device fingerprint binding, but out of scope.
- **Stale cache after manual server intervention:** If admin deletes a phrase via psql (not via the SPA), `public_corpus_version` doesn't auto-bump. Workaround: click 推送更新 after manual interventions. Documented.
- **Cache invalidation drift on long-running app:** If user keeps desktop open for hours, `useCorpusList` runs at mount only. No polling. User can hit ↻ to refresh. Acceptable for MVP; future could add periodic `/versions` polling every 5 minutes.
- **app_settings.value is TEXT:** Plan A's schema has `app_settings.value TEXT`. We're storing a numeric ms timestamp as text and casting `::bigint`. Same pattern as DeepSeek key. Works fine but worth noting.
