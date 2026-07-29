# whatSub Single Instance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow only one whatSub desktop backend per OS user and make every later launch restore and focus the existing main window.

**Architecture:** Register Tauri's official Rust single-instance plugin before every other plugin. Keep the UI action in a small adapter that shows, unminimizes, and focuses the existing `main` webview window; the second process exits before business initialization. No cross-process file lock is added.

**Tech Stack:** Tauri 2, Rust, `tauri-plugin-single-instance`, Cargo.

## Global Constraints

- The single-instance plugin must be the first `.plugin(...)` registered on `tauri::Builder`.
- A second launch never runs download, analysis, bridge, migration, or store initialization.
- Existing hidden/minimized `main` window is shown, unminimized, and focused; individual window-operation errors are ignored so later operations are still attempted.
- Process crashes release ownership naturally; the next launch must start normally.
- Updater restart must quit the old process before launching the new executable.
- No JavaScript dependency and no cross-process file lock are introduced.
- Implement in the same isolated worktree as the journal plan, after the journal tasks pass independently.

## File Structure

- Create `src-tauri/src/single_instance.rs`: focused window-reveal adapter plus unit-testable operation trait.
- Modify `src-tauri/src/lib.rs`: module declaration and first plugin registration.
- Modify `src-tauri/Cargo.toml`: Rust plugin dependency.
- Modify `src-tauri/Cargo.lock`: resolved dependency graph.
- Modify `CLAUDE.md`: single-instance and updater restart invariant.

---

### Task 1: Window Reveal Contract

**Files:**
- Create: `src-tauri/src/single_instance.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `pub(crate) fn reveal_main_window(app: &tauri::AppHandle)`.
- Internal test seam: `reveal_window(window: Option<&impl ExistingWindow>)` calls show, unminimize, and focus in that order.

- [ ] **Step 1: Write the failing operation-order test**

Create the module with tests first:

```rust
#[test]
fn existing_window_is_shown_restored_and_focused() {
    let fake = FakeWindow::default();
    reveal_window(Some(&fake));
    assert_eq!(fake.calls(), vec!["show", "unminimize", "focus"]);
}

#[test]
fn missing_main_window_is_a_noop() {
    reveal_window::<FakeWindow>(None);
}
```

The fake records calls in `RefCell<Vec<&'static str>>`. Add a third test where `show` records a failure but `unminimize` and `focus` are still called.

- [ ] **Step 2: Run the module test and confirm failure**

Run from `src-tauri`: `cargo test single_instance -- --nocapture`

Expected: FAIL because the module/helper is not implemented or declared.

- [ ] **Step 3: Implement the adapter**

Use a tiny internal trait:

```rust
trait ExistingWindow {
    fn show_existing(&self);
    fn unminimize_existing(&self);
    fn focus_existing(&self);
}

fn reveal_window<W: ExistingWindow>(window: Option<&W>) {
    let Some(window) = window else { return };
    window.show_existing();
    window.unminimize_existing();
    window.focus_existing();
}

pub(crate) fn reveal_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    let window = app.get_webview_window("main");
    reveal_window(window.as_ref());
}
```

Implement the trait for `tauri::WebviewWindow`; each method calls the corresponding Tauri method and intentionally discards its own `Result`.

- [ ] **Step 4: Run the focused test**

Run from `src-tauri`: `cargo test single_instance -- --nocapture`

Expected: all three new tests PASS.

- [ ] **Step 5: Commit the adapter**

```bash
git add src-tauri/src/single_instance.rs src-tauri/src/lib.rs
git commit -m "test(app): define existing-window reveal behavior"
```

---

### Task 2: Register the Official Single-Instance Plugin

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/lib.rs`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `single_instance::reveal_main_window` from Task 1.
- Produces: one process per app identifier on Windows/macOS/Linux.

- [ ] **Step 1: Register the intended plugin call and capture the missing-crate failure**

Add the intended `.plugin(tauri_plugin_single_instance::init(...))` call to `lib.rs` before adding the Cargo dependency.

Run from `src-tauri`: `cargo check`

Expected: FAIL with an unresolved `tauri_plugin_single_instance` crate.

- [ ] **Step 2: Add the dependency and register it first**

Add under `[dependencies]`:

```toml
tauri-plugin-single-instance = "2"
```

The beginning of `run()` must be exactly ordered like this:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        crate::single_instance::reveal_main_window(app);
    }))
    .plugin(tauri_plugin_opener::init())
```

Do not move business setup into the callback. The callback only reveals the existing window.

Run from `src-tauri`: `cargo check`

Expected: PASS and `Cargo.lock` contains the resolved v2 plugin. Any API mismatch must be corrected against the official Tauri v2 plugin signature, not worked around with a custom mutex.

- [ ] **Step 3: Run Rust tests and build**

Run from `src-tauri`:

```bash
cargo test single_instance -- --nocapture
cargo test
cargo build
```

Expected: tests and build PASS. Confirm the dependency is present once in `Cargo.lock`.

- [ ] **Step 4: Perform the local two-launch smoke test**

Build and launch the debug executable twice from PowerShell:

```powershell
Set-Location src-tauri
cargo build
Start-Process .\target\debug\whatsub.exe
Start-Sleep -Seconds 3
Start-Process .\target\debug\whatsub.exe
Start-Sleep -Seconds 2
(Get-Process whatsub -ErrorAction Stop | Measure-Object).Count
```

Expected: `1`. Minimize the first window, run the second `Start-Process` again, and verify the first window is restored and focused. End only the test process with `Stop-Process -Name whatsub` after the check.

- [ ] **Step 5: Document updater ordering and single-instance behavior**

Add to `CLAUDE.md`:

- single-instance plugin stays first;
- second launches only reveal `main`;
- updater must complete old-process exit before relaunch;
- development and installed builds sharing the app identifier/data directory must not run together.

- [ ] **Step 6: Commit plugin integration**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs CLAUDE.md
git commit -m "feat(app): enforce a single whatsub instance"
```

---

### Task 3: Combined Regression Gate

**Files:**
- No new files expected.

**Interfaces:**
- Consumes: completed journal plan and Tasks 1-2 above.
- Produces: one verified branch ready for review, merge, and later CI.

- [ ] **Step 1: Verify no user-owned changes leaked into the branch**

Run:

```bash
git status --short
git diff origin/main...HEAD --stat
```

Expected: only files named in the two implementation plans and their committed docs are present. The original dirty `Cargo.toml` BOM change and repository-external `.agents/skills`/`AGENTS.md` files from the main workspace must not appear.

- [ ] **Step 2: Run the complete project gate**

Run:

```bash
pnpm typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml
```

Expected: all commands exit 0.

- [ ] **Step 3: Review crash and updater invariants**

Inspect the final diff and confirm:

- journal save precedes preview publication;
- canonical save precedes journal cleanup;
- stale journal cannot pass generation/fingerprint/style/revision checks;
- plugin registration is first;
- second-instance callback contains no initialization;
- updater still calls relaunch only after installation/old-process exit ordering already used by the app.

- [ ] **Step 4: Commit only if verification required a correction**

If the regression gate required a code or test correction, stage only those named files and use:

```bash
git commit -m "test(app): cover recovery and single-instance regressions"
```

If no correction was needed, do not create an empty commit.
