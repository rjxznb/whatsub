# Cookie Login Explanation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain YouTube authentication failures before opening a browser, then retry the original import exactly once after a successful explicit login.

**Architecture:** Keep Rust cookie harvesting, CDP browser startup, `friendlyError()`, and `SiteLoginAction` unchanged. Change only the React orchestration so foreground and queue flows display the existing diagnosis first and launch login only from an explicit button.

**Tech Stack:** React 19, TypeScript 5.8, Tauri 2 events/invoke, Vitest 4, Testing Library.

## Global Constraints

- Never call `site_login_start` merely because an error was received.
- Cookie/login/bot-check failures remain deterministic and are not network-retried.
- Successful login retries the original URL import at most once per explicit login attempt.
- Cancelling login preserves the URL, import settings, and diagnostic reason.
- Do not change Rust login commands, cookie storage, release configuration, or CI.
- Install the worktree dependencies with `pnpm install --frozen-lockfile` before the first frontend test because this worktree currently has no `node_modules`.

---

### Task 1: Make foreground authentication user-driven

**Files:**
- Modify: `client/src/components/ImportModal.tsx:220-305`
- Modify: `client/src/components/ImportModal.test.tsx:163-236`

**Interfaces:**
- Consumes: `friendlyError(error, phase, sourceUrl): FriendlyError` and existing `SiteLoginAction`.
- Produces: no new exported interface; `beginSiteLogin()` remains the only foreground caller of `site_login_start`.

- [ ] **Step 1: Replace the automatic-login regression test with a diagnosis-first test**

In `ImportModal.test.tsx`, replace `opens the YouTube login flow immediately for a bot-check error` with:

```ts
it("shows the YouTube auth diagnosis without starting login", async () => {
  const r = await startImport();
  pipelineHandler?.({
    payload: {
      stage: "Failed",
      video_id: "auth-video",
      error: "ERROR: [youtube] Sign in to confirm you’re not a bot. Use --cookies.",
    },
  });

  await waitFor(() =>
    expect(r.getByText("YouTube 要求登录验证")).toBeInTheDocument(),
  );
  expect(r.getByText(/触发了反机器人检测/)).toBeInTheDocument();
  expect(r.getByRole("button", { name: "重新登录 YouTube" })).toBeInTheDocument();
  expect(
    invokeMock.mock.calls.filter(([cmd]) => cmd === "site_login_start"),
  ).toHaveLength(0);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `client`:

```powershell
pnpm exec vitest run src/components/ImportModal.test.tsx -t "shows the YouTube auth diagnosis"
```

Expected: FAIL because the current error effect hides the diagnosis and starts login immediately.

- [ ] **Step 3: Remove automatic browser launch from the error effect**

Delete `autoLoginAttemptedRef`, its URL-reset effect, and this entire branch:

```ts
if (tab === "url" && fe.loginRequired && fe.action) {
  // automatic beginSiteLogin branch
}
```

Reduce the effect to logging and showing the existing dialog:

```ts
useEffect(() => {
  if (!error) {
    lastShownErrorRef.current = null;
    return;
  }
  if (error === lastShownErrorRef.current) return;
  lastShownErrorRef.current = error;
  console.error("[whatsub import error]", error);
  setShowErrorDialog(true);
}, [error]);
```

Do not change the existing `重新登录 ${act.siteLabel}` button; it already calls `beginSiteLogin(act)`.

- [ ] **Step 4: Run the focused test and verify GREEN**

```powershell
pnpm exec vitest run src/components/ImportModal.test.tsx -t "shows the YouTube auth diagnosis"
```

Expected: PASS.

- [ ] **Step 5: Add an explicit-click test**

```ts
it("starts YouTube login only after the diagnosis action is clicked", async () => {
  const r = await startImport();
  pipelineHandler?.({
    payload: {
      stage: "Failed",
      video_id: "auth-video",
      error: "The provided account cookies are no longer valid. Please refresh your cookies.",
    },
  });

  fireEvent.click(await r.findByRole("button", { name: "重新登录 YouTube" }));

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("site_login_start", {
      args: {
        key: "youtube",
        label: "YouTube",
        loginUrl: "https://www.youtube.com/",
        harvestDomains: ["youtube.com", "google.com", "googleusercontent.com"],
      },
    }),
  );
  expect(r.getByText("等待 YouTube 登录完成")).toBeInTheDocument();
});
```

- [ ] **Step 6: Verify the explicit-click test passes**

```powershell
pnpm exec vitest run src/components/ImportModal.test.tsx -t "starts YouTube login only"
```

Expected: PASS using the existing `beginSiteLogin()` implementation.

- [ ] **Step 7: Commit the diagnosis-first behavior**

```powershell
git add client/src/components/ImportModal.tsx client/src/components/ImportModal.test.tsx
git diff --cached --check
git commit -m "fix(import): explain auth failures before login"
```

### Task 2: Guarantee one retry and restore diagnosis after cancellation

**Files:**
- Modify: `client/src/components/ImportModal.tsx:282-340`
- Modify: `client/src/components/ImportModal.test.tsx:190-236`

**Interfaces:**
- Consumes: existing `site-login-success`, `site-login-cancelled`, `site_login_cancel`.
- Produces: internal `retryAfterLoginRef: MutableRefObject<boolean>`; no public API change.

- [ ] **Step 1: Add failing tests for exactly-once retry and cancellation**

Strengthen the existing success test so it explicitly clicks login, emits success twice, and checks exactly two import calls:

```ts
it("retries the original import only once after login succeeds", async () => {
  const r = await startImport();
  pipelineHandler?.({
    payload: {
      stage: "Failed",
      video_id: "auth-video",
      error: "The provided account cookies are no longer valid. Please refresh your cookies.",
    },
  });
  fireEvent.click(await r.findByRole("button", { name: "重新登录 YouTube" }));
  await waitFor(() => expect(r.getByText("等待 YouTube 登录完成")).toBeInTheDocument());

  eventHandlers.get("site-login-success")?.({ payload: {} });
  eventHandlers.get("site-login-success")?.({ payload: {} });

  await waitFor(() => {
    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === "import_video");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1]).toEqual(calls[0]?.[1]);
  });
});
```

Add cancellation coverage:

```ts
it("returns to the diagnosis without retrying when login is cancelled", async () => {
  const r = await startImport();
  pipelineHandler?.({
    payload: {
      stage: "Failed",
      video_id: "auth-video",
      error: "ERROR: Sign in to confirm you're not a bot. Use --cookies.",
    },
  });
  fireEvent.click(await r.findByRole("button", { name: "重新登录 YouTube" }));
  fireEvent.click(await r.findByRole("button", { name: "取消" }));

  await waitFor(() => expect(r.getByText("YouTube 要求登录验证")).toBeInTheDocument());
  expect(invokeMock).toHaveBeenCalledWith("site_login_cancel");
  expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "import_video")).toHaveLength(1);
  expect(urlInput().value).toBe(SAMPLE_URL);
});
```

- [ ] **Step 2: Run and verify RED**

```powershell
pnpm exec vitest run src/components/ImportModal.test.tsx -t "after login succeeds|when login is cancelled"
```

Expected: at least the duplicate-success or cancellation-restoration assertion fails.

- [ ] **Step 3: Add the one-shot retry authorization**

Add near the login state:

```ts
const retryAfterLoginRef = useRef(false);
```

Set it only after `site_login_start` succeeds:

```ts
await invoke("site_login_start", {
  args: {
    key: action.siteKey,
    label: action.siteLabel,
    loginUrl: action.loginUrl,
    harvestDomains: action.harvestDomains,
  },
});
retryAfterLoginRef.current = true;
setShowErrorDialog(false);
setPendingLogin({ key: action.siteKey, label: action.siteLabel });
```

Guard the success listener before clearing state:

```ts
if (!retryAfterLoginRef.current) return;
retryAfterLoginRef.current = false;
setPendingLogin(null);
setSavingLogin(false);
setLoginError(null);
setError(null);
void submitRef.current();
```

Use one restoration helper from both cancellation paths:

```ts
function restoreDiagnosisAfterLoginCancel() {
  retryAfterLoginRef.current = false;
  setPendingLogin(null);
  setSavingLogin(false);
  setLoginError(null);
  setShowErrorDialog(true);
}
```

Do not clear `error`, `urlValue`, `quality`, or settings when cancelling.

- [ ] **Step 4: Run the full ImportModal regression group**

```powershell
pnpm exec vitest run src/components/ImportModal.test.tsx src/components/ImportModal.cookieprecheck.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the login lifecycle guard**

```powershell
git add client/src/components/ImportModal.tsx client/src/components/ImportModal.test.tsx
git diff --cached --check
git commit -m "fix(import): retry once after explicit site login"
```

### Task 3: Gate queue login actions on authentication errors

**Files:**
- Modify: `client/src/components/DownloadQueueWidget.tsx:29-80`
- Modify: `client/src/components/DownloadQueueWidget.test.tsx`

**Interfaces:**
- Consumes: `FriendlyError.loginRequired` and `FriendlyError.action`.
- Produces: `requiredLoginAction: SiteLoginAction | undefined` local value.

- [ ] **Step 1: Add a failing non-authentication YouTube test**

```ts
it.each([
  ["ERROR: Unable to download webpage: connection timed out", "无法访问视频网站"],
  ["ERROR: This video is private", "视频不可用"],
  ["ERROR: Requested format is not available", "无法解析视频格式"],
])("does not offer login for %s", (error, title) => {
  render(
    <FailedActions
      error={error}
      sourceValue="https://www.youtube.com/watch?v=x"
      onRetry={vi.fn()}
    />,
  );
  expect(screen.getByText(title)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /登录/ })).toBeNull();
  expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and verify RED**

```powershell
pnpm exec vitest run src/components/DownloadQueueWidget.test.tsx
```

Expected: FAIL because known-site secondary actions currently expose login even when `loginRequired` is false.

- [ ] **Step 3: Restrict the button and modal to required authentication**

```ts
const requiredLoginAction = fe.loginRequired ? fe.action : undefined;
```

Use `requiredLoginAction` for the button and modal:

```tsx
{requiredLoginAction && (
  <button onClick={() => setLoginOpen(true)}>
    重新登录 {requiredLoginAction.siteLabel}
  </button>
)}
{loginOpen && requiredLoginAction && (
  <SiteLoginModal
    open
    action={requiredLoginAction}
    onClose={() => setLoginOpen(false)}
    onSuccess={onRetry}
  />
)}
```

- [ ] **Step 4: Run focused and full frontend verification**

```powershell
pnpm exec vitest run src/components/DownloadQueueWidget.test.tsx src/components/SiteLoginModal.test.tsx src/hooks/useSiteLogin.test.ts src/utils/friendlyError.test.ts
pnpm test
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit queue behavior**

```powershell
git add client/src/components/DownloadQueueWidget.tsx client/src/components/DownloadQueueWidget.test.tsx
git diff --cached --check
git commit -m "fix(downloads): gate login actions on auth failures"
```
