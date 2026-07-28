# Subscription Pricing Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the current ¥38 monthly and ¥348 yearly prices everywhere from one desktop-side source of truth.

**Architecture:** Add a dependency-free pricing configuration module and make `LicenseGate` plus all `SyncButton` upsells consume its formatted exports. Add component coverage and a runtime-source guard so stale prices cannot silently return.

**Tech Stack:** TypeScript 5.8, React 19, Vitest 4, Testing Library.

## Global Constraints

- Monthly price is exactly `38` CNY and yearly price is exactly `348` CNY.
- Runtime source must not contain `¥12/月`, `¥22`, or `¥168` literals.
- Do not add a startup network request or change checkout/license behavior.
- Historical design documents are not runtime configuration and are not rewritten by this plan.
- Do not trigger release or CI.
- Run `pnpm install --frozen-lockfile` before frontend tests in this worktree.

---

### Task 1: Create the shared pricing contract

**Files:**
- Create: `client/src/config/subscriptionPricing.ts`
- Create: `client/src/config/subscriptionPricing.test.ts`

**Interfaces:**
- Produces: `SUBSCRIPTION_PRICING`, `MONTHLY_PRICE_TEXT`, `YEARLY_PRICE_TEXT`.

- [ ] **Step 1: Write the failing module contract test**

```ts
import { describe, expect, it } from "vitest";
import {
  MONTHLY_PRICE_TEXT,
  SUBSCRIPTION_PRICING,
  YEARLY_PRICE_TEXT,
} from "./subscriptionPricing";

describe("subscription pricing", () => {
  it("exposes the current CNY prices", () => {
    expect(SUBSCRIPTION_PRICING).toEqual({
      currency: "CNY",
      monthly: 38,
      yearly: 348,
    });
    expect(MONTHLY_PRICE_TEXT).toBe("¥38");
    expect(YEARLY_PRICE_TEXT).toBe("¥348");
  });
});
```

- [ ] **Step 2: Run and verify RED**

```powershell
pnpm exec vitest run src/config/subscriptionPricing.test.ts
```

Expected: FAIL because `subscriptionPricing.ts` does not exist.

- [ ] **Step 3: Add the minimal configuration module**

```ts
export const SUBSCRIPTION_PRICING = {
  currency: "CNY",
  monthly: 38,
  yearly: 348,
} as const;

export const MONTHLY_PRICE_TEXT = `¥${SUBSCRIPTION_PRICING.monthly}`;
export const YEARLY_PRICE_TEXT = `¥${SUBSCRIPTION_PRICING.yearly}`;
```

- [ ] **Step 4: Run and verify GREEN**

```powershell
pnpm exec vitest run src/config/subscriptionPricing.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the shared source**

```powershell
git add client/src/config/subscriptionPricing.ts client/src/config/subscriptionPricing.test.ts
git diff --cached --check
git commit -m "feat(pricing): add shared subscription prices"
```

### Task 2: Migrate the email login card

**Files:**
- Create: `client/src/components/LicenseGate.test.tsx`
- Modify: `client/src/components/LicenseGate.tsx:639`
- Modify: `client/src/store/license.ts:127`
- Modify: `client/src/types/license.ts:37`

**Interfaces:**
- Consumes: `MONTHLY_PRICE_TEXT`, `YEARLY_PRICE_TEXT`.
- Produces: no new component API.

- [ ] **Step 1: Add a failing LicenseGate rendering test**

Mock `useLicense()` in `LicenseGate.test.tsx` with `mode: "NEEDS_KEY"`, no error/trial, and `vi.fn()` actions. Render the gate, expand 邮箱登录, then assert:

```ts
fireEvent.click(screen.getByRole("button", { name: /邮箱登录/ }));
const copy = screen.getByText(/订阅了 whatSub Pro/);
expect(copy).toHaveTextContent("月度 ¥38 / 年度 ¥348");
expect(copy).not.toHaveTextContent("¥22");
expect(copy).not.toHaveTextContent("¥168");
```

- [ ] **Step 2: Run and verify RED**

```powershell
pnpm exec vitest run src/components/LicenseGate.test.tsx
```

Expected: FAIL because the component still renders `¥22 / ¥168`.

- [ ] **Step 3: Replace the literal with shared formatted exports**

```tsx
import {
  MONTHLY_PRICE_TEXT,
  YEARLY_PRICE_TEXT,
} from "../config/subscriptionPricing";

// ...
订阅了 whatSub Pro（月度 {MONTHLY_PRICE_TEXT} / 年度 {YEARLY_PRICE_TEXT}）？
```

Change stale comments in `store/license.ts` and `types/license.ts` to price-neutral “网站 Pro 月订阅” wording.

- [ ] **Step 4: Run focused tests and typecheck**

```powershell
pnpm exec vitest run src/config/subscriptionPricing.test.ts src/components/LicenseGate.test.tsx
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the login-card migration**

```powershell
git add client/src/components/LicenseGate.tsx client/src/components/LicenseGate.test.tsx client/src/store/license.ts client/src/types/license.ts
git diff --cached --check
git commit -m "fix(license): show current subscription prices"
```

### Task 3: Migrate every cloud-sync upsell

**Files:**
- Create: `client/src/components/LibraryCard/SyncButton.test.tsx`
- Modify: `client/src/components/LibraryCard/SyncButton.tsx:75-104`

**Interfaces:**
- Consumes: `MONTHLY_PRICE_TEXT`.
- Produces: unchanged `SyncButtonProps`.

- [ ] **Step 1: Add parameterized failing tests for all three branches**

Mock `syncToCloud()` to reject one code at a time and render a ready entry whose `syncError` makes the retry button call `doSync()` directly:

```ts
it.each([
  ["quota_exceeded", "云端视频已达上限", "可解锁到 50 个"],
  ["video_too_large", "视频文件超过上限", "可同步 500MB"],
  ["video_too_long", "视频时长超过上限", "可同步 60 分钟"],
])("shows ¥38/month for %s", async (code, title, capability) => {
  syncToCloudMock.mockRejectedValueOnce(new Error(code));
  render(<SyncButton entry={entry} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "上次同步失败" }));

  expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
  const message = screen.getByText(new RegExp(capability));
  expect(message).toHaveTextContent("¥38/月");
  expect(message).not.toHaveTextContent("¥12/月");
});
```

- [ ] **Step 2: Run and verify RED**

```powershell
pnpm exec vitest run src/components/LibraryCard/SyncButton.test.tsx
```

Expected: all three cases fail on the old `¥12/月` copy.

- [ ] **Step 3: Use the shared monthly text in every branch**

```tsx
import { MONTHLY_PRICE_TEXT } from "../../config/subscriptionPricing";

const proMonthly = `${MONTHLY_PRICE_TEXT}/月`;
```

Use `${proMonthly}` in the quota, size, and duration dialog messages. Replace the `¥12/月 product` comment with price-neutral wording.

- [ ] **Step 4: Run and verify GREEN**

```powershell
pnpm exec vitest run src/components/LibraryCard/SyncButton.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the sync migration**

```powershell
git add client/src/components/LibraryCard/SyncButton.tsx client/src/components/LibraryCard/SyncButton.test.tsx
git diff --cached --check
git commit -m "fix(sync): use shared Pro pricing"
```

### Task 4: Add a stale-price guard and run the full gate

**Files:**
- Modify: `client/src/config/subscriptionPricing.test.ts`

**Interfaces:**
- Consumes: runtime `client/src/**/*.ts(x)` files.
- Produces: repository guard against legacy price literals.

- [ ] **Step 1: Add the runtime-source guard**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function runtimeSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return runtimeSourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

it("contains no legacy subscription-price literals in runtime source", () => {
  const root = join(process.cwd(), "src");
  const legacy = ["¥12/月", "¥22", "¥168"];
  const offenders = runtimeSourceFiles(root).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return legacy.filter((value) => text.includes(value)).map((value) => ({
      file: relative(process.cwd(), file),
      value,
    }));
  });
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: Run targeted and full verification**

```powershell
pnpm exec vitest run src/config/subscriptionPricing.test.ts src/components/LicenseGate.test.tsx src/components/LibraryCard/SyncButton.test.tsx
pnpm test
pnpm typecheck
pnpm build
rg -n '¥12/月|¥22|¥168' src -g '!*.test.ts' -g '!*.test.tsx'
```

Expected: all commands pass; `rg` prints no matches.

- [ ] **Step 3: Commit the guard**

```powershell
git add client/src/config/subscriptionPricing.test.ts
git diff --cached --check
git commit -m "test(pricing): reject legacy subscription copy"
```
