# yt-dlp update check + prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On launch, silently check a JiHuLab-hosted `yt-dlp-version.json`; if a newer yt-dlp exists, show a non-blocking prompt whose 更新 button downloads (JiHuLab primary → GitHub official fallback) and swaps the binary — user-controlled, no auto-update.

**Architecture:** Two new Rust commands in the existing `commands/yt_dlp.rs` (`yt_dlp_check_update` + a dual-source `yt_dlp_update`) built on a pure `is_newer` version comparator. A launch-mounted React toast cloned from the app-updater pattern (`UpdateChecker`/`useUpdater`) but driving the custom invoke commands, with per-version skip persistence.

**Tech Stack:** Rust (Tauri 2 commands, reqwest, serde), React 19 + TS, zustand, Vitest, localStorage.

## Global Constraints

- Manifest URL (verbatim): `https://jihulab.com/rjxznb-group/whatsub-release/-/releases/yt-dlp/downloads/yt-dlp-version.json`
- Download URLs (verbatim):
  - Windows primary (JiHuLab): `https://jihulab.com/rjxznb-group/whatsub-release/-/releases/yt-dlp/downloads/yt-dlp.exe`
  - Windows fallback (GitHub official): `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe`
  - macOS primary (JiHuLab): `https://jihulab.com/rjxznb-group/whatsub-release/-/releases/yt-dlp/downloads/yt-dlp_macos`
  - macOS fallback (GitHub official): `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos`
- `yt-dlp-version.json` shape: `{ "version": "2026.06.09", "notes": "<optional>" }`.
- Version check reads ONLY the JiHuLab manifest; ANY failure ⇒ `hasUpdate=false` (never blocks launch, never errors the prompt path).
- No auto-update: the binary swaps ONLY on an explicit 更新 click. Persist per-version 「不再提醒此版本」.
- yt-dlp versions are dotted numeric (`2026.06.09`) — compare component-wise numerically.
- All HTTP in Rust via `reqwest` (NOT WebView fetch), matching the existing yt-dlp/license/corpus pattern.
- Reuse the existing atomic download path (`.downloading` → rename, in-use-rename handling).

---

### Task 1: Rust — `is_newer` + `yt_dlp_check_update`

**Files:**
- Modify: `client/src-tauri/src/commands/yt_dlp.rs` (add near the bottom, after `yt_dlp_update`)
- Modify: `client/src-tauri/src/lib.rs:69` (register command after `yt_dlp_update`)
- Test: inline `#[cfg(test)] mod tests` in `yt_dlp.rs`

**Interfaces:**
- Produces: `fn is_newer(latest: &str, current: &str) -> bool` (pure)
- Produces: `#[tauri::command] pub async fn yt_dlp_check_update(app: AppHandle) -> Result<YtDlpUpdateInfo, String>`
- Produces (TS-visible camelCase): `YtDlpUpdateInfo { current: string; latest: string; hasUpdate: bool; notes: string }`
- Consumes (existing): `yt_dlp_get_status(app)`.

- [ ] **Step 1: Write the failing tests.** Add to `yt_dlp.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn newer_by_day_month_year() {
        assert!(is_newer("2026.06.10", "2026.06.09"));
        assert!(is_newer("2026.07.01", "2026.06.30"));
        assert!(is_newer("2027.01.01", "2026.12.31"));
    }

    #[test]
    fn not_newer_when_equal_or_older() {
        assert!(!is_newer("2026.06.09", "2026.06.09"));
        assert!(!is_newer("2026.06.08", "2026.06.09"));
    }

    #[test]
    fn handles_point_release_and_malformed() {
        assert!(is_newer("2026.06.09.1", "2026.06.09")); // point release is newer
        assert!(!is_newer("2026.06.09", "2026.06.09.1"));
        assert!(!is_newer("", "2026.06.09"));            // malformed → not newer
        assert!(!is_newer("garbage", "2026.06.09"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `cd client/src-tauri && cargo test is_newer`
Expected: FAIL — `cannot find function is_newer` / `cannot find type YtDlpUpdateInfo`.

- [ ] **Step 3: Implement.** Add to `yt_dlp.rs` (the `Serialize`/`Deserialize`, `Duration`, `reqwest`, `AppHandle` imports already exist; add `use serde::Deserialize;` if only `Serialize` is imported):

```rust
/// JiHuLab-hosted version manifest URL (a dedicated `yt-dlp` release tag,
/// manually kept fresh by the maintainer). See docs/ytdlp-mirror.md.
const YTDLP_MANIFEST_URL: &str =
    "https://jihulab.com/rjxznb-group/whatsub-release/-/releases/yt-dlp/downloads/yt-dlp-version.json";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct YtDlpUpdateInfo {
    pub current: String,
    pub latest: String,
    pub has_update: bool,
    pub notes: String,
}

#[derive(serde::Deserialize)]
struct YtDlpManifest {
    version: String,
    #[serde(default)]
    notes: String,
}

/// True when dotted-numeric `latest` is strictly newer than `current`
/// (e.g. "2026.06.10" > "2026.06.09"). Component-wise numeric compare so
/// point releases ("2026.06.09.1") and any zero-pad quirks are handled;
/// unparseable components count as 0, so malformed input is never "newer".
fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| {
        s.split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect::<Vec<u64>>()
    };
    let (l, c) = (parse(latest), parse(current));
    for i in 0..l.len().max(c.len()) {
        let lv = l.get(i).copied().unwrap_or(0);
        let cv = c.get(i).copied().unwrap_or(0);
        if lv != cv {
            return lv > cv;
        }
    }
    false
}

#[tauri::command]
pub async fn yt_dlp_check_update(app: AppHandle) -> Result<YtDlpUpdateInfo, String> {
    let current = yt_dlp_get_status(app).await?.version;
    let none = |cur: &str| YtDlpUpdateInfo {
        current: cur.to_string(),
        latest: cur.to_string(),
        has_update: false,
        notes: String::new(),
    };
    // Best-effort: any network/parse failure → "no update" (never blocks launch).
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Ok(none(&current)),
    };
    let manifest: YtDlpManifest = match client.get(YTDLP_MANIFEST_URL).send().await {
        Ok(resp) => match resp.error_for_status() {
            Ok(ok) => match ok.json().await {
                Ok(m) => m,
                Err(_) => return Ok(none(&current)),
            },
            Err(_) => return Ok(none(&current)),
        },
        Err(_) => return Ok(none(&current)),
    };
    let has_update = is_newer(&manifest.version, &current);
    Ok(YtDlpUpdateInfo {
        current,
        latest: manifest.version,
        has_update,
        notes: manifest.notes,
    })
}
```

- [ ] **Step 4: Register the command.** In `client/src-tauri/src/lib.rs`, in `generate_handler![ ... ]`, right after `commands::yt_dlp::yt_dlp_update,` (line 69) add:

```rust
            commands::yt_dlp::yt_dlp_check_update,
```

- [ ] **Step 5: Run tests + build.**

Run: `cd client/src-tauri && cargo test is_newer && cargo build`
Expected: 3 tests PASS; clean build.

- [ ] **Step 6: Commit.**

```bash
git add client/src-tauri/src/commands/yt_dlp.rs client/src-tauri/src/lib.rs
git commit -m "feat(yt-dlp): yt_dlp_check_update against jihu manifest + is_newer"
```

---

### Task 2: Rust — dual-source download in `yt_dlp_update`

**Files:**
- Modify: `client/src-tauri/src/commands/yt_dlp.rs` — `yt_dlp_update` (~112-180)

**Interfaces:**
- Consumes: existing `appdata_yt_dlp_path`, `run_version_cmd`, atomic-rename logic.
- Produces: same `yt_dlp_update() -> Result<YtDlpStatus, String>` signature; only the download source changes (JiHuLab primary → GitHub fallback).

- [ ] **Step 1: Replace the single-URL block with dual-source.** In `yt_dlp_update`, replace the current `let url = if cfg!(... windows) { "https://github.com/.../yt-dlp.exe" } ... else { return Err(...) };` block with a `(primary, fallback)` pair:

```rust
    let (primary, fallback) = if cfg!(target_os = "windows") {
        (
            "https://jihulab.com/rjxznb-group/whatsub-release/-/releases/yt-dlp/downloads/yt-dlp.exe",
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
        )
    } else if cfg!(target_os = "macos") {
        (
            "https://jihulab.com/rjxznb-group/whatsub-release/-/releases/yt-dlp/downloads/yt-dlp_macos",
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
        )
    } else {
        return Err("当前操作系统不支持 yt-dlp 自动更新".into());
    };
```

Then replace the single `let bytes = client.get(url)...` chain with a helper call that tries primary then fallback. Add this free function above `yt_dlp_update`:

```rust
/// GET a URL and return the whole body, mapping errors to Chinese strings.
async fn download_bytes(client: &reqwest::Client, url: &str) -> Result<bytes::Bytes, String> {
    client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("下载失败: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))
}
```

And in `yt_dlp_update`, replace the inline `let bytes = client.get(url)....bytes().await.map_err(...)?;` with:

```rust
    let bytes = match download_bytes(&client, primary).await {
        Ok(b) => b,
        Err(primary_err) => download_bytes(&client, fallback)
            .await
            .map_err(|fb_err| format!("主源失败({primary_err}); 备用源失败({fb_err})"))?,
    };
```

> `bytes::Bytes` is already available transitively via reqwest; if the crate
> doesn't resolve `bytes::Bytes`, use `reqwest::Response`'s return type by
> having `download_bytes` return `Result<Vec<u8>, String>` and `.to_vec()` the
> bytes — then `std::fs::write(&tmp_path, &bytes)` still works.

- [ ] **Step 2: Build.**

Run: `cd client/src-tauri && cargo build`
Expected: clean build. (No new unit test — this is an I/O change; covered by the manual smoke test in Task 5 and the existing `yt_dlp_update` shape.)

- [ ] **Step 3: Commit.**

```bash
git add client/src-tauri/src/commands/yt_dlp.rs
git commit -m "feat(yt-dlp): download from jihu mirror first, github official fallback"
```

---

### Task 3: TS — `useYtDlpUpdater` hook + `shouldPromptYtDlp`

**Files:**
- Create: `client/src/hooks/useYtDlpUpdater.ts`
- Test: `client/src/hooks/useYtDlpUpdater.test.ts`

**Interfaces:**
- Consumes: `invoke("yt_dlp_check_update")` → `YtDlpUpdateInfo`, `invoke("yt_dlp_update")` → `{version, source}`.
- Produces:

```ts
export interface YtDlpUpdateInfo { current: string; latest: string; hasUpdate: boolean; notes: string }
export type YtDlpStatus =
  | { type: "idle" } | { type: "checking" }
  | { type: "available"; info: YtDlpUpdateInfo }
  | { type: "none" } | { type: "updating" }
  | { type: "done"; version: string } | { type: "error"; message: string };
export function shouldPromptYtDlp(info: YtDlpUpdateInfo | null, skipped: string[]): boolean;
export function useYtDlpUpdater(): { status: YtDlpStatus; checkNow: () => void; update: () => void };
```

- [ ] **Step 1: Write the failing test.** Create `useYtDlpUpdater.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shouldPromptYtDlp } from "./useYtDlpUpdater";

describe("shouldPromptYtDlp", () => {
  const info = { current: "2026.06.09", latest: "2026.07.01", hasUpdate: true, notes: "" };
  it("prompts when hasUpdate and not skipped", () => {
    expect(shouldPromptYtDlp(info, [])).toBe(true);
  });
  it("does not prompt when skipped", () => {
    expect(shouldPromptYtDlp(info, ["2026.07.01"])).toBe(false);
  });
  it("does not prompt when no update", () => {
    expect(shouldPromptYtDlp({ ...info, hasUpdate: false }, [])).toBe(false);
  });
  it("does not prompt when info is null", () => {
    expect(shouldPromptYtDlp(null, [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd client && pnpm vitest run src/hooks/useYtDlpUpdater.test.ts`
Expected: FAIL — cannot resolve `./useYtDlpUpdater`.

- [ ] **Step 3: Implement.** Create `useYtDlpUpdater.ts` (module-level zustand + single-flight, mirroring `useUpdater.ts`):

```ts
import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export interface YtDlpUpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  notes: string;
}

export type YtDlpStatus =
  | { type: "idle" }
  | { type: "checking" }
  | { type: "available"; info: YtDlpUpdateInfo }
  | { type: "none" }
  | { type: "updating" }
  | { type: "done"; version: string }
  | { type: "error"; message: string };

export function shouldPromptYtDlp(info: YtDlpUpdateInfo | null, skipped: string[]): boolean {
  return !!info && info.hasUpdate && !skipped.includes(info.latest);
}

interface Store {
  status: YtDlpStatus;
  set: (s: YtDlpStatus) => void;
}
const useStore = create<Store>((set) => ({
  status: { type: "idle" },
  set: (status) => set({ status }),
}));

let running: Promise<void> | null = null;

async function runCheck(): Promise<void> {
  const { set, status } = useStore.getState();
  if (status.type === "updating") return;
  set({ type: "checking" });
  try {
    const info = await invoke<YtDlpUpdateInfo>("yt_dlp_check_update");
    useStore.getState().set(info.hasUpdate ? { type: "available", info } : { type: "none" });
  } catch (e) {
    useStore.getState().set({ type: "error", message: String(e) });
  }
}

async function runUpdate(): Promise<void> {
  if (running) return running;
  const { status, set } = useStore.getState();
  if (status.type === "updating") return;
  set({ type: "updating" });
  running = (async () => {
    try {
      const res = await invoke<{ version: string }>("yt_dlp_update");
      useStore.getState().set({ type: "done", version: res.version });
    } catch (e) {
      useStore.getState().set({ type: "error", message: String(e) });
    } finally {
      running = null;
    }
  })();
  return running;
}

export function useYtDlpUpdater() {
  const status = useStore((s) => s.status);
  const checkNow = useCallback(() => void runCheck(), []);
  const update = useCallback(() => void runUpdate(), []);
  return { status, checkNow, update };
}
```

- [ ] **Step 4: Run test + typecheck.**

Run: `cd client && pnpm vitest run src/hooks/useYtDlpUpdater.test.ts && pnpm typecheck`
Expected: 4 tests PASS; typecheck clean.

- [ ] **Step 5: Commit.**

```bash
git add client/src/hooks/useYtDlpUpdater.ts client/src/hooks/useYtDlpUpdater.test.ts
git commit -m "feat(yt-dlp): useYtDlpUpdater hook + shouldPromptYtDlp"
```

---

### Task 4: TS — `YtDlpUpdateToast` + mount

**Files:**
- Create: `client/src/components/YtDlpUpdateToast.tsx`
- Test: `client/src/components/YtDlpUpdateToast.test.tsx`
- Modify: `client/src/App.tsx` (add `<YtDlpUpdateToast />` next to `<UpdateChecker />` at ~line 156)

**Interfaces:**
- Consumes: `useYtDlpUpdater` (Task 3).
- Produces: `export function YtDlpUpdateToast(): JSX.Element | null`.

- [ ] **Step 1: Write the failing test.** Create `YtDlpUpdateToast.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

let status: unknown = { type: "idle" };
const update = vi.fn();
vi.mock("../hooks/useYtDlpUpdater", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, useYtDlpUpdater: () => ({ status, checkNow: vi.fn(), update }) };
});

import { YtDlpUpdateToast } from "./YtDlpUpdateToast";

beforeEach(() => { localStorage.clear(); update.mockReset(); });

describe("YtDlpUpdateToast", () => {
  it("renders nothing when idle", () => {
    status = { type: "idle" };
    const { container } = render(<YtDlpUpdateToast />);
    expect(container).toBeEmptyDOMElement();
  });
  it("shows the prompt with the new version when available", () => {
    status = { type: "available", info: { current: "2026.06.09", latest: "2026.07.01", hasUpdate: true, notes: "" } };
    render(<YtDlpUpdateToast />);
    expect(screen.getByText(/yt-dlp/)).toBeInTheDocument();
    expect(screen.getByText(/2026\.07\.01/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /更新/ })).toBeInTheDocument();
  });
  it("does not show a prompt for a skipped version", () => {
    localStorage.setItem("ytdlpSkippedVersions", JSON.stringify(["2026.07.01"]));
    status = { type: "available", info: { current: "2026.06.09", latest: "2026.07.01", hasUpdate: true, notes: "" } };
    const { container } = render(<YtDlpUpdateToast />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd client && pnpm vitest run src/components/YtDlpUpdateToast.test.tsx`
Expected: FAIL — cannot resolve `./YtDlpUpdateToast`.

- [ ] **Step 3: Implement.** Create `YtDlpUpdateToast.tsx` (clone of `UpdateChecker.tsx`, own skip key, own copy; bottom-LEFT to avoid colliding with the app-updater toast at bottom-right):

```tsx
import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { useYtDlpUpdater, shouldPromptYtDlp } from "../hooks/useYtDlpUpdater";

const SKIPPED_KEY = "ytdlpSkippedVersions";

function getSkipped(): string[] {
  try {
    const raw = localStorage.getItem(SKIPPED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
function addSkipped(version: string) {
  const list = getSkipped();
  if (!list.includes(version)) {
    list.push(version);
    localStorage.setItem(SKIPPED_KEY, JSON.stringify(list));
  }
}

/**
 * Launch-time yt-dlp update prompt. Checks the JiHuLab manifest ~3s after
 * launch and, if a newer yt-dlp exists (and the user hasn't skipped it),
 * shows a non-blocking bottom-left toast. Explicit-consent only. Silent on
 * failure / no update. Bottom-LEFT so it never overlaps the app-updater toast.
 */
export function YtDlpUpdateToast() {
  const { status, checkNow, update } = useYtDlpUpdater();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => void checkNow(), 3000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status.type === "available" && !dismissed) {
    const info = status.info;
    if (!shouldPromptYtDlp(info, getSkipped())) return null;
    return (
      <div className="fixed bottom-4 left-4 z-[60] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 w-80">
        <div className="flex items-start gap-2">
          <Download className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-zinc-100">
              yt-dlp 有新版本 {info.latest}
            </div>
            <div className="text-xs text-zinc-400 mt-1 leading-relaxed">
              更新以保持视频下载可用。
              {info.notes && <div className="mt-1 whitespace-pre-wrap">{info.notes}</div>}
            </div>
          </div>
          <button onClick={() => setDismissed(true)} className="text-zinc-500 hover:text-zinc-200" title="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={() => void update()}
            className="px-3 py-1.5 bg-emerald-500 text-black text-xs rounded font-medium hover:bg-emerald-400"
          >
            更新
          </button>
          <button onClick={() => setDismissed(true)} className="px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100">
            稍后
          </button>
        </div>
        <label className="flex items-center gap-1.5 mt-2 text-[10px] text-zinc-500 cursor-pointer hover:text-zinc-400">
          <input
            type="checkbox"
            onChange={(e) => {
              if (e.target.checked) {
                addSkipped(info.latest);
                setDismissed(true);
              }
            }}
            className="accent-emerald-400 h-3 w-3"
          />
          不再提醒此版本
        </label>
      </div>
    );
  }

  if (status.type === "updating") {
    return (
      <div className="fixed bottom-4 left-4 z-[60] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 w-80">
        <div className="text-sm font-medium text-zinc-100">正在更新 yt-dlp…</div>
      </div>
    );
  }

  if (status.type === "done" && !dismissed) {
    return (
      <div className="fixed bottom-4 left-4 z-[60] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 w-80">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-emerald-300">yt-dlp 已更新到 {status.version}</div>
          <button onClick={() => setDismissed(true)} className="text-zinc-500 hover:text-zinc-200"><X className="h-4 w-4" /></button>
        </div>
      </div>
    );
  }

  return null;
}
```

- [ ] **Step 4: Mount it.** In `client/src/App.tsx`, add the import near the `UpdateChecker` import (line 11) and render it right after `<UpdateChecker />` (line 156):

```tsx
import { YtDlpUpdateToast } from "./components/YtDlpUpdateToast";
```
```tsx
      <UpdateChecker />
      <YtDlpUpdateToast />
```

- [ ] **Step 5: Run test + typecheck + full suite.**

Run: `cd client && pnpm vitest run src/components/YtDlpUpdateToast.test.tsx && pnpm typecheck && pnpm test`
Expected: 3 new tests PASS; typecheck clean; full suite green.

- [ ] **Step 6: Commit.**

```bash
git add client/src/components/YtDlpUpdateToast.tsx client/src/components/YtDlpUpdateToast.test.tsx client/src/App.tsx
git commit -m "feat(yt-dlp): launch-time update prompt toast (bottom-left)"
```

---

### Task 5: Ops doc — JiHuLab mirror upkeep

**Files:**
- Create: `client/docs/ytdlp-mirror.md`

- [ ] **Step 1: Write the runbook.** Create `client/docs/ytdlp-mirror.md`:

```markdown
# Manually refreshing the JiHuLab yt-dlp mirror

The desktop app checks `.../releases/yt-dlp/downloads/yt-dlp-version.json` on the
JiHuLab `whatsub-release` project (a fixed release tag named `yt-dlp`) and prompts
users to update. That mirror is maintained MANUALLY. To publish a newer yt-dlp:

1. Download the target yt-dlp from upstream GitHub:
   - `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe`
   - `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos`
   (Or a specific nightly if you track that channel.)
2. Get its version: `yt-dlp.exe --version` → e.g. `2026.07.01`.
3. Write `yt-dlp-version.json`:
   ```json
   { "version": "2026.07.01", "notes": "修复 YouTube 下载" }
   ```
4. Upload all THREE assets to the `yt-dlp` release tag on
   `rjxznb-group/whatsub-release` (overwrite/clobber the existing ones), so the
   fixed download URLs keep pointing at the new files.

## Before publishing a newer yt-dlp, re-check compatibility

Newer yt-dlp can change CLI flags or runtime requirements. whatsub passes these
flags (`pipeline/ytdlp.rs`): `--js-runtimes node:<path>`, `--cookies`,
`--ffmpeg-location`, `-f`, `-o`, `--merge-output-format`, `--no-playlist`,
`--continue`, `--retries`, `--fragment-retries`, `--retry-sleep`,
`--socket-timeout`, `--newline`, `--progress-template`, `--postprocessor-args`,
`--write-info-json`, `--write-thumbnail`, `--proxy`.

Skim the target release's changelog for:
- Any of those flags being removed/renamed (especially `--js-runtimes`).
- Raised **runtime minimums** — whatsub bundles a `node` sidecar; e.g. yt-dlp
  2026.06.09 requires Node ≥ v22 and whatsub bundles v22.11.0. If a newer yt-dlp
  requires a higher Node, the bundled node sidecar must be upgraded IN THE SAME
  app release (they are coupled). GitHub fallback is always the official latest,
  so this coupling matters most when the app's bundled node lags.
```

- [ ] **Step 2: Commit.**

```bash
git add client/docs/ytdlp-mirror.md
git commit -m "docs(yt-dlp): jihu mirror upkeep + compatibility checklist"
```

---

## Final verification

- [ ] `cd client/src-tauri && cargo test` — green (incl. `is_newer` tests).
- [ ] `cd client && pnpm typecheck && pnpm test` — green (incl. the new hook + toast tests).
- [ ] Manual smoke test (real build): temporarily upload a `yt-dlp-version.json`
  with a version HIGHER than bundled to the JiHuLab `yt-dlp` tag; launch the app;
  confirm the bottom-left prompt appears, 更新 downloads + swaps (verify
  `<app_data>/bin/yt-dlp` version bumped), 不再提醒此版本 suppresses it next launch,
  and that with the manifest at/below the current version NO prompt appears.
```
