# Import login guidance — design

**Date:** 2026-06-30
**Scope:** `client/` (Tauri desktop app)
**Status:** approved, pending implementation plan

## Problem

When a video download hits a site bot-check / login-required error, the user
should be guided to log in. Today this works **only** on the foreground manual
import path (`ImportModal` / `ImportChecklistDialog`), which map yt-dlp stderr
through `utils/friendlyError.ts` and render a 「立即登录」 button.

Two gaps:

1. **Background / AI-agent imports never surface the login button.** The agent
   `import_video` tool is fire-and-watch (`background: true`) — `invoke` returns
   immediately after enqueue, so the tool never sees the download error. The
   failure lands out-of-band in `store/downloadQueue.ts` (`phase: "error"`) and
   `DownloadQueueWidget` renders it as a single line of raw, un-mapped error text
   (`shortError(item.error)`). No `friendlyError`, no login button. The agent
   path is therefore *strictly worse* than manual import for bot errors.

2. **No proactive cookie-expiry check.** `read_cookies_file()` blindly passes
   whatever cookie file resolves (or none) to yt-dlp; nothing checks whether the
   in-app login cookies are expired before spending minutes downloading. A
   `youtube_cookies_info` command exists but is dead code and only returns
   `{ path, exists }` — no expiry data.

## Goals

- **A.** Any failed import (foreground, AI-agent, iOS import-queue) that maps to
  a login-class error surfaces a 「立即登录」 button, covering every site with a
  `friendlyError` login preset (YouTube / Instagram / Bilibili / X / TikTok).
- **B.** Before an import starts, if the user relies on in-app cookies for the
  target site and those cookies are expired / expiring, show a **non-blocking**
  proactive login suggestion.

## Non-goals

- Auto-launching the login browser without a user click (explicitly rejected —
  surprising popup). Login is always button-initiated.
- Hard-blocking an import when cookies are expired (many videos download
  anonymously; pre-check only *suggests*).
- A "learn new examples" pattern→cue index, or any change to the cookie harvest
  / CDP login mechanism itself.

## Key architectural facts (verified)

- `src/store/downloadQueue.ts:216` (`case "Failed"`) is the **single app-wide**
  sink for every import failure — foreground, agent, and iOS-queue all flow
  through the one `listen("pipeline-event")` subscribed once in `App.tsx`. Fixing
  the login button here covers all paths with no per-call-site changes.
- The login flow (`site_login_start` → user logs in → `site_login_finish` →
  CDP harvest → `site-login-success` / `site-login-cancelled` events; plus
  `site_login_pending` to detect in-flight) is currently inlined in
  `ImportChecklistDialog.tsx:180-234`.
- Cookie jar on disk: `core/cookie_jar.rs` → `cookies.json`, shape
  `{ version, sites: { <siteKey>: { label, loginAt, cookies: [{ domain, path,
  secure, expires, name, value }] } } }`. `expires` is epoch **seconds**;
  `<= 0` means a session cookie.
- `friendlyError(raw, phase)` returns an optional `action: SiteLoginAction`
  (`{ kind, siteKey, siteLabel, loginUrl, harvestDomains }`) plus `actionTier`
  (`primary` / `secondary`). The `SiteLoginAction` shape already carries
  everything `site_login_start` needs.

## Design

### Shared login flow: `useSiteLogin` hook + `SiteLoginModal`

Extract the start/finish/pending/success-cancel logic out of
`ImportChecklistDialog` into:

- `src/hooks/useSiteLogin.ts` — encapsulates: load `site_presets` + browsers,
  `startLogin(args)`, `finishLogin()`, `cancelLogin()`, in-flight `pendingLogin`
  / `starting` / `savingLogin` / `loginError` state, and the
  `site-login-success` / `site-login-cancelled` event subscription. Accepts
  callbacks (`onSuccess`, `onCancelled`) so each consumer reacts appropriately.
- `src/components/SiteLoginModal.tsx` — thin presentational modal driven by the
  hook, openable targeted at a specific `siteKey` (preselected) with a
  `SiteLoginAction`-shaped arg, OR with the site picker (the existing
  checklist behavior).

`ImportChecklistDialog` is refactored to consume the hook (mechanical; removes
duplication and trims a large file). No behavior change there.

### Feature A — failed import → 「立即登录」 button

In `DownloadQueueWidget`, for items with `phase === "error" && error`:

1. Run `friendlyError(item.error)`.
2. Render the friendly `title` + `suggestion` (replaces the raw `shortError`
   line; raw text stays available as a title/expander).
3. If `friendlyError` returns an `action`, render **「立即登录 <siteLabel>」**
   → opens `SiteLoginModal` preselected to `action.siteKey` (passing the
   action's `loginUrl` / `harvestDomains`).
4. On `site-login-success`, show a **「重试」** on that item that re-imports with
   the original URL + quality.

**Open implementation detail:** confirm the download-queue item carries the
original source URL + quality needed for 「重试」. If not, add those fields where
items are upserted (`store/downloadQueue.ts` + emit sites). If retry can't be
cleanly supported, ship the login button alone and let the user re-import
manually — the login button is the core deliverable; retry is the nicety.

### Feature B — pre-import cookie-expiry pre-check

**Rust:** new command `cookies_status(site_key: Option<String>)` →
`Vec<CookieSiteStatus>` (or a single entry when `site_key` is given), where
`CookieSiteStatus = { siteKey, label, exists, expired, expiringSoon, expiresAt }`.

- Reads `cookies.json` via `core::cookie_jar`. For the queried site bucket:
  `expiresAt = max(expires for cookies where expires > 0)` (the longest-lived
  cookie ≈ when the login dies; YouTube auth cookies expire together, so `max`
  avoids false alarms from short-lived trivial cookies). `expired = expiresAt <
  now`; `expiringSoon = expiresAt < now + 7d`. A bucket with only session
  cookies (no `expires > 0`) → `expired = false, expiringSoon = false` (can't
  tell; don't nag).
- `exists = false` when there is no bucket for the site.
- Rust unit-tested with injected temp `cookies.json` paths (per `paths::*` rule).

Delete the dead `youtube_cookies_info` + `CookiesInfo`.

**Call sites (only when `cookieSource === "in-app"` and the bucket exists):**

- `ImportModal`: after the entered URL resolves to a site, call
  `cookies_status(siteKey)`; if `expired` / `expiringSoon`, show a **non-blocking**
  inline note 「<站点>登录可能已过期，点此重新登录」 → opens `SiteLoginModal`.
  Import is still allowed (anonymous download may work).
- Agent `import_video` tool: before the fire-and-watch `invoke`, call
  `cookies_status(siteKey)`; if `expired`, include a short note in the tool
  result so the agent can warn the user. (Lightweight; no flow change.)

Site detection from a URL reuses the existing host→siteKey mapping
(`friendlyError` LOGIN_PRESETS / `site_presets`); centralize a small
`siteKeyForUrl(url)` helper if one doesn't already exist.

## Testing

- `friendlyError.ts` — already covered; add a case asserting a bot-error string
  yields an `action` consumed by the widget.
- `cookies_status` — Rust unit tests: expired bucket, expiring-soon bucket,
  fresh bucket, session-only bucket, missing bucket. Temp paths only.
- `useSiteLogin` — hook test: start → pending → success/cancel transitions.
- `DownloadQueueWidget` — render test: a login-class failed item shows the
  「立即登录」 button; a non-login failure does not.
- `ImportModal` — pre-check shows the note only when `cookieSource === "in-app"`
  + expired; does not block import.

## Rollout / risk

- Pure additive UI + one new read-only Rust command; no migration, no change to
  the download pipeline or cookie harvest.
- Main risk is the `ImportChecklistDialog` refactor — mechanical, covered by its
  existing behavior; verify the manual import + login path still works in a real
  `pnpm tauri build` (CSP/eval and packaged-only pitfalls do not apply here, but
  the login flow spawns a real browser, so smoke-test it).
