# Import Login Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a 「立即登录」 button on every failed import that maps to a login-class error (foreground, AI-agent, iOS-queue), and proactively warn before an import when the in-app cookies for the target site are expired.

**Architecture:** One shared login flow (`useSiteLogin` hook + `SiteLoginModal`) extracted from `ImportChecklistDialog`. Feature A hooks the single app-wide download-queue failure sink (`store/downloadQueue.ts`) by running each failed item through the existing `friendlyError()` and rendering the login button in `DownloadQueueWidget`. Feature B adds a read-only Rust `cookies_status` command (replacing dead `youtube_cookies_info`) called before import in `ImportModal` and the agent `import_video` tool.

**Tech Stack:** Rust (Tauri 2 commands, serde), React 19 + TS, zustand, Vitest, `@tauri-apps/api`.

## Global Constraints

- TS path-safety / LLM args: unchanged here (no new id→path routing).
- New Rust command is **read-only** (no writes, no subprocess).
- `cookies_status` reasoning must be a **pure function** (`compute_site_status`) unit-tested without filesystem — `paths::app_data_dir()` has no test injection.
- Expiry rule (verbatim from spec): `expiresAt = max(expires for cookies where expires > 0)`; `expired = expiresAt < now`; `expiringSoon = expiresAt < now + 7*24*3600`; session-only / missing bucket → both false.
- Pre-check only acts when `settings.cookieSource === "in-app"` AND the bucket exists.
- Login button is **button-initiated** (never auto-launch a browser).
- Cookie jar shape: `CookieJar { sites: BTreeMap<String, SiteBucket> }`, `SiteBucket { label, login_at, cookies: Vec<JarCookie> }`, `JarCookie { expires: Option<i64> /* epoch seconds */, .. }`.
- `SiteLoginAction` shape (from `friendlyError.ts`): `{ kind: "login-site", siteKey, siteLabel, loginUrl, harvestDomains }`.
- `site_login_start` arg shape: `{ args: { key, label, loginUrl, harvestDomains, browser? } }`.

---

### Task 1: Rust `cookies_status` command + pure status logic

**Files:**
- Modify: `client/src-tauri/src/commands/youtube_auth.rs` (delete dead `youtube_cookies_info` + `CookiesInfo` at ~1210-1225; add new code near top-level command area)
- Modify: `client/src-tauri/src/lib.rs:25` (register command in `generate_handler!`)
- Test: inline `#[cfg(test)]` in `youtube_auth.rs`

**Interfaces:**
- Produces (Rust): `pub fn compute_site_status(jar: &crate::core::cookie_jar::CookieJar, site_key: &str, now: i64) -> CookieSiteStatus`
- Produces (command): `#[tauri::command] pub fn cookies_status(site_key: String) -> Result<CookieSiteStatus, String>`
- Produces (TS-visible JSON, camelCase): `CookieSiteStatus { siteKey: string; label: string; exists: bool; expired: bool; expiringSoon: bool; expiresAt: number | null }`

- [ ] **Step 1: Delete the dead code.** Remove this block from `youtube_auth.rs` (~lines 1210-1225):

```rust
#[allow(dead_code)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookiesInfo {
    pub path: String,
    pub exists: bool,
}

#[tauri::command]
pub fn youtube_cookies_info() -> Result<CookiesInfo, String> {
    let path = paths::cookies_txt_path()?;
    Ok(CookiesInfo {
        path: path.to_string_lossy().into_owned(),
        exists: path.exists(),
    })
}
```

- [ ] **Step 2: Write the failing test.** Add to the existing `#[cfg(test)] mod tests` in `youtube_auth.rs` (add `use super::*;` if not present):

```rust
#[cfg(test)]
mod cookies_status_tests {
    use super::compute_site_status;
    use crate::core::cookie_jar::{CookieJar, JarCookie, SiteBucket};
    use std::collections::BTreeMap;

    fn jar_with(site: &str, expiries: &[Option<i64>]) -> CookieJar {
        let cookies = expiries
            .iter()
            .map(|e| JarCookie {
                domain: ".example.com".into(),
                path: "/".into(),
                secure: true,
                expires: *e,
                name: "SID".into(),
                value: "x".into(),
            })
            .collect();
        let mut sites = BTreeMap::new();
        sites.insert(
            site.to_string(),
            SiteBucket { label: "YouTube".into(), login_at: 0, cookies },
        );
        CookieJar { version: 1, sites }
    }

    #[test]
    fn missing_bucket_is_not_expired() {
        let s = compute_site_status(&CookieJar::default(), "youtube", 1000);
        assert!(!s.exists);
        assert!(!s.expired);
        assert!(!s.expiring_soon);
        assert_eq!(s.expires_at, None);
    }

    #[test]
    fn expired_when_max_expiry_in_past() {
        let jar = jar_with("youtube", &[Some(500), Some(800)]);
        let s = compute_site_status(&jar, "youtube", 1000);
        assert!(s.exists);
        assert!(s.expired);
        assert!(s.expiring_soon);
        assert_eq!(s.expires_at, Some(800));
    }

    #[test]
    fn expiring_soon_within_7_days() {
        let now = 1_000_000;
        let jar = jar_with("youtube", &[Some(now + 3 * 24 * 3600)]);
        let s = compute_site_status(&jar, "youtube", now);
        assert!(!s.expired);
        assert!(s.expiring_soon);
    }

    #[test]
    fn fresh_when_max_expiry_far_future() {
        let now = 1_000_000;
        let jar = jar_with("youtube", &[Some(now + 60 * 24 * 3600)]);
        let s = compute_site_status(&jar, "youtube", now);
        assert!(!s.expired);
        assert!(!s.expiring_soon);
        assert_eq!(s.expires_at, Some(now + 60 * 24 * 3600));
    }

    #[test]
    fn session_only_bucket_is_not_expired() {
        let jar = jar_with("youtube", &[None, Some(0), Some(-1)]);
        let s = compute_site_status(&jar, "youtube", 1000);
        assert!(s.exists);
        assert!(!s.expired);
        assert!(!s.expiring_soon);
        assert_eq!(s.expires_at, None);
    }
}
```

- [ ] **Step 3: Run test to verify it fails.**

Run: `cd client/src-tauri && cargo test cookies_status_tests`
Expected: FAIL — `cannot find function compute_site_status` / `cannot find type CookieSiteStatus`.

- [ ] **Step 4: Write minimal implementation.** Add near the top-level commands in `youtube_auth.rs` (where the deleted code was). Ensure `use serde::Serialize;` is in scope (it already is — `CookiesInfo` used it):

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieSiteStatus {
    pub site_key: String,
    pub label: String,
    pub exists: bool,
    pub expired: bool,
    pub expiring_soon: bool,
    /// Unix epoch seconds of the longest-lived cookie; None when the bucket is
    /// missing or holds only session cookies (expires <= 0).
    pub expires_at: Option<i64>,
}

/// Pure expiry classification for one site bucket. `now` is unix epoch seconds.
pub fn compute_site_status(
    jar: &crate::core::cookie_jar::CookieJar,
    site_key: &str,
    now: i64,
) -> CookieSiteStatus {
    let bucket = jar.sites.get(site_key);
    let expires_at = bucket.and_then(|b| {
        b.cookies
            .iter()
            .filter_map(|c| c.expires)
            .filter(|e| *e > 0)
            .max()
    });
    let expired = matches!(expires_at, Some(e) if e < now);
    let expiring_soon = matches!(expires_at, Some(e) if e < now + 7 * 24 * 3600);
    CookieSiteStatus {
        site_key: site_key.to_string(),
        label: bucket.map(|b| b.label.clone()).unwrap_or_default(),
        exists: bucket.is_some(),
        expired,
        expiring_soon,
        expires_at,
    }
}

#[tauri::command]
pub fn cookies_status(site_key: String) -> Result<CookieSiteStatus, String> {
    let jar = crate::core::cookie_jar::load();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Ok(compute_site_status(&jar, &site_key, now))
}
```

- [ ] **Step 5: Register the command.** In `client/src-tauri/src/lib.rs`, inside `generate_handler![ ... ]`, replace any `commands::youtube_auth::youtube_cookies_info,` line if present, else add:

```rust
            commands::youtube_auth::cookies_status,
```

(Grep first: `grep -n youtube_cookies_info client/src-tauri/src/lib.rs` — if it appears, replace that exact line; if not, add the new line next to `commands::youtube_auth::site_presets,`.)

- [ ] **Step 6: Run tests + build.**

Run: `cd client/src-tauri && cargo test cookies_status_tests && cargo build`
Expected: PASS (5 tests) and a clean build (the `youtube_cookies_info is never used` warning is gone).

- [ ] **Step 7: Commit.**

```bash
git add client/src-tauri/src/commands/youtube_auth.rs client/src-tauri/src/lib.rs
git commit -m "feat(cookies): cookies_status command for per-site expiry pre-check"
```

---

### Task 2: Export `siteKeyForUrl` from friendlyError

**Files:**
- Modify: `client/src/utils/friendlyError.ts` (add exported helper near `detectKnownSite`, ~line 159)
- Test: `client/src/utils/friendlyError.test.ts`

**Interfaces:**
- Consumes: existing internal `detectKnownSite(url)` → `{ siteKey, tier } | undefined`
- Produces: `export function siteKeyForUrl(url: string): string | undefined`

- [ ] **Step 1: Write the failing test.** Append to `friendlyError.test.ts`:

```ts
import { siteKeyForUrl } from "./friendlyError";

describe("siteKeyForUrl", () => {
  it("maps known hosts to site keys", () => {
    expect(siteKeyForUrl("https://www.youtube.com/watch?v=abc")).toBe("youtube");
    expect(siteKeyForUrl("https://m.bilibili.com/video/BV1")).toBe("bilibili");
    expect(siteKeyForUrl("https://www.instagram.com/p/x/")).toBe("instagram");
  });
  it("returns undefined for unknown hosts and junk", () => {
    expect(siteKeyForUrl("https://example.com/x")).toBeUndefined();
    expect(siteKeyForUrl("not a url")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd client && pnpm vitest run src/utils/friendlyError.test.ts`
Expected: FAIL — `siteKeyForUrl is not a function`.

- [ ] **Step 3: Write minimal implementation.** In `friendlyError.ts`, immediately after the `detectKnownSite` function, add:

```ts
/** Public site-key resolver for a source URL (reuses detectKnownSite's host
 *  mapping). Used by the pre-import cookie-expiry check. */
export function siteKeyForUrl(url: string): string | undefined {
  return detectKnownSite(url)?.siteKey;
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `cd client && pnpm vitest run src/utils/friendlyError.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add client/src/utils/friendlyError.ts client/src/utils/friendlyError.test.ts
git commit -m "feat(friendlyError): export siteKeyForUrl helper"
```

---

### Task 3: `useSiteLogin` hook

**Files:**
- Create: `client/src/hooks/useSiteLogin.ts`
- Test: `client/src/hooks/useSiteLogin.test.ts`

**Interfaces:**
- Consumes (Rust commands): `site_presets`, `site_login_browsers`, `site_login_pending`, `site_login_start`, `site_login_finish`, `site_login_cancel`; events `site-login-success` / `site-login-cancelled`.
- Produces:

```ts
export interface LoginArgs { key: string; label: string; loginUrl: string; harvestDomains: string[] }
export interface UseSiteLogin {
  presets: SitePreset[];
  browsers: string[];
  selectedBrowser: string;
  setSelectedBrowser: (b: string) => void;
  pendingLogin: { key: string; label: string } | null;
  starting: boolean;
  savingLogin: boolean;
  loginError: string | null;
  startLogin: (args: LoginArgs) => Promise<void>;
  finishLogin: () => Promise<void>;
  cancelLogin: () => Promise<void>;
}
export function useSiteLogin(opts?: { onSuccess?: () => void; onCancelled?: () => void }): UseSiteLogin;
export type SitePreset = LoginArgs; // shape returned by site_presets
```

- [ ] **Step 1: Write the failing test.** Create `useSiteLogin.test.ts`:

```ts
import { renderHook, act, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

const invoke = vi.fn();
const listeners: Record<string, (e: { payload: unknown }) => void> = {};
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners[name] = cb;
    return Promise.resolve(() => delete listeners[name]);
  },
}));

import { useSiteLogin } from "./useSiteLogin";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "site_presets") return Promise.resolve([]);
    if (cmd === "site_login_browsers") return Promise.resolve(["chrome"]);
    if (cmd === "site_login_pending") return Promise.resolve(null);
    return Promise.resolve(undefined);
  });
});

describe("useSiteLogin", () => {
  it("startLogin invokes site_login_start and sets pendingLogin", async () => {
    const { result } = renderHook(() => useSiteLogin());
    await act(async () => {
      await result.current.startLogin({
        key: "youtube", label: "YouTube",
        loginUrl: "https://youtube.com/", harvestDomains: ["youtube.com"],
      });
    });
    expect(invoke).toHaveBeenCalledWith("site_login_start", {
      args: { key: "youtube", label: "YouTube", loginUrl: "https://youtube.com/", harvestDomains: ["youtube.com"], browser: undefined },
    });
    expect(result.current.pendingLogin).toEqual({ key: "youtube", label: "YouTube" });
  });

  it("success event clears pending and calls onSuccess", async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useSiteLogin({ onSuccess }));
    await act(async () => {
      await result.current.startLogin({ key: "youtube", label: "YouTube", loginUrl: "u", harvestDomains: [] });
    });
    await act(async () => { listeners["site-login-success"]?.({ payload: null }); });
    await waitFor(() => expect(result.current.pendingLogin).toBeNull());
    expect(onSuccess).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd client && pnpm vitest run src/hooks/useSiteLogin.test.ts`
Expected: FAIL — cannot resolve `./useSiteLogin`.

- [ ] **Step 3: Write minimal implementation.** Create `useSiteLogin.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface LoginArgs {
  key: string;
  label: string;
  loginUrl: string;
  harvestDomains: string[];
}
export type SitePreset = LoginArgs;

export interface UseSiteLogin {
  presets: SitePreset[];
  browsers: string[];
  selectedBrowser: string;
  setSelectedBrowser: (b: string) => void;
  pendingLogin: { key: string; label: string } | null;
  starting: boolean;
  savingLogin: boolean;
  loginError: string | null;
  startLogin: (args: LoginArgs) => Promise<void>;
  finishLogin: () => Promise<void>;
  cancelLogin: () => Promise<void>;
}

export function useSiteLogin(opts?: {
  onSuccess?: () => void;
  onCancelled?: () => void;
}): UseSiteLogin {
  const [presets, setPresets] = useState<SitePreset[]>([]);
  const [browsers, setBrowsers] = useState<string[]>([]);
  const [selectedBrowser, setSelectedBrowser] = useState("");
  const [pendingLogin, setPendingLogin] = useState<{ key: string; label: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [savingLogin, setSavingLogin] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const onSuccessRef = useRef(opts?.onSuccess);
  const onCancelledRef = useRef(opts?.onCancelled);
  useEffect(() => { onSuccessRef.current = opts?.onSuccess; }, [opts?.onSuccess]);
  useEffect(() => { onCancelledRef.current = opts?.onCancelled; }, [opts?.onCancelled]);

  useEffect(() => {
    void Promise.all([
      invoke<SitePreset[]>("site_presets").then(setPresets).catch(() => setPresets([])),
      invoke<string[]>("site_login_browsers").then(setBrowsers).catch(() => {}),
      invoke<{ siteKey: string; label: string } | null>("site_login_pending")
        .then((p) => { if (p) setPendingLogin({ key: p.siteKey, label: p.label }); })
        .catch(() => {}),
    ]);
  }, []);

  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    void Promise.all([
      listen("site-login-success", () => {
        setPendingLogin(null);
        setSavingLogin(false);
        setLoginError(null);
        onSuccessRef.current?.();
      }).then((u) => unlistens.push(u)),
      listen("site-login-cancelled", () => {
        setPendingLogin(null);
        setSavingLogin(false);
        onCancelledRef.current?.();
      }).then((u) => unlistens.push(u)),
    ]);
    return () => unlistens.forEach((u) => u());
  }, []);

  async function startLogin(args: LoginArgs) {
    setLoginError(null);
    setStarting(true);
    try {
      await invoke("site_login_start", {
        args: { ...args, browser: selectedBrowser || undefined },
      });
      setPendingLogin({ key: args.key, label: args.label });
    } catch (e) {
      setLoginError(`登录窗口启动失败：${String(e)}`);
    } finally {
      setStarting(false);
    }
  }

  async function finishLogin() {
    setLoginError(null);
    setSavingLogin(true);
    try {
      await invoke("site_login_finish");
      // success event clears state
    } catch (e) {
      setSavingLogin(false);
      setLoginError(`保存登录失败：${String(e)}`);
    }
  }

  async function cancelLogin() {
    try {
      await invoke("site_login_cancel");
    } catch {
      /* ignore */
    }
    setPendingLogin(null);
    setSavingLogin(false);
  }

  return {
    presets, browsers, selectedBrowser, setSelectedBrowser,
    pendingLogin, starting, savingLogin, loginError,
    startLogin, finishLogin, cancelLogin,
  };
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `cd client && pnpm vitest run src/hooks/useSiteLogin.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit.**

```bash
git add client/src/hooks/useSiteLogin.ts client/src/hooks/useSiteLogin.test.ts
git commit -m "feat(hooks): useSiteLogin shared login-flow hook"
```

---

### Task 4: `SiteLoginModal` component

**Files:**
- Create: `client/src/components/SiteLoginModal.tsx`
- Test: `client/src/components/SiteLoginModal.test.tsx`

**Interfaces:**
- Consumes: `useSiteLogin` (Task 3), `SiteLoginAction` type (from `friendlyError.ts`).
- Produces:

```ts
export interface SiteLoginModalProps {
  open: boolean;
  /** Preselect this site from an error's action; when set, skips the picker
   *  and starts login directly on confirm. */
  action?: import("../utils/friendlyError").SiteLoginAction;
  onClose: () => void;
  onSuccess?: () => void;
}
export function SiteLoginModal(props: SiteLoginModalProps): JSX.Element | null;
```

- [ ] **Step 1: Write the failing test.** Create `SiteLoginModal.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

const startLogin = vi.fn();
vi.mock("../hooks/useSiteLogin", () => ({
  useSiteLogin: () => ({
    presets: [], browsers: [], selectedBrowser: "", setSelectedBrowser: vi.fn(),
    pendingLogin: null, starting: false, savingLogin: false, loginError: null,
    startLogin, finishLogin: vi.fn(), cancelLogin: vi.fn(),
  }),
}));

import { SiteLoginModal } from "./SiteLoginModal";

beforeEach(() => startLogin.mockReset());

describe("SiteLoginModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<SiteLoginModal open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("starts login for the action's site on confirm", () => {
    render(
      <SiteLoginModal
        open
        action={{ kind: "login-site", siteKey: "youtube", siteLabel: "YouTube", loginUrl: "https://youtube.com/", harvestDomains: ["youtube.com"] }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /登录 YouTube/ }));
    expect(startLogin).toHaveBeenCalledWith({
      key: "youtube", label: "YouTube", loginUrl: "https://youtube.com/", harvestDomains: ["youtube.com"],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd client && pnpm vitest run src/components/SiteLoginModal.test.tsx`
Expected: FAIL — cannot resolve `./SiteLoginModal`.

- [ ] **Step 3: Write minimal implementation.** Create `SiteLoginModal.tsx` (portaled themed modal; mirrors the existing dialog's panels — picker omitted when `action` is given since the site is known):

```tsx
import { createPortal } from "react-dom";
import { useSiteLogin } from "../hooks/useSiteLogin";
import type { SiteLoginAction } from "../utils/friendlyError";

export interface SiteLoginModalProps {
  open: boolean;
  action?: SiteLoginAction;
  onClose: () => void;
  onSuccess?: () => void;
}

export function SiteLoginModal({ open, action, onClose, onSuccess }: SiteLoginModalProps) {
  const login = useSiteLogin({
    onSuccess: () => { onSuccess?.(); onClose(); },
    onCancelled: () => {},
  });

  if (!open) return null;
  const label = action?.siteLabel ?? "网站";

  const onConfirm = () => {
    if (!action) return;
    void login.startLogin({
      key: action.siteKey,
      label: action.siteLabel,
      loginUrl: action.loginUrl,
      harvestDomains: action.harvestDomains,
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      data-agent-popover
      onClick={onClose}
    >
      <div
        className="w-[420px] rounded-xl bg-zinc-900 border border-zinc-700 p-5 text-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        {!login.pendingLogin ? (
          <>
            <div className="text-base font-semibold mb-2">登录 {label}</div>
            <p className="text-sm text-zinc-400 mb-4">
              将打开一个浏览器窗口，请在里面登录你的 {label} 账号；登录后点「我已登录完成」，
              whatsub 会自动抓取 cookie。
            </p>
            {login.loginError && (
              <div className="text-sm text-rose-400 mb-3">{login.loginError}</div>
            )}
            <div className="flex justify-end gap-2">
              <button className="px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200" onClick={onClose}>
                取消
              </button>
              <button
                className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
                onClick={onConfirm}
                disabled={login.starting || !action}
              >
                {login.starting ? "启动中…" : `登录 ${label}`}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-base font-semibold mb-2">等待登录完成</div>
            <p className="text-sm text-zinc-400 mb-4">
              在弹出的浏览器里完成 {login.pendingLogin.label} 登录后，点下面的按钮保存 cookie。
            </p>
            {login.loginError && (
              <div className="text-sm text-rose-400 mb-3">{login.loginError}</div>
            )}
            <div className="flex justify-end gap-2">
              <button className="px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200" onClick={() => void login.cancelLogin()}>
                取消
              </button>
              <button
                className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
                onClick={() => void login.finishLogin()}
                disabled={login.savingLogin}
              >
                {login.savingLogin ? "保存中…" : "我已登录完成"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `cd client && pnpm vitest run src/components/SiteLoginModal.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit.**

```bash
git add client/src/components/SiteLoginModal.tsx client/src/components/SiteLoginModal.test.tsx
git commit -m "feat(components): SiteLoginModal reusable login modal"
```

---

### Task 5: Refactor `ImportChecklistDialog` onto `useSiteLogin`

**Files:**
- Modify: `client/src/components/ImportChecklistDialog.tsx` (replace inlined login state + `startLogin`/`finishLogin` + the two event `useEffect`s at ~104-234 with the hook)

**Interfaces:**
- Consumes: `useSiteLogin` (Task 3).
- Produces: no new exports. Behavior preserved (manual import → checklist → login → auto-dismiss on success).

> This is a behavior-preserving refactor. The dialog keeps its site picker
> (`selectedKey` / `customUrl` / `pickerOpen`) and its `onClickLogin` URL-parsing
> branch; only the login *flow* state moves to the hook.

- [ ] **Step 1: Replace the login-flow state with the hook.** Remove the local `useState`s for `presets`, `browsers`, `selectedBrowser`, `pendingLogin`, `starting`, `savingLogin`, `loginError`, the `site_presets`/`site_login_browsers`/`site_login_pending` load `useEffect`, the `site-login-success`/`site-login-cancelled` listener `useEffect`, and the `startLogin`/`finishLogin` functions. Add at the top of the component body:

```tsx
const {
  presets, browsers, selectedBrowser, setSelectedBrowser,
  pendingLogin, starting, savingLogin, loginError,
  startLogin, finishLogin, cancelLogin,
} = useSiteLogin({
  onSuccess: () => onDismissRef.current(skipForeverRef.current),
});
```

Keep the `skipForeverRef` / `onDismissRef` refs (the hook's `onSuccess` closes over them). Keep `selectedKey`, `customUrl`, `pickerOpen`, and the existing `onClickLogin` (it already calls `startLogin(...)`). Add the import:

```tsx
import { useSiteLogin } from "../hooks/useSiteLogin";
```

- [ ] **Step 2: Wire the cancel button.** If the dialog had an inline cancel handler that set `pendingLogin`, point it at the hook's `cancelLogin`. (Grep `cancelLogin` usage in the file; replace any local definition with the hook's.)

- [ ] **Step 3: Typecheck + existing tests.**

Run: `cd client && pnpm typecheck && pnpm vitest run src/components/ImportChecklistDialog`
Expected: typecheck clean; any existing ImportChecklistDialog test passes (if none exists, typecheck is the gate).

- [ ] **Step 4: Smoke-build note (no command).** Mark for the human verifier: in a real `pnpm tauri build`, open Library → +Import → confirm the login flow still spawns the browser and saves cookies. (CSP/eval pitfalls don't apply; the browser-spawn path can't be vitest-covered.)

- [ ] **Step 5: Commit.**

```bash
git add client/src/components/ImportChecklistDialog.tsx
git commit -m "refactor(import): ImportChecklistDialog uses useSiteLogin hook"
```

---

### Task 6: Feature A — login button on failed download-queue items

**Files:**
- Modify: `client/src/components/DownloadQueueWidget.tsx` (error branch ~234-238; add modal state + button + retry)
- Test: `client/src/components/DownloadQueueWidget.test.tsx` (create)

**Interfaces:**
- Consumes: `friendlyError` + `SiteLoginAction` (`friendlyError.ts`), `SiteLoginModal` (Task 4), `import_video` Tauri command, `useDownloadQueue` (for retry re-import).
- Produces: none.

> A download item is `UnifiedItem` with `kind: "download"` carrying `sourceValue`
> + `error`. Retry re-imports `sourceValue` at `quality: "standard"` (quality is
> not on the pipeline event — documented simplification from the spec).

- [ ] **Step 1: Write the failing test.** Create `DownloadQueueWidget.test.tsx` targeting the row renderer. (If the row component isn't exported, export the small presentational `QueueRow`/`ItemRow` used at ~177; this test assumes an exported `FailedActions` helper — add it in Step 3.)

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { FailedActions } from "./DownloadQueueWidget";

describe("FailedActions", () => {
  it("shows a login button for a bot-error on a known site", () => {
    render(
      <FailedActions
        error="ERROR: Sign in to confirm you're not a bot"
        sourceValue="https://www.youtube.com/watch?v=x"
        onRetry={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /立即登录/ })).toBeInTheDocument();
  });

  it("shows no login button for a plain non-login failure", () => {
    render(
      <FailedActions
        error="ffmpeg: Invalid data found when processing input"
        sourceValue="C:/videos/local.mp4"
        onRetry={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /立即登录/ })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd client && pnpm vitest run src/components/DownloadQueueWidget.test.tsx`
Expected: FAIL — `FailedActions` is not exported.

- [ ] **Step 3: Implement `FailedActions` + wire it into the error branch.** In `DownloadQueueWidget.tsx`, add imports:

```tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { friendlyError } from "../utils/friendlyError";
import { SiteLoginModal } from "./SiteLoginModal";
```

Add the exported component:

```tsx
export function FailedActions({
  error,
  sourceValue,
  onRetry,
}: {
  error: string;
  sourceValue: string;
  onRetry: () => void;
}) {
  const [loginOpen, setLoginOpen] = useState(false);
  const fe = friendlyError(error, "downloading", sourceValue);
  return (
    <span className="ml-auto flex items-center gap-2">
      <span className="text-amber-400 truncate max-w-[160px]" title={error}>
        {fe.title}
      </span>
      {fe.action && (
        <button
          className="px-2 py-0.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-[10px]"
          onClick={() => setLoginOpen(true)}
        >
          立即登录{fe.action.siteLabel}
        </button>
      )}
      <button
        className="px-2 py-0.5 rounded bg-blue-700 hover:bg-blue-600 text-white text-[10px]"
        onClick={onRetry}
      >
        重试
      </button>
      {fe.action && (
        <SiteLoginModal
          open={loginOpen}
          action={fe.action}
          onClose={() => setLoginOpen(false)}
          onSuccess={onRetry}
        />
      )}
    </span>
  );
}
```

Replace the existing error branch (lines ~234-238) with a call gated to download items:

```tsx
        {item.phase === "error" && item.error && item.kind === "download" && (
          <FailedActions
            error={item.error}
            sourceValue={item.sourceValue}
            onRetry={() =>
              void invoke("import_video", {
                req: {
                  sourceKind: item.sourceKind,
                  sourceValue: item.sourceValue,
                  whisperModel: undefined,
                  quality: "standard",
                  background: true,
                },
              })
            }
          />
        )}
        {item.phase === "error" && item.error && item.kind !== "download" && (
          <span className="text-amber-400 truncate" title={item.error}>
            {shortError(item.error)}
          </span>
        )}
```

> Note: `import_video`'s Rust `ImportRequest` requires `whisperModel`. Read it
> from settings instead of `undefined`: add `import { useSettings } from "../store/settings";`
> and inside the row component use `useSettings.getState().settings.whisperModel`.
> Replace `whisperModel: undefined` with `whisperModel: useSettings.getState().settings.whisperModel`.

- [ ] **Step 4: Run test to verify it passes.**

Run: `cd client && pnpm vitest run src/components/DownloadQueueWidget.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck.**

Run: `cd client && pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit.**

```bash
git add client/src/components/DownloadQueueWidget.tsx client/src/components/DownloadQueueWidget.test.tsx
git commit -m "feat(import): login button + retry on failed background/agent imports"
```

---

### Task 7: Feature B — pre-import cookie-expiry note in ImportModal

**Files:**
- Modify: `client/src/components/ImportModal.tsx` (near `urlValue` state ~131 and the URL input ~999)
- Test: `client/src/components/ImportModal.cookieprecheck.test.tsx` (create — tests the extracted pure helper, not the whole modal)

**Interfaces:**
- Consumes: `cookies_status` command (Task 1), `siteKeyForUrl` (Task 2), `useSettings`, `SiteLoginModal` (Task 4).
- Produces: a small pure helper `export function shouldPromptLogin(cookieSource: string|undefined, status: { exists: boolean; expired: boolean } | null): boolean` (kept in `ImportModal.tsx` and unit-tested).

- [ ] **Step 1: Write the failing test.** Create `ImportModal.cookieprecheck.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { shouldPromptLogin } from "./ImportModal";

describe("shouldPromptLogin", () => {
  it("prompts only when in-app cookies exist and are expired", () => {
    expect(shouldPromptLogin("in-app", { exists: true, expired: true })).toBe(true);
  });
  it("does not prompt when not using in-app cookies", () => {
    expect(shouldPromptLogin("none", { exists: true, expired: true })).toBe(false);
  });
  it("does not prompt when no bucket exists (never logged in)", () => {
    expect(shouldPromptLogin("in-app", { exists: false, expired: false })).toBe(false);
  });
  it("does not prompt when cookies are still valid", () => {
    expect(shouldPromptLogin("in-app", { exists: true, expired: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd client && pnpm vitest run src/components/ImportModal.cookieprecheck.test.tsx`
Expected: FAIL — `shouldPromptLogin` not exported.

- [ ] **Step 3: Implement the helper + wire the effect.** In `ImportModal.tsx` add the exported pure helper near the top:

```tsx
export function shouldPromptLogin(
  cookieSource: string | undefined,
  status: { exists: boolean; expired: boolean } | null,
): boolean {
  return cookieSource === "in-app" && !!status && status.exists && status.expired;
}
```

Add imports:

```tsx
import { cookieStatusFor } from "../lib/cookieStatus"; // tiny wrapper, Step 3b
import { siteKeyForUrl } from "../utils/friendlyError";
import { useSettings } from "../store/settings";
import { SiteLoginModal } from "./SiteLoginModal";
import type { SiteLoginAction } from "../utils/friendlyError";
```

Add state + a debounced effect reacting to `urlValue` (place near the other `useState`s ~131):

```tsx
const [expiredPrompt, setExpiredPrompt] = useState<SiteLoginAction | null>(null);
const [loginOpen, setLoginOpen] = useState(false);
useEffect(() => {
  const siteKey = siteKeyForUrl(urlValue);
  if (!siteKey) { setExpiredPrompt(null); return; }
  const cookieSource = useSettings.getState().settings.cookieSource;
  if (cookieSource !== "in-app") { setExpiredPrompt(null); return; }
  let cancelled = false;
  const t = setTimeout(() => {
    void cookieStatusFor(siteKey).then((s) => {
      if (cancelled) return;
      setExpiredPrompt(
        shouldPromptLogin(cookieSource, s)
          ? { kind: "login-site", siteKey, siteLabel: s.label || siteKey, loginUrl: `https://${siteKey}.com/`, harvestDomains: [`${siteKey}.com`] }
          : null,
      );
    });
  }, 400);
  return () => { cancelled = true; clearTimeout(t); };
}, [urlValue]);
```

Render a **non-blocking** note below the URL input (right after the input at ~1002):

```tsx
{expiredPrompt && (
  <div className="mt-2 text-xs text-amber-400 flex items-center gap-2">
    <span>{expiredPrompt.siteLabel} 登录可能已过期，下载失败时可先重新登录。</span>
    <button className="underline hover:text-amber-300" onClick={() => setLoginOpen(true)}>
      重新登录
    </button>
  </div>
)}
{expiredPrompt && (
  <SiteLoginModal open={loginOpen} action={expiredPrompt} onClose={() => setLoginOpen(false)} />
)}
```

- [ ] **Step 3b: Add the tiny `cookieStatusFor` wrapper.** Create `client/src/lib/cookieStatus.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

export interface CookieSiteStatus {
  siteKey: string;
  label: string;
  exists: boolean;
  expired: boolean;
  expiringSoon: boolean;
  expiresAt: number | null;
}

export function cookieStatusFor(siteKey: string): Promise<CookieSiteStatus> {
  return invoke<CookieSiteStatus>("cookies_status", { siteKey });
}
```

> The action's `loginUrl`/`harvestDomains` use the `<siteKey>.com` convention,
> matching `LOGIN_PRESETS`. For `x`/`bilibili` whose presets differ, prefer
> reusing `loginAction(siteKey)` from friendlyError instead — import and call
> `loginAction(siteKey)` to build the action rather than hand-rolling the URL.
> (Replace the inline object above with `loginAction(siteKey)`.)

- [ ] **Step 4: Run test to verify it passes.**

Run: `cd client && pnpm vitest run src/components/ImportModal.cookieprecheck.test.tsx && pnpm typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit.**

```bash
git add client/src/components/ImportModal.tsx client/src/lib/cookieStatus.ts client/src/components/ImportModal.cookieprecheck.test.tsx
git commit -m "feat(import): non-blocking cookie-expiry login prompt in ImportModal"
```

---

### Task 8: Feature B — pre-import cookie note in agent `import_video` tool

**Files:**
- Modify: `client/src/agent/tools/import_video.ts`
- Test: `client/src/agent/tools/import_video.test.ts` (create or extend)

**Interfaces:**
- Consumes: `cookieStatusFor` (Task 7 Step 3b), `siteKeyForUrl` (Task 2), `useSettings`.
- Produces: `ImportVideoResult` gains optional `cookieWarning?: string`.

- [ ] **Step 1: Write the failing test.** Create/extend `import_video.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../../store/settings", () => ({
  useSettings: { getState: () => ({ settings: { whisperModel: "small", cookieSource: "in-app" } }) },
}));

import { importVideoTool } from "./import_video";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "cookies_status") return Promise.resolve({ siteKey: "youtube", label: "YouTube", exists: true, expired: true, expiringSoon: true, expiresAt: 1 });
    return Promise.resolve(undefined);
  });
});

describe("import_video cookie pre-check", () => {
  it("returns a cookieWarning when in-app youtube cookies are expired", async () => {
    const r = await importVideoTool.execute(
      { url: "https://www.youtube.com/watch?v=x" },
      {} as never,
    );
    expect(r.cookieWarning).toMatch(/登录可能已过期/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd client && pnpm vitest run src/agent/tools/import_video.test.ts`
Expected: FAIL — `cookieWarning` undefined.

- [ ] **Step 3: Implement the pre-check.** Edit `import_video.ts`:

Add imports + result field:

```ts
import { cookieStatusFor } from "../../lib/cookieStatus";
import { siteKeyForUrl } from "../../utils/friendlyError";
```

```ts
export interface ImportVideoResult {
  started: true;
  watchAt: "/library";
  sourceUrl: string;
  cookieWarning?: string;
}
```

Inside `execute`, before the `invoke("import_video", ...)`:

```ts
    let cookieWarning: string | undefined;
    const siteKey = siteKeyForUrl(url);
    if (siteKey && settings.cookieSource === "in-app") {
      try {
        const status = await cookieStatusFor(siteKey);
        if (status.exists && status.expired) {
          cookieWarning = `${status.label || siteKey} 登录可能已过期，若导入失败请在 Library 的导入框重新登录后重试。`;
        }
      } catch {
        /* non-fatal: pre-check is best-effort */
      }
    }
```

And include it in the return:

```ts
    return {
      started: true as const,
      watchAt: "/library" as const,
      sourceUrl: url,
      ...(cookieWarning ? { cookieWarning } : {}),
    };
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `cd client && pnpm vitest run src/agent/tools/import_video.test.ts && pnpm typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit.**

```bash
git add client/src/agent/tools/import_video.ts client/src/agent/tools/import_video.test.ts
git commit -m "feat(agent): import_video warns when in-app cookies are expired"
```

---

## Final verification

- [ ] `cd client && pnpm typecheck && pnpm test` — all green.
- [ ] `cd client/src-tauri && cargo test` — all green.
- [ ] Human smoke test in a real `pnpm tauri build`: (1) Library + Import with an expired-cookie site shows the amber note; (2) trigger a YouTube bot error via the agent and confirm the download-queue item shows 「立即登录」 → browser spawns → after login, 重试 re-imports; (3) manual import login still works (Task 5 regression).
