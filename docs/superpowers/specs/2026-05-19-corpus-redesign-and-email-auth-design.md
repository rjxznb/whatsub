# Corpus Redesign + Email Auth + Bridge Removal

Date: 2026-05-19
Status: design approved, pending implementation plan

Spans three repos: whatsub-license (server), whatsub-plugin (browser
extension), Get_Video/client (Tauri desktop). Single coherent change —
the auth subsystem, corpus data model, and bridge removal are
tightly-coupled and break in inconsistent intermediate states.

## Goal

Replace the current peer-to-peer "vocab notebook" model with a single
cloud-backed **corpus** that has two layers:

- **Public corpus** (curator-only writes, paid-license reads): English
  phrases hand-curated by the admin, with Chinese meaning + multiple
  video clip examples (url + timestamp + context).
- **Personal corpus** (each authenticated user, free reads/writes for
  themselves): whatever they save via the plugin's selection bubble.

Identity is established by email + 6-digit verification code → 30-day
session token. The same email used on plugin and desktop sees the same
personal corpus.

The local bridge module that previously synced vocab between plugin and
desktop is deleted — cloud is now the single source of truth, no
peer-to-peer sync needed.

## Out of scope (deferred)

- Vocab migration from local IndexedDB into cloud corpus. Users who
  upgrade lose their old "vocab" notebook; acceptable per the session
  with the user — corpus was empty in practice anyway.
- Username/profile/social features.
- Forgot-email / change-email flows.
- Public corpus search / full-text indexing (browse-by-scene is enough
  for first cut).
- Per-user license email re-binding flow (if a user changes their
  license-purchase email after onboarding, no automated re-link).
- Multi-language corpus (English-Chinese only).

---

## Architecture overview

```
                      ┌──────────────────────────┐
                      │ Server (whatsub-license) │
                      │ ┌──────────────────────┐ │
                      │ │ auth (email codes,   │ │
                      │ │   session tokens)    │ │
                      │ │ corpus (public +     │ │
                      │ │   personal, gated    │ │
                      │ │   by license)        │ │
                      │ │ admin curate form    │ │
                      │ └──────────────────────┘ │
                      └─────────▲──────▲─────────┘
                                │      │
                  same email →  │      │  same email →
                  same          │      │  same
                  contributor   │      │  contributor
                                │      │
              ┌─────────────────┘      └───────────────┐
              │                                        │
   ┌──────────┴────────────┐              ┌────────────┴───────────┐
   │ Plugin (whatsub-plugin)│              │ Desktop (Tauri client) │
   │ - email code onboard   │              │ - email code onboard   │
   │ - selection bubble     │              │ - new 语料库 tab       │
   │ - public + personal    │              │ - public scenes tree   │
   │ - NO local vocab DB    │              │ - personal flat list   │
   │ - NO bridge code       │              │ - YouTube iframe embed │
   └────────────────────────┘              │ - NO bridge module     │
                                           │ - NO vocab notebook    │
                                           └────────────────────────┘
```

---

## 1. Email auth subsystem (server)

### Tables

```sql
CREATE TABLE IF NOT EXISTS email_codes (
    email          TEXT     NOT NULL,
    code_hash      TEXT     NOT NULL,    -- bcrypt or sha256(code)
    expires_at     BIGINT   NOT NULL,
    attempts       INTEGER  NOT NULL DEFAULT 0,
    created_at     BIGINT   NOT NULL,
    PRIMARY KEY (email, created_at)
);
CREATE INDEX IF NOT EXISTS idx_email_codes_email_recent
    ON email_codes (email, created_at DESC);

CREATE TABLE IF NOT EXISTS session_tokens (
    token_hash     TEXT     PRIMARY KEY,
    email          TEXT     NOT NULL,
    issued_at      BIGINT   NOT NULL,
    expires_at     BIGINT   NOT NULL,
    last_used_at   BIGINT
);
CREATE INDEX IF NOT EXISTS idx_session_tokens_email
    ON session_tokens (email);
```

`email` is `lower(trim(input))` to normalize. `code_hash` and
`token_hash` store sha256 of the actual secret so a DB leak doesn't
expose live tokens.

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/send-code` | none, rate-limited by IP | Body `{email}`. Generates 6-digit code, hashes, inserts row, sends SMTP. |
| `POST` | `/api/auth/verify-code` | none | Body `{email, code}`. Looks up latest unexpired code, checks hash, returns `{sessionToken, expiresAt}` on match. Clears matched code. |
| `POST` | `/api/auth/logout` | bearer session | Deletes session token row. |
| `GET`  | `/api/auth/me` | bearer session | Returns `{email, hasActiveLicense}` for client to render login state. |

### Code rules

- 6 digits, `0`-`9`. Crypto-secure random.
- 10-minute expiry.
- Max 3 verify attempts per code, then code is invalidated.
- Max 5 send-code requests per email per hour. Max 20 per IP per hour.
  Use the existing `rate_buckets` table (extend `bucket_kind` to include
  `auth_send_email` and `auth_send_ip`).

### Session token rules

- 32 random bytes, base64url-encoded.
- 30-day expiry, sliding window: `last_used_at` updated on each auth'd
  request; reissued if accessed within last 7 days.
- Stored on plugin in `chrome.storage.local`. On desktop in OS
  keychain (already used for license key).

### Bearer middleware

Any route requiring auth declares a Hono middleware that:
1. Reads `Authorization: Bearer <token>`.
2. Hashes, looks up in `session_tokens`, checks `expires_at > now`.
3. If valid: attach `c.set('email', row.email)` and `c.set('hasActiveLicense', ...)` (computed via `licenses.email = ... AND deactivated_at IS NULL`). Calls `next()`.
4. If invalid: returns 401 `{error: 'auth_required'}`.

A separate middleware `requireActiveLicense` runs after `requireAuth`
and 403s when `hasActiveLicense === false`.

### License email matching

Licenses already store `email`. Match is `licenses.email = sessions.email`
(both already normalized lowercased). If a user authenticates with the
same email they used at purchase, license is automatically associated.
If they use a different email, the public corpus stays locked — they
need to re-authenticate with the purchase email.

---

## 2. Corpus data model

### Schema delta

```sql
ALTER TABLE corpus_phrases ADD COLUMN IF NOT EXISTS meaning_zh TEXT;
```

`corpus_phrases.contributor_id` doesn't exist (contributions live in a
separate table), so no schema change to add an "owner" — ownership is
still per-contribution.

```sql
-- After this change:
corpus_phrases       (phrase_normalized PK, phrase_raw, meaning_zh, tags JSONB, ...)
                     ↑ one row per phrase, shared across contributors
corpus_contributions (id, phrase_normalized FK, context_sentence,
                      source JSONB, contributor_id TEXT, ...)
                     ↑ contributor_id = 'whatsub-curator' for public,
                       sha256(email).slice(0, 16) for personal
```

### Public vs personal disambiguation

- **Public**: `contributor_id = 'whatsub-curator'` (sentinel, already
  used by seed_corpus.py).
- **Personal**: `contributor_id = sha256(normalized_email).slice(0, 16)`.
  This way both plugin and desktop, authenticated with the same email,
  see the same personal corpus without storing email plaintext as the
  FK.

### `meaning_zh` field

- Required when admin uses the curate form (public phrases).
- Optional for personal entries (the plugin selection bubble already
  asks for "中文释义" but it's currently free-form and goes into a
  separate vocab table — now it lands in `corpus_phrases.meaning_zh`
  the first time anyone saves the phrase, and is left alone on
  subsequent saves to avoid one user clobbering another's translation).

### Classifier wire-off

`/api/corpus/contribute` no longer enqueues classify jobs. Admin curate
form takes a manually-selected `scene` and writes it directly into
`tags.scene`. Personal contributions don't get scene tags (they're not
browsed by scene). The `app_settings` table, the DeepSeek key admin
UI, and the classifier module stay in the codebase — only the
enqueue call site is removed, so future re-enablement is one line.

---

## 3. Server: corpus endpoints

| Method | Path | Auth | Behavior |
|---|---|---|---|
| `POST` | `/api/admin/corpus/curate` | admin bearer | Body `{phraseRaw, meaningZh, scene, instances: [{url, timestampSec, contextSentence}]}`. Upserts `corpus_phrases` (setting meaning_zh + tags.scene), inserts one `corpus_contributions` row per instance with `contributor_id = 'whatsub-curator'`. URL is normalized to canonical `youtu.be/<id>?t=<sec>` form (use existing `canonicalizeUrl.ts`). |
| `POST` | `/api/corpus/contribute` | session bearer | Same as today but server derives `contributor_id` from auth context (`sha256(email).slice(0,16)`); plugin no longer sends it. Hard-rejects `contributor_id = 'whatsub-curator'` defensively. |
| `GET`  | `/api/corpus/lookup` | session bearer | New query param `withScope=true` returns `{phrase, publicContributions, personalContributions}` (split by curator vs not). Public contributions stripped to `[]` when `!hasActiveLicense`. |
| `GET`  | `/api/corpus/browse` | session bearer + license | Public-only browse by scene. 403 without license. |
| `GET`  | `/api/corpus/mine` | session bearer | NEW: returns personal contributions for current email, paginated. Desktop "我的" view uses this. |

The existing `DELETE /api/corpus/mine` keeps working — it now deletes
by `contributor_id = sha256(email)`.

### Removed concerns

- The `shareToPublicExplicit` body field on `/contribute` is ignored
  (everything is personal).
- The blocklist + flag mechanism remains — admin can still hide
  personal contributions that get flagged 3 times (rare but possible
  if personal corpus is shared via some future feature).

---

## 4. Admin SPA — curate form

Add a "+ 添加" button to the existing 语料 tab. Click opens a modal:

```
英文短语    [small talk                       ]
中文释义    [闲聊；客套话                       ]
场景        [社交日常 ▾]   ← 18-option dropdown, required

视频实例 (≥1)
┌────────────────────────────────────────────┐
│ URL          [https://youtu.be/abc?t=120 ] │
│ 上下文句子   [Let's just make some small…]  │
│ [删除此条]                                  │
└────────────────────────────────────────────┘
[+ 再加一个]
[取消]  [保存]
```

- Add-instance button repeats the URL+context block.
- URL parsing tolerant: youtu.be, watch?v=, with or without `t=` /
  `&start=`. Backend canonicalizes.
- Saves call `POST /api/admin/corpus/curate`. On success: close modal,
  refresh the table.

---

## 5. Plugin changes

### New: onboarding flow

On startup (`src/cs/*/index.ts` boot + `src/ui/popup`), if no session
token in `chrome.storage.local`:

1. Show inline panel in popup: "登录使用 whatsub" + email input + "发送验证码" button.
2. POST `/api/auth/send-code`. Show toast "验证码已发送".
3. Reveal code input + "验证" button.
4. POST `/api/auth/verify-code`. Store session token + email + expiry.
5. Close panel. Plugin enters authenticated state.

Same flow embedded in the SelectionBubble: if user tries to save and
isn't authenticated, the bubble swaps its main view to an inline auth
form instead of failing silently.

### Deleted

- `src/state/vocab.ts` (IndexedDB store).
- All `chrome.runtime.sendMessage({type: "save-vocab"})` paths in
  service worker. Replace with `corpus-contribute` direct.
- Bridge client: `src/sw/bridge*` (HTTP calls into desktop's actix
  server).
- `SelectionBubble.tsx`: `shareExplicit` state + "也分享到公共语料库"
  checkbox.

### Modified

- `SelectionBubble.tsx`: button "⭐ 收藏" → "+ 加入语料库". Second-screen
  splits into two sections:
  ```
  📚 公共语料库 (whatsub 整理)
    Friends S05E14 · "make small talk"            ← clickable, opens
    BBC Learning English · "what's small talk"     ← youtu.be?t=… tab
    [shown only if hasActiveLicense]

  ⭐ 你的收藏
    [your past contributions for this phrase]
  ```
- `popup/index.html`: render login form when not authenticated, render
  "已登录: user@example.com / hasLicense: true|false" when authed.
- `options/index.html`: LLM provider/key section becomes the primary
  config (no longer auto-pulled from desktop). Add a "请填写 LLM API
  Key" hint when empty.

### Storage

- `chrome.storage.local.sessionToken`: the bearer token.
- `chrome.storage.local.email`: cached email for UI display.
- `chrome.storage.local.expiresAt`: numeric ms.
- All vocab-related keys deleted on upgrade (one-time migration step in
  service worker boot — `chrome.storage.local.remove(['vocab', 'vocabIndex', …])`).

---

## 6. Desktop client (Tauri) changes

### New: onboarding flow

Same pattern as plugin. First launch (no session token in OS keychain):
modal with email input → send-code → enter code → verify → store
token in keychain. Same UI strings as plugin for consistency.

### Deleted

- `src-tauri/src/bridge/` (entire module: server.rs, routes.rs,
  handoff.rs, port.rs, mod.rs).
- `BridgeState` from `main.rs` + `start_bridge` call + `bridge_set_enabled` command.
- Settings page's "桥接 (浏览器插件)" section + `bridgeEnabled`
  toggle + `BridgeState` Tauri state binding.
- Frontend `src/pages/Vocab.tsx` (or wherever the existing 词汇本
  page lives) — replaced by 语料库.
- IndexedDB vocab store (frontend) + Rust commands that manage it.

### Added

- New page: `src/pages/Corpus.tsx`. Three-column layout (see Section 4
  of brainstorm for ASCII mockup):
  - Left rail: scene tree (公共) + "我的" leaf
  - Middle: phrase list filtered by selection
  - Right: phrase detail (meaning_zh + instance list) + embedded
    YouTube iframe player

- New Rust commands:
  - `corpus_browse(scene: Option<String>, page: u32) → CorpusBrowseResp`
  - `corpus_mine(page: u32) → CorpusMineResp`
  - `corpus_phrase_detail(phrase_normalized: String) → CorpusPhraseDetail`
  All do `reqwest` calls to server with the keychain session token.

- `tauri.conf.json` CSP gains `frame-src https://www.youtube.com;`. No
  other CSP relaxations needed.

### Embed player component

```tsx
<iframe
  src={`https://www.youtube.com/embed/${videoId}?start=${timestampSec}&autoplay=1`}
  allow="autoplay; encrypted-media"
  width="100%"
  height="360"
/>
```

URL is computed from `instance.source.url` (canonicalized server-side
to `youtu.be/<id>?t=<sec>`) — parse out videoId + timestampSec on
desktop side. No special handling of age-gated / private videos — they
fail open with YouTube's "video unavailable" embed UI, which is fine
for an admin-curated library where admin only adds working videos.

---

## 7. Migration

### Server

1. Apply schema delta (3 new tables + 1 new column, all `IF NOT EXISTS` / `IF NOT EXISTS` for the column → idempotent).
2. Existing `/api/corpus/*` endpoints gain auth middleware. **Breaking change for current plugin installs.** Mitigation: server returns 401 with `{error: 'auth_required'}` — old plugins will see contributions fail silently (existing spec §13 silent-drop policy). Push plugin update simultaneously to migrate users.
3. Existing curator-seeded data (if any — session memory says none was seeded) is left in place; new admin curate form upserts merge meaning_zh into existing phrases.

### Plugin

1. Source code change + dist rebuild + `git add web-plugin/dist` (per `[[feedback_plugin_commit_dist]]`).
2. On upgrade, service worker boot detects old vocab keys in `chrome.storage.local` and deletes them. User's local-only vocab is **lost** — acceptable, this was discussed.
3. On first post-upgrade selection, user is prompted to authenticate.

### Desktop

1. New Tauri release with bridge module removed + 语料库 tab.
2. Auto-updater pushes it.
3. First post-upgrade launch: modal asks for email + code.

### Bridge teardown order (avoid intermediate brokenness)

Critical ordering: **plugin update must roll out BEFORE desktop bridge
removal**. If desktop drops bridge endpoints before plugin stops
calling them, the plugin's vocab-sync goes silently dead but the user
sees no error.

Sequence:
1. Ship server changes (additive — auth + corpus changes, doesn't
   break old clients yet because middleware can be soft-fail for a
   transition window if needed).
2. Ship plugin update with new auth + cloud-corpus paths + bridge
   client deleted.
3. Ship desktop update with bridge module deleted + new 语料库 tab.
4. (Optional, post-stable) flip server middleware from soft-fail to
   401 reject for unauthed corpus writes.

---

## 8. Testing

### Server (vitest + pg-mem)
- Email code: send → verify → token issued; expired code rejected;
  wrong code consumes an attempt; 3 wrong attempts invalidates.
- Send-code rate limit per email and per IP.
- Session token middleware: missing / invalid / expired all 401.
- `requireActiveLicense`: matched email with active license passes;
  matched email with no license 403s; mismatched email 403s.
- `POST /admin/corpus/curate`: success path; URL canonicalization;
  multiple instances; updating existing phrase merges meaning_zh.
- `POST /api/corpus/contribute`: server-derived contributor_id;
  attempting to pass `contributor_id: 'whatsub-curator'` is rejected.
- `GET /api/corpus/lookup?withScope=true`: split into public/personal;
  public contributions empty when no license.
- `GET /api/corpus/browse`: 403 without license; works with license.

### Plugin (vitest)
- New `useAuth` hook: send-code state, verify-code state, token
  persistence, sign-out.
- SelectionBubble shows auth form when no token.
- ContributionsList renders two sections; renders only personal when
  hasActiveLicense=false.

### Desktop (vitest for React, cargo test for Rust)
- React: Corpus page renders scene tree + handles "我的" selection;
  YouTube iframe URL builder.
- Rust: corpus_browse / corpus_mine / corpus_phrase_detail commands
  build the right URL + headers from keychain session.

No e2e for the YouTube embed itself — manual smoke (admin loads
desktop, opens 语料库, picks a phrase, video plays).

---

## 9. Open risks

- **Email deliverability**: existing SMTP (QQ) is fine for license
  emails but verification codes need to arrive fast (< 1 min) or UX
  rots. If deliverability tanks we may need a transactional provider
  (Resend / Postmark). Probe: send 5 test codes to gmail + outlook +
  qq + 163 + foxmail in first prod week.
- **License email mismatch**: a non-trivial fraction of users will use
  a different email at signup vs purchase. Initial mitigation: surface
  "您的购买邮箱是 xyz@abc.com，登录使用同一邮箱以解锁公共库" in the
  paywall. If too many tickets, add a `/api/auth/link-license` flow
  later.
- **Plugin/desktop version skew**: users who don't update the plugin
  in time after server cuts over to require auth get silent contribute
  failures. Versioned server middleware can soft-fail unauthed corpus
  writes for 30 days post-launch to widen the window.
- **YouTube embed availability**: some videos disable embedding. Admin
  needs to verify each curated video plays in embed before publishing.
  Not worth automating — admin volume is low.
