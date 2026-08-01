# Existing Video Overwrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prompt before replacing an existing local-library video and preserve the old video until a confirmed replacement has completed successfully.

**Architecture:** A shared Rust identity helper and `import_preflight` command classify missing, existing, and active imports. `ImportRequest.overwrite` is enforced by the backend. Confirmed replacements run in a sibling staging directory and are promoted under the existing destructive boundary only after transcription succeeds; ordinary imports retain their current lifecycle.

**Tech Stack:** Rust/Tauri 2, Tokio filesystem/process pipeline, React 19, TypeScript, Zustand app dialogs, Vitest, Cargo tests.

## Global Constraints

- Existing imports default to `overwrite: false`; unattended and AI callers cannot overwrite.
- Active same-video jobs remain fenced regardless of overwrite authorization.
- Failed or cancelled replacements must leave the old library entry and files untouched.
- Preserve current scheduler, retry, progress-event, cancellation, and analysis behavior.
- Do not trigger release CI until local full verification passes.

---

### Task 1: Backend identity and preflight

**Files:**
- Modify: `client/src-tauri/src/commands/import.rs`
- Modify: `client/src-tauri/src/lib.rs`

**Interfaces:**
- Produces `derive_video_id(source_kind: &str, source_value: &str) -> AppResult<String>`.
- Produces `import_preflight(...) -> AppResult<ImportPreflight>` serialized as `{ videoId, state, title }`.

- [ ] Add Rust tests proving URL/local identity, existing detection, and active-state precedence.
- [ ] Run targeted tests and confirm they fail because the helper/command does not exist.
- [ ] Implement the shared identity helper and pure state classifier; expose/register the command.
- [ ] Run targeted tests and confirm they pass.
- [ ] Commit the independently testable backend preflight.

### Task 2: Backend overwrite enforcement and staged promotion

**Files:**
- Modify: `client/src-tauri/src/commands/import.rs`
- Modify: `client/src-tauri/src/commands/library.rs`

**Interfaces:**
- Extends `ImportRequest` with `#[serde(default)] pub overwrite: bool`.
- Produces a library helper that promotes a staged directory while preserving library placement and rolling back directory changes on failure.

- [ ] Add Rust tests for rejecting an existing entry without authorization, choosing canonical versus staged working paths, preserving old state on staged failure/cancellation, and successful/failed promotion behavior using temporary directories and in-memory library values.
- [ ] Run targeted tests and confirm expected failures.
- [ ] Register the same-video fence before any destructive action; run overwrite pipelines in a unique sibling staging directory.
- [ ] Defer replacement library publication until transcription succeeds, then promote staging to canonical with backup/rollback handling.
- [ ] Make replacement cancellation clean only staging while ordinary cancellation keeps its current cleanup path.
- [ ] Run targeted tests and confirm they pass.
- [ ] Commit staged overwrite support.

### Task 3: ImportModal confirmation flow

**Files:**
- Modify: `client/src/components/ImportModal.tsx`
- Modify: `client/src/components/ImportModal.test.tsx`

**Interfaces:**
- Consumes `invoke("import_preflight", { sourceKind, sourceValue })`.
- Consumes `confirmDialog(message, { title, okText, cancelText, danger })`.
- Sends `overwrite: false | true` in every interactive `import_video` request.

- [ ] Add Vitest cases for missing, existing-cancel, existing-confirm foreground/background, and running states.
- [ ] Run the focused test file and confirm failures because preflight/confirmation is absent.
- [ ] Add preflight before progress-state mutation and before closing background imports.
- [ ] Keep cancelled confirmation on the form; show a focused running message; submit confirmed imports once with `overwrite: true`.
- [ ] Handle a backend duplicate race by returning to the confirmation flow without showing the generic checklist.
- [ ] Run focused tests and confirm they pass.
- [ ] Commit the frontend interaction.

### Task 4: Documentation, regression verification, integration, and dry-run

**Files:**
- Modify: `client/CLAUDE.md`

- [ ] Document duplicate preflight, active-task behavior, and staged overwrite invariants.
- [ ] Run `cargo fmt --check`, `cargo test --lib`, and `cargo build` in `client/src-tauri`.
- [ ] Run `pnpm test -- --run`, `pnpm typecheck`, and `pnpm build` in `client`.
- [ ] Run `git diff --check` and inspect the final diff for unrelated changes.
- [ ] Commit documentation/final fixes, merge the feature branch into `main`, and push.
- [ ] Dispatch the repository's existing release workflow in dry-run mode and monitor every job to completion; do not publish release assets.
