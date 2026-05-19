# Plan C: Desktop Email Auth + Corpus Tab + Bridge Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email + 6-digit-code authentication to the Tauri desktop client, delete the local bridge HTTP module, add a new "公共语料库" tab that reads from Plan A's cloud corpus and plays YouTube clips via embedded iframe.

**Architecture:** Identity = session token from Plan A's `/api/auth/{send-code,verify-code}`, stored via `tauri-plugin-store` (or app-data file fallback) in OS-appropriate location. Rust commands wrap HTTP calls to the server. The new Corpus page is a 3-column React layout backed by these commands; phrase detail pane embeds `https://www.youtube.com/embed/<id>?start=<sec>&autoplay=1`. The bridge module (peer-to-peer HTTP server for plugin↔desktop sync) is deleted entirely.

**Tech Stack:** Tauri 2 + Rust + React 19 + Vite + Zustand + React Router 6 + reqwest. Frontend tests via Vitest; Rust tests via `cargo test`.

**Spec:** `Get_Video/docs/superpowers/specs/2026-05-19-corpus-redesign-and-email-auth-design.md` §6

**Server contract baseline:** Plan A is deployed at `whatsub.eversay.cc`. nginx maps `/api/license/auth/*` → server `/api/auth/*`, `/api/license/corpus/*` → server `/api/corpus/*`. Auth endpoints + corpus endpoints are documented in Plan B's plugin `authClient.ts` and `corpusClient.ts`.

**Plan B baseline:** Plugin (`whatsub-plugin`) is on `main @ 3dcb88f`. Plan B's contracts:
- Bearer session token via `Authorization: Bearer <token>` for `/api/corpus/{contribute,mine}` and `/api/corpus/lookup?withScope=true`
- `/api/corpus/browse` requires Bearer + active license (server 403s if no license)
- `contributor_id` derived server-side from session email — clients don't send it
- `DELETE /api/corpus/mine` (legacy) still accepts body `contributorId = sha256(email).slice(0,16)`

**Out of scope for Plan C** (deferred to Plan D or later):
- In-player save flows (`StarButton`, `SubtitleSelectionBubble`, `VocabHighlight`) — these currently write to the local `useVocabulary` Zustand store. Rewiring them to cloud `corpus.contribute` is a separate plan.
- Local `useVocabulary` store deletion. Kept in place for now; `/vocab` route remains accessible but the "公共语料库" tab is the new primary surface.
- Migration of existing local vocab into the cloud personal corpus. Users keep their local notebook; new in-player saves continue writing locally.
- Tauri auto-update release pipeline / CI publish. Per user: "先不要 CI，只在本地改一下" — this plan ends at local `pnpm tauri dev` smoke.
- Settings tab major redesign. Only the bridge toggle is removed; other sections untouched.

**Working branch:** Work directly on `Get_Video/main`. Per CLAUDE.md release safety note: "Before any release `git commit`, always run `git branch --show-current` and confirm it's `main`." This plan does NOT release — but the same branch hygiene applies (every commit hand-confirms main, no push to remote until user explicitly requests).

**No push, no bundle, no release.** Implementer should `git commit` locally per task but NEVER `git push` and NEVER run `cargo build --release` or `pnpm tauri build`.

---

## File Map

### Create

**Rust side (`client/src-tauri/src/`):**
- `auth.rs` — session token storage (read/write/clear via tauri-plugin-store or fs)
- `commands/auth.rs` — `auth_send_code`, `auth_verify_code`, `auth_me`, `auth_logout` Tauri commands
- `commands/corpus.rs` — `corpus_browse`, `corpus_mine`, `corpus_phrase_detail` Tauri commands

**Frontend (`client/src/`):**
- `store/auth.ts` — Zustand store wrapping `invoke("auth_*")` Rust calls
- `store/auth.test.ts` — store unit tests (mock `@tauri-apps/api/core` invoke)
- `components/AuthCard.tsx` — email + 6-digit code login form
- `components/AuthCard.test.tsx`
- `pages/Corpus.tsx` — three-column layout (scene tree / phrase list / detail+embed)
- `components/CorpusSceneTree.tsx` — left column
- `components/CorpusPhraseList.tsx` — middle column
- `components/CorpusPhraseDetail.tsx` — right column with `<YouTubeEmbed>`
- `components/YouTubeEmbed.tsx` — `<iframe>` wrapper with timestamp parsing
- `components/YouTubeEmbed.test.tsx`

### Modify
- `client/src-tauri/src/main.rs` — register new commands; remove `BridgeState` + `start_bridge` + `bridge_set_enabled`
- `client/src-tauri/src/lib.rs` — same as main.rs if the wiring lives there
- `client/src-tauri/tauri.conf.json` — set `security.csp` to allow `frame-src https://www.youtube.com https://www.youtube-nocookie.com`
- `client/src-tauri/Cargo.toml` — add `tauri-plugin-store` (or pin existing if already present)
- `client/src/App.tsx` — gate routes on auth; add `/corpus` route + redirect `/vocab` → `/corpus` (or keep both, see C18); remove bridge-related UI hooks
- `client/src/pages/Settings.tsx` — remove the bridgeEnabled toggle + its `invoke("bridge_set_enabled", ...)` call
- `client/src/components/Layout.tsx` (or wherever the top nav lives) — add "公共语料库" link

### Delete
- `client/src-tauri/src/bridge/` (entire directory: `handoff.rs`, `mod.rs`, `port.rs`, `routes.rs`, `server.rs`)
- Any frontend reference to bridge state (`useBridge` hook if it exists, `BridgeStatus` display in StatusPill-equivalent)

Test command throughout: `pnpm --filter client test -- --run` for frontend, `cargo test` (from `src-tauri/`) for Rust.

Local smoke: `pnpm tauri dev` (from `client/`).

---

## Task C1: `src-tauri/src/auth.rs` — session token storage

**Files:**
- Create: `client/src-tauri/src/auth.rs`

Tauri 2 doesn't ship with first-class keychain wrappers; the common pattern is `tauri-plugin-store` (cross-platform encrypted-at-rest store via app data dir). The plan uses `tauri-plugin-store` as it's already pinned in the Tauri ecosystem and survives reinstall.

- [ ] **Step 1: Verify or add `tauri-plugin-store` to `Cargo.toml`**

```bash
grep "tauri-plugin-store" client/src-tauri/Cargo.toml
```

If missing, add to `[dependencies]`:
```toml
tauri-plugin-store = "2"
```

If present, ensure it's `"2"` or newer.

- [ ] **Step 2: Implement `auth.rs`**

```rust
//! Session token storage for whatSub cloud auth (Plan C).
//!
//! Uses tauri-plugin-store to persist the email + sessionToken + expiresAt
//! tuple in the OS app-data dir. Survives app restart; cleared by logout.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "auth.json";
const KEY_SESSION_TOKEN: &str = "sessionToken";
const KEY_EMAIL: &str = "email";
const KEY_EXPIRES_AT: &str = "expiresAt";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthState {
    pub session_token: String,
    pub email: String,
    pub expires_at: i64,
}

pub fn get_auth<R: Runtime>(app: &AppHandle<R>) -> Option<AuthState> {
    let store = app.store(STORE_FILE).ok()?;
    let token = store.get(KEY_SESSION_TOKEN)?.as_str()?.to_string();
    let email = store.get(KEY_EMAIL)?.as_str()?.to_string();
    let expires_at = store.get(KEY_EXPIRES_AT)?.as_i64()?;
    Some(AuthState { session_token: token, email, expires_at })
}

pub fn set_auth<R: Runtime>(app: &AppHandle<R>, auth: &AuthState) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(KEY_SESSION_TOKEN, serde_json::Value::String(auth.session_token.clone()));
    store.set(KEY_EMAIL, serde_json::Value::String(auth.email.clone()));
    store.set(KEY_EXPIRES_AT, serde_json::Value::Number(auth.expires_at.into()));
    store.save().map_err(|e| e.to_string())
}

pub fn clear_auth<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.delete(KEY_SESSION_TOKEN);
    store.delete(KEY_EMAIL);
    store.delete(KEY_EXPIRES_AT);
    store.save().map_err(|e| e.to_string())
}

pub fn is_valid(auth: &AuthState) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    auth.expires_at > now
}
```

If the exact `tauri-plugin-store` v2 API differs (e.g. `app.store()` returns a future, or the method name is `with_store`), adapt to the actual API. Run `cargo check` after writing and adjust.

- [ ] **Step 3: Register the plugin in `lib.rs` or `main.rs`**

Find the `tauri::Builder::default()` call. Add:

```rust
.plugin(tauri_plugin_store::Builder::new().build())
```

Place it alongside the existing `.plugin(...)` calls.

- [ ] **Step 4: Compile check**

```bash
cd client/src-tauri
cargo check
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add client/src-tauri/Cargo.toml client/src-tauri/src/auth.rs client/src-tauri/src/main.rs client/src-tauri/src/lib.rs
git commit -m "feat(client/auth): session token storage via tauri-plugin-store"
```

---

## Task C2: `commands/auth.rs` — auth_send_code, auth_verify_code, auth_me, auth_logout

**Files:**
- Create: `client/src-tauri/src/commands/auth.rs`
- Modify: `client/src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Write `commands/auth.rs`**

```rust
//! Auth Tauri commands invoked from the React UI.
//! Wraps server HTTP calls + persists session via `auth::*`.

use crate::auth::{self, AuthState};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

const SERVER_BASE: &str = "https://whatsub.eversay.cc/api/license";

#[derive(Serialize)]
struct SendCodeReq<'a> { email: &'a str }

#[derive(Serialize)]
struct VerifyCodeReq<'a> { email: &'a str, code: &'a str }

#[derive(Deserialize)]
struct VerifyCodeResp {
    #[serde(rename = "sessionToken")] session_token: String,
    #[serde(rename = "expiresAt")] expires_at: i64,
}

#[derive(Deserialize)]
struct MeResp {
    email: String,
    #[serde(rename = "hasActiveLicense")] has_active_license: bool,
}

#[derive(Serialize)]
pub struct AuthResult {
    pub ok: bool,
    pub reason: Option<String>,
}

#[derive(Serialize)]
pub struct StatusResult {
    pub authenticated: bool,
    pub email: Option<String>,
    pub has_active_license: Option<bool>,
}

fn map_reason(body: &serde_json::Value) -> String {
    body.get("error")
        .and_then(|e| e.as_str())
        .or_else(|| body.get("reason").and_then(|r| r.as_str()))
        .unwrap_or("unknown")
        .to_string()
}

#[tauri::command]
pub async fn auth_send_code(email: String) -> Result<AuthResult, String> {
    let client = Client::new();
    let resp = client
        .post(format!("{}/auth/send-code", SERVER_BASE))
        .json(&SendCodeReq { email: &email })
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(AuthResult { ok: true, reason: None })
    } else {
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));
        Ok(AuthResult { ok: false, reason: Some(map_reason(&body)) })
    }
}

#[tauri::command]
pub async fn auth_verify_code<R: Runtime>(
    app: AppHandle<R>,
    email: String,
    code: String,
) -> Result<AuthResult, String> {
    let client = Client::new();
    let resp = client
        .post(format!("{}/auth/verify-code", SERVER_BASE))
        .json(&VerifyCodeReq { email: &email, code: &code })
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        let v: VerifyCodeResp = resp.json().await.map_err(|e| e.to_string())?;
        auth::set_auth(&app, &AuthState {
            session_token: v.session_token,
            email: email.clone(),
            expires_at: v.expires_at,
        })?;
        Ok(AuthResult { ok: true, reason: None })
    } else {
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));
        Ok(AuthResult { ok: false, reason: Some(map_reason(&body)) })
    }
}

#[tauri::command]
pub async fn auth_me<R: Runtime>(app: AppHandle<R>) -> Result<StatusResult, String> {
    let Some(auth) = auth::get_auth(&app) else {
        return Ok(StatusResult { authenticated: false, email: None, has_active_license: None });
    };
    if !auth::is_valid(&auth) {
        let _ = auth::clear_auth(&app);
        return Ok(StatusResult { authenticated: false, email: None, has_active_license: None });
    }
    let client = Client::new();
    let resp = client
        .get(format!("{}/auth/me", SERVER_BASE))
        .header("Authorization", format!("Bearer {}", auth.session_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        let m: MeResp = resp.json().await.map_err(|e| e.to_string())?;
        Ok(StatusResult {
            authenticated: true,
            email: Some(m.email),
            has_active_license: Some(m.has_active_license),
        })
    } else {
        // Token rejected — drop it locally too
        let _ = auth::clear_auth(&app);
        Ok(StatusResult { authenticated: false, email: None, has_active_license: None })
    }
}

#[tauri::command]
pub async fn auth_logout<R: Runtime>(app: AppHandle<R>) -> Result<AuthResult, String> {
    if let Some(auth) = auth::get_auth(&app) {
        let client = Client::new();
        let _ = client
            .post(format!("{}/auth/logout", SERVER_BASE))
            .header("Authorization", format!("Bearer {}", auth.session_token))
            .send()
            .await; // fire-and-forget — clear local regardless
    }
    auth::clear_auth(&app)?;
    Ok(AuthResult { ok: true, reason: None })
}
```

- [ ] **Step 2: Register module** in `commands/mod.rs`

```rust
pub mod auth;
// ... other existing modules
```

- [ ] **Step 3: Register the commands** in `main.rs` or `lib.rs` (wherever `.invoke_handler` lives)

Find `tauri::generate_handler!`. Add the 4 commands:

```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    commands::auth::auth_send_code,
    commands::auth::auth_verify_code,
    commands::auth::auth_me,
    commands::auth::auth_logout,
])
```

- [ ] **Step 4: cargo check**

```bash
cd client/src-tauri
cargo check
```

- [ ] **Step 5: Commit**

```bash
git add client/src-tauri/src/commands/auth.rs client/src-tauri/src/commands/mod.rs client/src-tauri/src/main.rs client/src-tauri/src/lib.rs
git commit -m "feat(client/commands): auth_send_code/verify/me/logout"
```

---

## Task C3: `src/store/auth.ts` — Zustand store wrapping invoke

**Files:**
- Create: `client/src/store/auth.ts`
- Create: `client/src/store/auth.test.ts`

TDD.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from './auth';

const invokeMock = vi.fn();

beforeEach(() => {
  invokeMock.mockReset();
  // Reset the store
  useAuth.setState({ status: 'unknown', email: null, hasActiveLicense: false });
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe('useAuth', () => {
  it('refresh: sets authed when auth_me returns authenticated', async () => {
    invokeMock.mockResolvedValueOnce({
      authenticated: true,
      email: 'a@b.com',
      hasActiveLicense: true,
    });
    await useAuth.getState().refresh();
    expect(useAuth.getState().status).toBe('authed');
    expect(useAuth.getState().email).toBe('a@b.com');
    expect(useAuth.getState().hasActiveLicense).toBe(true);
  });

  it('refresh: sets unauthed when auth_me returns not authenticated', async () => {
    invokeMock.mockResolvedValueOnce({
      authenticated: false,
      email: null,
      hasActiveLicense: null,
    });
    await useAuth.getState().refresh();
    expect(useAuth.getState().status).toBe('unauthed');
  });

  it('sendCode: returns the ok flag from Rust', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true });
    const r = await useAuth.getState().sendCode('a@b.com');
    expect(r.ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('auth_send_code', { email: 'a@b.com' });
  });

  it('verifyCode: on ok refreshes status', async () => {
    invokeMock
      .mockResolvedValueOnce({ ok: true })       // verify-code
      .mockResolvedValueOnce({                   // refresh
        authenticated: true, email: 'a@b.com', hasActiveLicense: false,
      });
    const r = await useAuth.getState().verifyCode('a@b.com', '123456');
    expect(r.ok).toBe(true);
    expect(useAuth.getState().status).toBe('authed');
  });

  it('logout: invokes auth_logout and sets unauthed', async () => {
    useAuth.setState({ status: 'authed', email: 'a@b.com', hasActiveLicense: true });
    invokeMock.mockResolvedValueOnce({ ok: true });
    await useAuth.getState().logout();
    expect(useAuth.getState().status).toBe('unauthed');
    expect(useAuth.getState().email).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
pnpm --filter client test -- --run src/store/auth.test.ts
```

- [ ] **Step 3: Implement `src/store/auth.ts`**

```ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export type AuthStatus = 'unknown' | 'authed' | 'unauthed';

interface AuthStore {
  status: AuthStatus;
  email: string | null;
  hasActiveLicense: boolean;
  refresh: () => Promise<void>;
  sendCode: (email: string) => Promise<{ ok: boolean; reason?: string }>;
  verifyCode: (email: string, code: string) => Promise<{ ok: boolean; reason?: string }>;
  logout: () => Promise<void>;
}

interface AuthMeResult {
  authenticated: boolean;
  email: string | null;
  hasActiveLicense: boolean | null;
}

interface AuthResult {
  ok: boolean;
  reason?: string;
}

export const useAuth = create<AuthStore>((set, get) => ({
  status: 'unknown',
  email: null,
  hasActiveLicense: false,

  refresh: async () => {
    try {
      const r = await invoke<AuthMeResult>('auth_me');
      if (r.authenticated) {
        set({
          status: 'authed',
          email: r.email,
          hasActiveLicense: !!r.hasActiveLicense,
        });
      } else {
        set({ status: 'unauthed', email: null, hasActiveLicense: false });
      }
    } catch {
      set({ status: 'unauthed', email: null, hasActiveLicense: false });
    }
  },

  sendCode: async (email: string) => {
    return invoke<AuthResult>('auth_send_code', { email });
  },

  verifyCode: async (email: string, code: string) => {
    const r = await invoke<AuthResult>('auth_verify_code', { email, code });
    if (r.ok) await get().refresh();
    return r;
  },

  logout: async () => {
    try {
      await invoke('auth_logout');
    } finally {
      set({ status: 'unauthed', email: null, hasActiveLicense: false });
    }
  },
}));
```

- [ ] **Step 4: Run, verify PASS**

```bash
pnpm --filter client test -- --run src/store/auth.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add client/src/store/auth.ts client/src/store/auth.test.ts
git commit -m "feat(client/auth): Zustand store wrapping auth invoke commands"
```

---

## Task C4: `AuthCard.tsx` — login UI

**Files:**
- Create: `client/src/components/AuthCard.tsx`
- Create: `client/src/components/AuthCard.test.tsx`

TDD.

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthCard } from './AuthCard';
import { useAuth } from '../store/auth';

vi.mock('../store/auth', () => {
  const state = {
    sendCode: vi.fn(),
    verifyCode: vi.fn(),
  };
  return {
    useAuth: Object.assign(() => state, {
      getState: () => state,
      setState: () => {},
    }),
  };
});

beforeEach(() => {
  const s = useAuth.getState();
  (s.sendCode as ReturnType<typeof vi.fn>).mockReset();
  (s.verifyCode as ReturnType<typeof vi.fn>).mockReset();
});

describe('AuthCard', () => {
  it('renders email input on mount', () => {
    render(<AuthCard />);
    expect(screen.getByPlaceholderText(/邮箱/)).toBeDefined();
  });

  it('submits email and shows code field on success', async () => {
    const s = useAuth.getState();
    (s.sendCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    render(<AuthCard />);
    fireEvent.change(screen.getByPlaceholderText(/邮箱/), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: /发送验证码/ }));
    await waitFor(() => expect(screen.getByPlaceholderText(/验证码/)).toBeDefined());
  });

  it('shows wrong_code error', async () => {
    const s = useAuth.getState();
    (s.sendCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    (s.verifyCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, reason: 'wrong_code' });
    render(<AuthCard />);
    fireEvent.change(screen.getByPlaceholderText(/邮箱/), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: /发送验证码/ }));
    await waitFor(() => screen.getByPlaceholderText(/验证码/));
    fireEvent.change(screen.getByPlaceholderText(/验证码/), { target: { value: '999999' } });
    fireEvent.click(screen.getByRole('button', { name: /^验证$/ }));
    await waitFor(() => expect(screen.getByText(/验证码错误/)).toBeDefined());
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
pnpm --filter client test -- --run src/components/AuthCard.test.tsx
```

- [ ] **Step 3: Implement `AuthCard.tsx`**

```tsx
import { useState } from 'react';
import { useAuth } from '../store/auth';

type Stage = 'email' | 'code';

const ERROR_MESSAGES: Record<string, string> = {
  invalid_email: '邮箱格式不正确',
  wrong_code: '验证码错误',
  too_many_attempts: '尝试次数过多，请重新发送验证码',
  no_code: '验证码已过期，请重新发送',
};

export function AuthCard() {
  const { sendCode, verifyCode } = useAuth();
  const [stage, setStage] = useState<Stage>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submitEmail = async () => {
    if (!email.includes('@')) {
      setError('请输入有效邮箱');
      return;
    }
    setBusy(true);
    setError('');
    const r = await sendCode(email);
    setBusy(false);
    if (r.ok) {
      setStage('code');
    } else {
      setError(ERROR_MESSAGES[r.reason ?? ''] ?? '发送失败，请稍后再试');
    }
  };

  const submitCode = async () => {
    setBusy(true);
    setError('');
    const r = await verifyCode(email, code);
    setBusy(false);
    if (!r.ok) {
      setError(ERROR_MESSAGES[r.reason ?? ''] ?? '验证失败');
    }
    // On success, useAuth.refresh fires and App re-renders past the auth gate.
  };

  return (
    <div className="max-w-sm mx-auto p-6 space-y-4 bg-zinc-800 rounded-lg border border-zinc-700">
      <h2 className="text-base font-semibold">登录 whatSub</h2>
      <p className="text-xs text-zinc-400">使用邮箱接收验证码，无需密码</p>
      {stage === 'email' ? (
        <>
          <input
            type="email" placeholder="邮箱" value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitEmail()}
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm"
          />
          <button onClick={submitEmail} disabled={busy}
            className="w-full bg-blue-500 hover:bg-blue-400 text-black font-medium px-4 py-2 rounded text-sm disabled:opacity-50">
            {busy ? '发送中...' : '发送验证码'}
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-zinc-400">验证码已发送至 {email}</p>
          <input
            type="text" placeholder="6 位验证码" value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitCode()}
            maxLength={6}
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm tracking-widest text-center"
          />
          <button onClick={submitCode} disabled={busy || code.length !== 6}
            className="w-full bg-blue-500 hover:bg-blue-400 text-black font-medium px-4 py-2 rounded text-sm disabled:opacity-50">
            {busy ? '验证中...' : '验证'}
          </button>
          <button onClick={() => { setStage('email'); setCode(''); setError(''); }}
            className="w-full text-xs text-zinc-400 hover:text-zinc-200">
            换个邮箱
          </button>
        </>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run, verify PASS**

```bash
pnpm --filter client test -- --run src/components/AuthCard.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/AuthCard.tsx client/src/components/AuthCard.test.tsx
git commit -m "feat(client/auth): AuthCard component for email + 6-digit code login"
```

---

## Task C5: App.tsx — gate routes on auth, mount AuthCard

**Files:**
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Read current App.tsx**

```bash
cat client/src/App.tsx
```

- [ ] **Step 2: Wrap routes in an auth-gated shell**

Add an `AuthGate` component at the top of App.tsx (or inline):

```tsx
import { useEffect } from 'react';
import { useAuth } from './store/auth';
import { AuthCard } from './components/AuthCard';

function AuthGate({ children }: { children: React.ReactNode }) {
  const status = useAuth((s) => s.status);
  const refresh = useAuth((s) => s.refresh);
  useEffect(() => { void refresh(); }, [refresh]);
  if (status === 'unknown') return <div className="p-8 text-zinc-400">加载中…</div>;
  if (status === 'unauthed') {
    return (
      <div className="min-h-screen bg-zinc-900 flex items-center justify-center p-4">
        <AuthCard />
      </div>
    );
  }
  return <>{children}</>;
}
```

Wrap the `<BrowserRouter>...</BrowserRouter>` block:

```tsx
<AuthGate>
  <BrowserRouter>
    {/* existing routes */}
  </BrowserRouter>
</AuthGate>
```

- [ ] **Step 3: Run tests + typecheck**

```bash
pnpm --filter client typecheck
pnpm --filter client test -- --run
```

- [ ] **Step 4: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat(client): gate app routes on auth status, render AuthCard when unauth"
```

---

## Task C6: Delete `src-tauri/src/bridge/` directory

**Files:**
- Delete: `client/src-tauri/src/bridge/handoff.rs`, `mod.rs`, `port.rs`, `routes.rs`, `server.rs`
- Modify: `client/src-tauri/src/main.rs` (or `lib.rs`) — remove `BridgeState`, `start_bridge`, `bridge_set_enabled` references

- [ ] **Step 1: Grep references**

```bash
grep -rn "bridge::" client/src-tauri/src/ | head -20
grep -nE "BridgeState|start_bridge|bridge_set_enabled" client/src-tauri/src/main.rs client/src-tauri/src/lib.rs 2>&1 | head -20
```

- [ ] **Step 2: Delete the directory**

```bash
cd client
git rm -r src-tauri/src/bridge
```

- [ ] **Step 3: Remove references from main.rs / lib.rs**

For each line referencing `bridge::*`, `BridgeState`, `start_bridge`, `bridge_set_enabled`:
- If it's an import (`mod bridge` or `use bridge::*`), delete the line
- If it's `.manage(BridgeState { ... })`, delete the line
- If it's in `tauri::generate_handler![..., bridge_set_enabled, ...]`, remove the command name
- If a thread spawn calls `start_bridge`, delete the spawn block

- [ ] **Step 4: cargo check**

```bash
cd client/src-tauri
cargo check
```

Fix any remaining references one at a time.

- [ ] **Step 5: Commit**

```bash
git add client/src-tauri
git commit -m "refactor(client): delete bridge module (cloud corpus replaces peer-to-peer sync)"
```

---

## Task C7: Settings page — remove bridgeEnabled toggle

**Files:**
- Modify: `client/src/pages/Settings.tsx`

- [ ] **Step 1: Find the bridge toggle**

```bash
grep -nE "bridge|桥接|bridgeEnabled" client/src/pages/Settings.tsx | head -20
```

- [ ] **Step 2: Remove the entire bridge-related section**

Delete:
- The "浏览器插件桥接" or "桥接" section header + description
- The toggle component for `bridgeEnabled`
- Any `invoke("bridge_set_enabled", ...)` call
- Any state hook reading `bridgeEnabled` from settings

If there's a settings storage that tracks `bridgeEnabled` (e.g. in `commands/settings.rs` or a settings.json), leave the field in the store but stop reading/writing it from this page. (Cleanup of the storage field can be a future task.)

- [ ] **Step 3: Run tests + typecheck**

```bash
pnpm --filter client typecheck
pnpm --filter client test -- --run
```

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/Settings.tsx
git commit -m "refactor(client/settings): remove bridge toggle UI"
```

---

## Task C8: `commands/corpus.rs` — corpus_browse, corpus_mine, corpus_phrase_detail

**Files:**
- Create: `client/src-tauri/src/commands/corpus.rs`
- Modify: `client/src-tauri/src/commands/mod.rs`
- Modify: `client/src-tauri/src/main.rs` (or `lib.rs`)

- [ ] **Step 1: Implement `corpus.rs`**

```rust
//! Corpus Tauri commands — wrap server HTTP calls with the session token.

use crate::auth;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

const SERVER_BASE: &str = "https://whatsub.eversay.cc/api/license";

#[derive(Serialize, Deserialize, Debug)]
pub struct BrowseItem {
    #[serde(rename = "phraseNormalized")] pub phrase_normalized: String,
    #[serde(rename = "phraseRaw")] pub phrase_raw: String,
    #[serde(rename = "meaningZh")] pub meaning_zh: Option<String>,
    pub tags: serde_json::Value,
    #[serde(rename = "contributionCount")] pub contribution_count: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct BrowseResponse {
    pub items: Vec<BrowseItem>,
    pub total: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MineItem {
    #[serde(rename = "phraseNormalized")] pub phrase_normalized: String,
    #[serde(rename = "phraseRaw")] pub phrase_raw: String,
    #[serde(rename = "meaningZh")] pub meaning_zh: Option<String>,
    #[serde(rename = "contextSentence")] pub context_sentence: String,
    pub source: serde_json::Value,
    #[serde(rename = "contributedAt")] pub contributed_at: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MineResponse {
    pub items: Vec<MineItem>,
    pub total: i64,
    pub page: i64,
    #[serde(rename = "pageSize")] pub page_size: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ContributionDetail {
    pub id: i64,
    #[serde(rename = "contextSentence")] pub context_sentence: String,
    pub source: serde_json::Value,
    #[serde(rename = "contributedAt")] pub contributed_at: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PhraseDetail {
    pub phrase: BrowseItem,
    #[serde(rename = "publicContributions")] pub public_contributions: Vec<ContributionDetail>,
    #[serde(rename = "personalContributions")] pub personal_contributions: Vec<ContributionDetail>,
}

fn require_token<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let auth = auth::get_auth(app).ok_or_else(|| "auth_required".to_string())?;
    if !auth::is_valid(&auth) {
        return Err("auth_required".to_string());
    }
    Ok(auth.session_token)
}

#[tauri::command]
pub async fn corpus_browse<R: Runtime>(
    app: AppHandle<R>,
    scene: Option<String>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> Result<BrowseResponse, String> {
    let token = require_token(&app)?;
    let client = Client::new();
    let mut req = client
        .get(format!("{}/corpus/browse", SERVER_BASE))
        .header("Authorization", format!("Bearer {}", token));
    if let Some(s) = scene { req = req.query(&[("scene", s)]); }
    if let Some(p) = page { req = req.query(&[("page", p.to_string())]); }
    if let Some(ps) = page_size { req = req.query(&[("pageSize", ps.to_string())]); }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        if resp.status().as_u16() == 403 {
            return Err("license_required".to_string());
        }
        return Err(format!("http_{}", resp.status().as_u16()));
    }
    resp.json::<BrowseResponse>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn corpus_mine<R: Runtime>(
    app: AppHandle<R>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> Result<MineResponse, String> {
    let token = require_token(&app)?;
    let client = Client::new();
    let mut req = client
        .get(format!("{}/corpus/mine", SERVER_BASE))
        .header("Authorization", format!("Bearer {}", token));
    if let Some(p) = page { req = req.query(&[("page", p.to_string())]); }
    if let Some(ps) = page_size { req = req.query(&[("pageSize", ps.to_string())]); }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http_{}", resp.status().as_u16()));
    }
    resp.json::<MineResponse>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn corpus_phrase_detail<R: Runtime>(
    app: AppHandle<R>,
    phrase: String,
) -> Result<PhraseDetail, String> {
    let token = require_token(&app)?;
    let client = Client::new();
    let resp = client
        .get(format!("{}/corpus/lookup", SERVER_BASE))
        .query(&[("phrase", phrase), ("withScope", "true".to_string())])
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http_{}", resp.status().as_u16()));
    }
    resp.json::<PhraseDetail>().await.map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register module + commands** (in `commands/mod.rs` and `main.rs`)

In `commands/mod.rs`:
```rust
pub mod corpus;
```

In `main.rs` (or `lib.rs`) `tauri::generate_handler!`:
```rust
commands::corpus::corpus_browse,
commands::corpus::corpus_mine,
commands::corpus::corpus_phrase_detail,
```

- [ ] **Step 3: cargo check + cargo test**

```bash
cd client/src-tauri
cargo check
cargo test
```

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri
git commit -m "feat(client/commands): corpus_browse / corpus_mine / corpus_phrase_detail"
```

---

## Task C9: `YouTubeEmbed.tsx` — iframe wrapper

**Files:**
- Create: `client/src/components/YouTubeEmbed.tsx`
- Create: `client/src/components/YouTubeEmbed.test.tsx`

TDD.

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { YouTubeEmbed, parseYouTubeUrl } from './YouTubeEmbed';

describe('parseYouTubeUrl', () => {
  it('parses youtu.be/<id>?t=120', () => {
    expect(parseYouTubeUrl('https://youtu.be/Abc123?t=120')).toEqual({
      videoId: 'Abc123', startSec: 120,
    });
  });

  it('parses youtube.com/watch?v=<id>&t=30', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=Abc123&t=30')).toEqual({
      videoId: 'Abc123', startSec: 30,
    });
  });

  it('defaults startSec to 0 when no timestamp', () => {
    expect(parseYouTubeUrl('https://youtu.be/Abc123')?.startSec).toBe(0);
  });

  it('returns null on invalid URL', () => {
    expect(parseYouTubeUrl('not a url')).toBeNull();
  });
});

describe('YouTubeEmbed', () => {
  it('renders an iframe with the correct embed URL', () => {
    const { container } = render(<YouTubeEmbed videoId="Abc123" startSec={42} />);
    const iframe = container.querySelector('iframe');
    expect(iframe).toBeDefined();
    expect(iframe?.src).toContain('youtube.com/embed/Abc123');
    expect(iframe?.src).toContain('start=42');
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
pnpm --filter client test -- --run src/components/YouTubeEmbed.test.tsx
```

- [ ] **Step 3: Implement `YouTubeEmbed.tsx`**

```tsx
export interface ParsedYouTube {
  videoId: string;
  startSec: number;
}

export function parseYouTubeUrl(input: string): ParsedYouTube | null {
  try {
    const u = new URL(input);
    let videoId: string | null = null;
    if (u.hostname === 'youtu.be') {
      videoId = u.pathname.slice(1).split('/')[0] ?? null;
    } else if (u.hostname.endsWith('youtube.com')) {
      videoId = u.searchParams.get('v');
    }
    if (!videoId || !/^[A-Za-z0-9_-]{6,}$/.test(videoId)) return null;
    const t = u.searchParams.get('t') ?? u.searchParams.get('start');
    let startSec = 0;
    if (t) {
      const m = /^(\d+)s?$/.exec(t);
      if (m) startSec = parseInt(m[1]!, 10);
    }
    return { videoId, startSec };
  } catch {
    return null;
  }
}

interface Props {
  videoId: string;
  startSec?: number;
  className?: string;
}

export function YouTubeEmbed({ videoId, startSec = 0, className }: Props) {
  const src = `https://www.youtube.com/embed/${videoId}?start=${startSec}&autoplay=1&rel=0`;
  return (
    <iframe
      src={src}
      title={`YouTube ${videoId}`}
      allow="autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
      width="100%"
      height="360"
      className={className ?? 'rounded border border-zinc-700'}
    />
  );
}
```

- [ ] **Step 4: Run, verify PASS**

```bash
pnpm --filter client test -- --run src/components/YouTubeEmbed.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/YouTubeEmbed.tsx client/src/components/YouTubeEmbed.test.tsx
git commit -m "feat(client/corpus): YouTubeEmbed iframe wrapper + URL parser"
```

---

## Task C10: tauri.conf.json CSP — allow YouTube iframe

**Files:**
- Modify: `client/src-tauri/tauri.conf.json`

- [ ] **Step 1: Edit `tauri.conf.json`**

Find `security.csp` (currently `null`). Set it to allow Tauri's own protocol + YouTube embeds:

```json
"security": {
  "csp": "default-src 'self' tauri: http://ipc.localhost; img-src 'self' data: https://*.ytimg.com; media-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self' http://ipc.localhost ipc: tauri: https://whatsub.eversay.cc"
}
```

CSP is restrictive — adapt directives if dev server (`localhost:1420`) is used. The plan's intent: explicitly allow `frame-src` for YouTube, allow `connect-src` for the auth server.

If existing app behavior breaks (e.g. blocked dev resources), iterate the CSP until the app runs cleanly. Record the final form in the commit.

- [ ] **Step 2: Test by running dev server briefly**

```bash
cd client
pnpm tauri dev
```

Watch console for CSP violations. If any appear, broaden the CSP and re-test. Kill the dev server after smoke (`Ctrl+C`).

- [ ] **Step 3: Commit**

```bash
git add client/src-tauri/tauri.conf.json
git commit -m "chore(client/tauri): CSP allows YouTube iframe + auth server connect"
```

---

## Task C11: `CorpusSceneTree.tsx` — left column

**Files:**
- Create: `client/src/components/CorpusSceneTree.tsx`

This is a small presentational component. The 18 scenes are hard-coded.

- [ ] **Step 1: Implement**

```tsx
const SCENES: Array<{ key: string; label: string }> = [
  { key: 'immigration', label: '入境通关' },
  { key: 'housing', label: '住房安家' },
  { key: 'medical', label: '医疗健康' },
  { key: 'campus', label: '校园学习' },
  { key: 'banking', label: '银行财务' },
  { key: 'shopping', label: '日常购物' },
  { key: 'transport', label: '交通出行' },
  { key: 'social', label: '社交日常' },
  { key: 'dining', label: '餐饮' },
  { key: 'emergency', label: '紧急情况' },
  { key: 'job', label: '求职职场' },
  { key: 'phone', label: '电话沟通' },
  { key: 'salon', label: '美容美发' },
  { key: 'driving', label: '驾照开车' },
  { key: 'travel', label: '旅游度假' },
  { key: 'fitness', label: '运动健身' },
  { key: 'mental_health', label: '心理健康' },
  { key: 'maintenance', label: '搬家维修' },
];

interface Props {
  selected: string | null;
  onSelect: (scene: string | null) => void;
}

export function CorpusSceneTree({ selected, onSelect }: Props) {
  return (
    <nav className="w-48 border-r border-zinc-800 overflow-y-auto">
      <button
        onClick={() => onSelect(null)}
        className={`w-full text-left px-3 py-2 text-sm hover:bg-zinc-800
          ${selected === null ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'}`}
      >
        ⭐ 我的
      </button>
      <div className="border-t border-zinc-800 my-2" />
      <div className="text-xs text-zinc-500 px-3 py-1 uppercase">公共</div>
      {SCENES.map((s) => (
        <button
          key={s.key}
          onClick={() => onSelect(s.key)}
          className={`w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-800
            ${selected === s.key ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'}`}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm --filter client typecheck
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/CorpusSceneTree.tsx
git commit -m "feat(client/corpus): CorpusSceneTree left-rail navigation"
```

---

## Task C12: `CorpusPhraseList.tsx` — middle column

**Files:**
- Create: `client/src/components/CorpusPhraseList.tsx`

Loads phrases via `corpus_browse` (public scene mode) or `corpus_mine` ("我的" mode).

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface PublicItem {
  phraseNormalized: string;
  phraseRaw: string;
  meaningZh: string | null;
  tags: { scene?: string };
}

interface MineItem {
  phraseNormalized: string;
  phraseRaw: string;
  meaningZh: string | null;
}

interface Props {
  /** scene key for public list, or null for "我的" personal corpus */
  scene: string | null;
  selected: string | null;
  onSelect: (phraseNormalized: string) => void;
}

export function CorpusPhraseList({ scene, selected, onSelect }: Props) {
  const [items, setItems] = useState<Array<PublicItem | MineItem>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        if (scene === null) {
          const r = await invoke<{ items: MineItem[] }>('corpus_mine', { pageSize: 100 });
          if (!cancelled) setItems(r.items);
        } else {
          const r = await invoke<{ items: PublicItem[] }>('corpus_browse', { scene, pageSize: 100 });
          if (!cancelled) setItems(r.items);
        }
      } catch (e) {
        const msg = String(e);
        if (!cancelled) setError(msg === 'license_required' ? '需购买后可见' : '加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scene]);

  if (loading) return <div className="p-4 text-zinc-500 text-sm">加载中…</div>;
  if (error) return <div className="p-4 text-red-400 text-sm">{error}</div>;
  if (items.length === 0) return <div className="p-4 text-zinc-500 text-sm">暂无</div>;

  return (
    <ul className="flex-1 border-r border-zinc-800 overflow-y-auto min-w-0">
      {items.map((item) => (
        <li
          key={item.phraseNormalized}
          onClick={() => onSelect(item.phraseNormalized)}
          className={`px-3 py-2 cursor-pointer hover:bg-zinc-800
            ${selected === item.phraseNormalized ? 'bg-zinc-800' : ''}`}
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

- [ ] **Step 2: typecheck**

- [ ] **Step 3: Commit**

```bash
git add client/src/components/CorpusPhraseList.tsx
git commit -m "feat(client/corpus): CorpusPhraseList — browse + mine paginated list"
```

---

## Task C13: `CorpusPhraseDetail.tsx` — right column with YouTubeEmbed

**Files:**
- Create: `client/src/components/CorpusPhraseDetail.tsx`

Loads `corpus_phrase_detail`, shows meaning + instances, embeds YouTube iframe of currently-selected instance.

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { YouTubeEmbed, parseYouTubeUrl } from './YouTubeEmbed';

interface Contribution {
  id: number;
  contextSentence: string;
  source: { kind: string; url: string; title?: string; timestampSec?: number };
  contributedAt: number;
}

interface PhraseDetail {
  phrase: {
    phraseNormalized: string;
    phraseRaw: string;
    meaningZh: string | null;
    tags: Record<string, unknown>;
  };
  publicContributions: Contribution[];
  personalContributions: Contribution[];
}

interface Props {
  phraseNormalized: string | null;
}

export function CorpusPhraseDetail({ phraseNormalized }: Props) {
  const [detail, setDetail] = useState<PhraseDetail | null>(null);
  const [selectedInstance, setSelectedInstance] = useState<Contribution | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!phraseNormalized) { setDetail(null); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const r = await invoke<PhraseDetail>('corpus_phrase_detail', { phrase: phraseNormalized });
        if (cancelled) return;
        setDetail(r);
        const first = r.publicContributions[0] ?? r.personalContributions[0] ?? null;
        setSelectedInstance(first);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [phraseNormalized]);

  if (!phraseNormalized) {
    return <div className="flex-1 p-6 text-zinc-500">选择一个短语查看实例</div>;
  }
  if (loading || !detail) return <div className="flex-1 p-6 text-zinc-500">加载中…</div>;

  const parsed = selectedInstance ? parseYouTubeUrl(selectedInstance.source.url) : null;

  return (
    <div className="flex-1 p-4 overflow-y-auto space-y-4">
      <div>
        <h2 className="text-xl font-semibold">{detail.phrase.phraseRaw}</h2>
        {detail.phrase.meaningZh && (
          <p className="text-zinc-400 mt-1">{detail.phrase.meaningZh}</p>
        )}
      </div>
      {parsed && (
        <YouTubeEmbed videoId={parsed.videoId} startSec={parsed.startSec} />
      )}
      <section>
        <h3 className="text-sm text-zinc-400 mb-2">📚 公共实例</h3>
        <ul className="space-y-1">
          {detail.publicContributions.map((c) => (
            <li
              key={c.id}
              onClick={() => setSelectedInstance(c)}
              className={`px-3 py-2 rounded text-sm cursor-pointer hover:bg-zinc-800
                ${selectedInstance?.id === c.id ? 'bg-zinc-800' : 'bg-zinc-900'}`}
            >
              <div className="text-xs text-zinc-500">{c.source.title}</div>
              <div>{c.contextSentence}</div>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="text-sm text-zinc-400 mb-2">⭐ 你的实例</h3>
        <ul className="space-y-1">
          {detail.personalContributions.map((c) => (
            <li
              key={c.id}
              onClick={() => setSelectedInstance(c)}
              className={`px-3 py-2 rounded text-sm cursor-pointer hover:bg-zinc-800
                ${selectedInstance?.id === c.id ? 'bg-zinc-800' : 'bg-zinc-900'}`}
            >
              <div className="text-xs text-zinc-500">{c.source.title}</div>
              <div>{c.contextSentence}</div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

- [ ] **Step 3: Commit**

```bash
git add client/src/components/CorpusPhraseDetail.tsx
git commit -m "feat(client/corpus): CorpusPhraseDetail right column with YouTube embed"
```

---

## Task C14: `pages/Corpus.tsx` — three-column layout

**Files:**
- Create: `client/src/pages/Corpus.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useState } from 'react';
import { CorpusSceneTree } from '../components/CorpusSceneTree';
import { CorpusPhraseList } from '../components/CorpusPhraseList';
import { CorpusPhraseDetail } from '../components/CorpusPhraseDetail';

export function Corpus() {
  const [scene, setScene] = useState<string | null>('social');
  const [phrase, setPhrase] = useState<string | null>(null);

  return (
    <div className="flex h-[calc(100vh-3rem)]">
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
  );
}
```

The `h-[calc(100vh-3rem)]` assumes a 3rem-tall top nav. Adapt to whatever the existing Layout uses.

- [ ] **Step 2: typecheck + tests**

```bash
pnpm --filter client typecheck
pnpm --filter client test -- --run
```

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/Corpus.tsx
git commit -m "feat(client/corpus): Corpus page three-column layout"
```

---

## Task C15: App.tsx — add `/corpus` route + redirect `/vocab` → `/corpus`

**Files:**
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Add route + redirect**

Find the existing `<Routes>` block. Add:

```tsx
<Route path="/corpus" element={<Corpus />} />
```

For the `/vocab` route, replace with a redirect:

```tsx
<Route path="/vocab" element={<Navigate to="/corpus" replace />} />
```

(Or keep `/vocab` working for now if user wants both — the spec leaves this open. Recommend redirect since the corpus tab is the new canonical "my saves" surface, even though in-player saves still write locally per scope.)

Add the import:
```tsx
import { Corpus } from './pages/Corpus';
```

- [ ] **Step 2: Add nav link** in `client/src/components/Layout.tsx` (or wherever the top nav lives)

```bash
grep -nE "Layout|nav.*Link|/library|/settings" client/src/components/Layout.tsx 2>&1 | head
```

Add a `<NavLink to="/corpus">公共语料库</NavLink>` (or matching style) alongside `/library`, `/vocab`, `/settings`.

- [ ] **Step 3: Run tests + typecheck**

```bash
pnpm --filter client typecheck
pnpm --filter client test -- --run
```

- [ ] **Step 4: Commit**

```bash
git add client/src/App.tsx client/src/components/Layout.tsx
git commit -m "feat(client): /corpus route + nav entry + /vocab redirect"
```

---

## Task C16: Logout button in Settings page

**Files:**
- Modify: `client/src/pages/Settings.tsx`

Add an Auth section showing the logged-in email + a logout button calling `useAuth.getState().logout()`.

- [ ] **Step 1: Add the section near the top of Settings**

```tsx
import { useAuth } from '../store/auth';

// inside the component:
const { email, hasActiveLicense, logout } = useAuth();

return (
  <div>
    <section className="mb-6 p-4 bg-zinc-800 border border-zinc-700 rounded">
      <h3 className="text-sm font-semibold mb-1">账户</h3>
      <div className="text-xs text-zinc-400">已登录: {email ?? '—'}</div>
      <div className="text-xs text-zinc-400 mt-1">
        {hasActiveLicense ? '✓ 已购买' : '未购买（购买后可见公共语料库）'}
      </div>
      <button
        onClick={() => { void logout(); }}
        className="mt-3 px-3 py-1 text-xs border border-zinc-600 rounded hover:bg-zinc-700"
      >
        退出登录
      </button>
    </section>
    {/* ... rest of existing settings ... */}
  </div>
);
```

- [ ] **Step 2: typecheck + tests**

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/Settings.tsx
git commit -m "feat(client/settings): account section with logout"
```

---

## Task C17: Local Rust verification

- [ ] **Step 1: cargo clippy (warnings)**

```bash
cd client/src-tauri
cargo clippy --no-deps 2>&1 | tail -30
```

Address any new clippy warnings introduced by C1/C2/C8 (defer pre-existing warnings).

- [ ] **Step 2: cargo test**

```bash
cargo test
```

All passing.

- [ ] **Step 3: Commit any clippy fixes**

```bash
git add client/src-tauri
git status  # confirm no untracked drift
git commit -m "chore(client): clippy fixes for auth + corpus commands" --allow-empty
```

(Allow empty if there were no fixes.)

---

## Task C18: Local frontend verification

- [ ] **Step 1: typecheck**

```bash
cd client
pnpm typecheck
```

- [ ] **Step 2: Full test suite**

```bash
pnpm test -- --run
```

All passing.

- [ ] **Step 3: Vite build (frontend bundle, no Tauri)**

```bash
pnpm build
```

Watch for errors. CSS / asset paths should resolve. If CSP-related runtime errors surface in dev console, iterate the CSP and re-test.

- [ ] **Step 4: Commit if anything needed adjustment**

(Usually no commit; build is idempotent.)

---

## Task C19: Local Tauri dev smoke

- [ ] **Step 1: Start dev**

```bash
cd client
pnpm tauri dev
```

This opens the desktop window. Watch the embedded devtools (right-click → 检查) for CSP violations / runtime errors.

- [ ] **Step 2: Manual smoke checklist** (mark each pass)

- [ ] App opens to the `AuthCard` (since no token yet)
- [ ] Email input → "发送验证码" → no error → code input shown
- [ ] Receive code in inbox (Plan A's SMTP)
- [ ] Enter code → "验证" → app transitions past the AuthCard to the routes
- [ ] Top nav has "公共语料库" link
- [ ] Click 公共语料库 → 3-column layout renders
- [ ] Left rail shows 18 scenes + 我的
- [ ] Click a scene → middle column loads (if license: phrases; if no license: error or empty)
- [ ] Click 我的 → middle column shows your personal saves (initially empty)
- [ ] Click a phrase (if present) → right column renders detail + YouTube iframe + 公共/你的 sections
- [ ] YouTube iframe loads + autoplays at the correct timestamp
- [ ] Settings → 账户 section → "退出登录" → app reverts to AuthCard
- [ ] /vocab in URL → redirects to /corpus

- [ ] **Step 3: Kill the dev server**

`Ctrl+C` in the terminal.

- [ ] **Step 4: NO commit** — this task is verification only.

---

## Task C20: Final review + leftover dead code sweep

- [ ] **Step 1: Grep for orphan references**

```bash
cd client
grep -rn "bridge\|BridgeState\|HandoffButton" src/ src-tauri/src/ 2>&1 | head
```

Anything remaining: either delete (if truly orphan) or leave with a `TODO: remove in Plan D` comment.

- [ ] **Step 2: Check git status is clean**

```bash
git status
```

- [ ] **Step 3: Review the commit list**

```bash
git log --oneline origin/main..HEAD
```

Expected: 15-20 commits from C1 through C16.

- [ ] **Step 4: NO PUSH.** User explicitly said local-only. Wait for user's go-ahead before pushing.

```bash
echo "Plan C complete locally. Awaiting user push approval."
```

---

## Self-Review

**Spec coverage:**
- §6 New tab "📚 语料库" — C11/C12/C13/C14 (scene tree + phrase list + detail + embed)
- §6 onboarding (email + 6-digit code) — C1/C2/C3/C4/C5
- §6 delete bridge — C6
- §6 delete /vocab — C15 (redirect, not full delete; in-player flows retained per scope note)
- §6 tauri.conf.json CSP — C10
- §6 Rust commands corpus_browse/mine/phrase_detail — C8
- §6 contributor_id derivation — server-side now (no client work needed for browse/mine reads; the contribute path is in-player save, deferred)
- §6 logout button — C16

**Placeholders:** none — every step has actual code or commands.

**Type consistency:**
- `AuthState` Rust ↔ `AuthMeResult` TS: shapes match (email, hasActiveLicense)
- `BrowseItem` ↔ `PublicItem` (TS) — Rust uses snake_case via `#[serde(rename)]`, TS sees camelCase. Confirmed match.
- `PhraseDetail.publicContributions` vs `personalContributions` — naming consistent C8 ↔ C13

**Scope assumptions documented:**
- In-player save flows (`useVocabulary` writes) stay LOCAL. Plan C does NOT rewire them to cloud — that's deferred to a future plan.
- `/vocab` route redirects to `/corpus` but the underlying `useVocabulary` Zustand store and components (`StarButton`, `SubtitleSelectionBubble`, `VocabHighlight`) are untouched.
- No push, no bundle, no release.

**Known follow-ups (not blockers):**
- Plan D candidate: rewire in-player save UIs (`StarButton`, etc.) to call cloud `corpus_contribute` Rust command (analogous to plugin's B10). After that, `useVocabulary` can be retired.
- `hasActiveLicense` is fetched via `auth_me` at AuthGate mount + every `useAuth.refresh()` call. No proactive polling; user logs out / refreshes to pick up newly-purchased license.
- DeleteMineButton equivalent in desktop not yet built. If users want to wipe cloud personal corpus from desktop, that's a Plan D follow-up.

Ready for execution.
