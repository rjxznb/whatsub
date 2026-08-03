# Import Submit Preflight Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the import form immediately acknowledge a valid submit while accurately naming the pending managed-quota and duplicate-video checks.

**Architecture:** Add one local preparation-state enum to `ImportModal`. Set it before each asynchronous preflight, clear it on every exit, and use it to disable both submit actions while rendering explicit Chinese status copy. Keep the existing `submitting` state reserved for a real Rust import so cancellation semantics remain unchanged.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library.

## Global Constraints

- Managed users see `正在确认本月 AI 解析额度…` before the quota preflight resolves.
- Non-managed users skip quota copy and see only `正在检查这个视频是否已在资料库中…`.
- Both submit actions are disabled during either preflight so repeated clicks are not silently accepted.
- Quota lookup failures remain fail-open and do not block import.
- Do not set `submitting` until `import_video` is about to start; preflight has no cancellable Rust task.

---

### Task 1: Import submit preparation feedback

**Files:**
- Modify: `src/components/ImportModal.test.tsx`
- Modify: `src/components/ImportModal.tsx`

**Interfaces:**
- Consumes: existing `preflightManagedQuota(settings)` and `invoke("import_preflight", ...)` calls.
- Produces: local `SubmitPreparation` state (`"quota" | "existing-video" | null`) and user-visible `role="status"` copy.

- [ ] **Step 1: Write failing tests**

Add deferred quota and import-preflight promises. Assert that a managed submit immediately disables both action buttons and displays `正在确认本月 AI 解析额度…`; after resolving quota, assert the copy changes to `正在检查这个视频是否已在资料库中…`. Add a non-managed test asserting it starts directly at the duplicate-video copy and never calls the quota endpoint.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test -- src/components/ImportModal.test.tsx`

Expected: the new assertions fail because the buttons remain enabled and no preparation status exists.

- [ ] **Step 3: Implement the minimal preparation state**

In `submitOnce`, set `SubmitPreparation` immediately before each asynchronous preflight and clear it with `finally`. In the form footer, render the exact status copy, disable both submit actions while non-null, and label the foreground action `准备解析中…`.

- [ ] **Step 4: Run focused verification**

Run: `pnpm test -- src/components/ImportModal.test.tsx`

Expected: all ImportModal tests pass.

- [ ] **Step 5: Run project verification**

Run: `pnpm typecheck`

Run: `pnpm test`

Expected: typecheck succeeds and the full Vitest suite passes.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-08-03-import-submit-preflight-feedback.md \
  src/components/ImportModal.test.tsx src/components/ImportModal.tsx
git commit -m "fix(import): show submit preflight progress"
```
