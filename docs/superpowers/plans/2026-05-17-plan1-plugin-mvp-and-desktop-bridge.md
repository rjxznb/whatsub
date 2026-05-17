# whatsub Browser Plugin · Plan 1 · Plugin MVP + Desktop Bridge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a free Chrome/Edge MV3 extension that gives users bilingual subtitles + on-demand AI key-phrase highlighting on YouTube, plus universal word-collection across any site, with optional one-way sync to the whatsub desktop client via a localhost bridge.

**Architecture:** MV3 service worker owns all LLM streaming and the sync queue; one content script for YouTube (CC listener + side panel + bottom overlay) and one for all-sites (selection bubble); side panel rendered inside Shadow DOM with Tailwind for style isolation. Desktop bridge is a new Rust HTTP module inside the Tauri app, binding to one of four deterministic loopback ports, serving CORS-restricted JSON endpoints. Two new pnpm workspace packages (`@whatsub/llm-core`, `@whatsub/shared-types`) factor out reusable LLM protocol + types from the desktop codebase.

**Tech Stack:** TypeScript · Vite + @crxjs/vite-plugin · React 19 · Tailwind v3 · zustand · IndexedDB (idb library) · pnpm workspaces · Rust actix-web 4 (desktop bridge) · Vitest · Playwright

---

## Scope reference

This plan implements **spec §12 phases 0–8 only**: workspace bootstrap → plugin skeleton → YouTube subtitle pipeline → AI highlight → selection bubble → desktop bridge → sync queue → LLM-config handoff. Shared-corpus work (UGC upload, lookup, classifier, seed) is Plan 2 + Plan 3. The deliverable from this plan is a shippable extension that works standalone OR with desktop sync.

## File structure

### New packages (pnpm workspace at repo root)

| Path | Responsibility |
|---|---|
| `pnpm-workspace.yaml` | Declares `client/`, `packages/*`, `web-plugin/` as workspaces |
| `packages/shared-types/package.json` | Workspace package metadata |
| `packages/shared-types/src/index.ts` | Re-exports VocabEntry, CorpusEntry, Settings, etc. |
| `packages/shared-types/src/vocab.ts` | Moved from `client/src/types/vocab.ts` + 4 new fields per spec §4.1 |
| `packages/shared-types/src/corpus.ts` | New — CorpusEntry (local, distinct from server CorpusContribution) |
| `packages/shared-types/src/settings.ts` | Moved from `client/src/types/settings.ts` |
| `packages/shared-types/src/bridge.ts` | New — `BRIDGE_PORTS = [51737, 53401, 59283, 62015]` |
| `packages/llm-core/package.json` | Workspace package metadata |
| `packages/llm-core/src/index.ts` | Re-exports streaming protocols + helpers |
| `packages/llm-core/src/protocols/{openaiCompatible,claude,gemini}.ts` | Moved from `client/src/llm/providers/*` |
| `packages/llm-core/src/protocols/types.ts` | Provider interface |
| `packages/llm-core/src/streamingJson.ts` | Moved from `client/src/llm/streamingJson.ts` |
| `packages/llm-core/src/batchSubtitles.ts` | Moved + renamed `batchTranslate` |
| `packages/llm-core/src/analyze.ts` | Moved from `client/src/llm/analyze.ts` |
| `packages/llm-core/src/lookupExpression.ts` | Moved |
| `packages/llm-core/src/vendors.ts` | 10 LLM vendor presets |
| `packages/llm-core/src/normalizeExpression.ts` | Moved from `client/src/utils/normalizeExpression.ts` |
| `packages/llm-core/src/friendlyError.ts` | Moved from `client/src/utils/friendlyError.ts` |

### Plugin (`web-plugin/`)

| Path | Responsibility |
|---|---|
| `web-plugin/package.json` | Deps: react, react-dom, tailwindcss, idb, zustand, @whatsub/llm-core, @whatsub/shared-types |
| `web-plugin/vite.config.ts` | `@crxjs/vite-plugin` configured for MV3 + multi-entry |
| `web-plugin/manifest.json` | MV3 manifest |
| `web-plugin/tsconfig.json` | Standard TS config with workspace path mapping |
| `web-plugin/tailwind.config.js` | `preflight: false` (shadow DOM compat) |
| `web-plugin/src/manifest.ts` | TS-typed manifest exported to Vite plugin |
| `web-plugin/src/sw/index.ts` | Service worker entry (background) |
| `web-plugin/src/sw/keepAlive.ts` | `chrome.alarms` heartbeat to dodge MV3 30s idle kill |
| `web-plugin/src/sw/llmStream.ts` | Owns all LLM streaming fetch via `@whatsub/llm-core` |
| `web-plugin/src/sw/syncQueue.ts` | Persistent queue in `chrome.storage.local["syncQueue"]` + replay |
| `web-plugin/src/sw/bridge/discover.ts` | Port-race probe of `BRIDGE_PORTS` |
| `web-plugin/src/sw/bridge/client.ts` | `POST /vocab`, `POST /vocab/batch`, etc. |
| `web-plugin/src/sw/transcripts/idb.ts` | IndexedDB schema + CRUD via `idb` |
| `web-plugin/src/sw/transcripts/fetchCC.ts` | timedtext JSON3 fetcher + parser |
| `web-plugin/src/sw/transcripts/translate.ts` | Calls `batchSubtitles` from llm-core, streams `cue-translated` back |
| `web-plugin/src/sw/transcripts/analyze.ts` | Calls `analyze` from llm-core, streams `cue-analyzed` back |
| `web-plugin/src/sw/messaging.ts` | Long-lived `chrome.runtime.connect` port handlers |
| `web-plugin/src/sw/vocab.ts` | chrome.storage.local CRUD for vocab entries |
| `web-plugin/src/cs/youtube/index.ts` | YouTube content script entry — only injects on `/watch` |
| `web-plugin/src/cs/youtube/ccListener.ts` | Watches `video.textTracks` mode + reads ytInitialPlayerResponse |
| `web-plugin/src/cs/youtube/sidePanelMount.ts` | Mounts side panel React app into Shadow DOM at `#secondary-inner` |
| `web-plugin/src/cs/youtube/overlayMount.ts` | Mounts bottom bilingual overlay above `.ytp-caption-window-container` |
| `web-plugin/src/cs/web/index.ts` | Universal content script — only mounts selection bubble |
| `web-plugin/src/cs/web/selectionBubble.ts` | Shadow-DOM selection bubble React app |
| `web-plugin/src/cs/web/contentEditableGuard.ts` | Skips selection in Notion / Slack / contenteditable |
| `web-plugin/src/ui/SidePanel/SidePanel.tsx` | Side panel root |
| `web-plugin/src/ui/SidePanel/SubtitleList.tsx` | Reuses cue-row pattern from desktop, with currentTime sync |
| `web-plugin/src/ui/SidePanel/SubtitleCue.tsx` | One row — English text, Chinese translation, highlight marks |
| `web-plugin/src/ui/SidePanel/HighlightMark.tsx` | Renders `<mark class="hl">` wrapping |
| `web-plugin/src/ui/SidePanel/AnalyzeButton.tsx` | The ✨ AI 标黄 trigger |
| `web-plugin/src/ui/SidePanel/StatusPill.tsx` | 3-state desktop-connection indicator |
| `web-plugin/src/ui/Overlay/BottomBilingual.tsx` | Bottom bilingual overlay |
| `web-plugin/src/ui/Bubble/SelectionBubble.tsx` | Shared bubble component (YouTube + web) |
| `web-plugin/src/ui/Bubble/LookupButton.tsx` | ✨ AI 查词 button |
| `web-plugin/src/ui/popup/Popup.tsx` | Toolbar popup — vocab list view |
| `web-plugin/src/ui/popup/VocabCard.tsx` | One vocab entry card |
| `web-plugin/src/ui/options/Options.tsx` | Settings page — LLM config + sync toggles |
| `web-plugin/src/ui/options/LlmConfig.tsx` | Provider picker + API key input |
| `web-plugin/src/ui/options/HandoffButton.tsx` | One-shot desktop config handoff |
| `web-plugin/src/state/settings.ts` | zustand store backed by `chrome.storage.local` |
| `web-plugin/src/state/vocab.ts` | zustand store for vocab |
| `web-plugin/src/state/bridge.ts` | zustand store for bridge status (3-state) |
| `web-plugin/src/util/normalizeUrl.ts` | YouTube URL canonicalizer (for `videoUrl` field) |
| `web-plugin/src/util/contributorId.ts` | Generates + persists anonymous UUID |

### Desktop bridge (`client/src-tauri/src/bridge/`)

| Path | Responsibility |
|---|---|
| `client/src-tauri/Cargo.toml` (modify) | Add `actix-web = "4"`, `actix-cors = "0.7"`, `tokio = { version = "1", features = ["full"] }` |
| `client/src-tauri/src/bridge/mod.rs` | Module root + public `start_bridge` entry |
| `client/src-tauri/src/bridge/port.rs` | Iterates `BRIDGE_PORTS = [51737, 53401, 59283, 62015]`, returns first bound listener |
| `client/src-tauri/src/bridge/server.rs` | actix-web app builder + CORS layer + Origin check |
| `client/src-tauri/src/bridge/routes.rs` | All five routes (ping, vocab, vocab/batch, corpus, settings/llm + handoff) |
| `client/src-tauri/src/bridge/handoff.rs` | Native dialog confirmation for `/settings/llm/handoff` |
| `client/src-tauri/src/lib.rs` (modify) | Call `bridge::start_bridge(app_handle)` in `setup()` |
| `client/src-tauri/tests/bridge_integration.rs` | Rust integration tests via actix-web's TestServer |

---

## Task list

### Task 1: pnpm workspace bootstrap

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `client/package.json`
- Create: `package.json` (root)

- [ ] **Step 1: Verify no existing root package.json**

Run: `ls C:/Users/renjx/Desktop/Get_Video/package.json`
Expected: file not found

- [ ] **Step 2: Create root package.json**

```json
{
  "name": "whatsub-monorepo",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "build:all": "pnpm -r --parallel build",
    "test:all": "pnpm -r --parallel test",
    "typecheck:all": "pnpm -r --parallel typecheck"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 3: Create pnpm-workspace.yaml**

```yaml
packages:
  - 'client'
  - 'packages/*'
  - 'web-plugin'
```

- [ ] **Step 4: Verify pnpm install succeeds**

Run: `pnpm install`
Expected: no errors; lockfile created; client/ symlinked under `node_modules`

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml
git commit -m "chore: bootstrap pnpm workspace for plugin extraction"
```

---

### Task 2: Create @whatsub/shared-types package

**Files:**
- Create: `packages/shared-types/package.json`
- Create: `packages/shared-types/tsconfig.json`
- Create: `packages/shared-types/src/index.ts`
- Create: `packages/shared-types/src/vocab.ts`
- Create: `packages/shared-types/src/settings.ts`
- Create: `packages/shared-types/src/bridge.ts`
- Create: `packages/shared-types/src/corpus.ts`

- [ ] **Step 1: Scaffold package.json**

```json
{
  "name": "@whatsub/shared-types",
  "version": "0.1.0",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Add tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Copy VocabEntry from client and add 4 new fields**

Copy `client/src/types/vocab.ts` content into `packages/shared-types/src/vocab.ts`, then extend with the 4 new fields per spec §4.1:

```ts
export interface VocabEntry {
  id: string;
  expression: string;
  meaningZh: string;
  usage: string;
  videoId: string;
  videoTitle: string;
  addedAt: string;
  cueTime?: number;
  cueText?: string;
  note?: string;
  noteUpdatedAt?: number;
  // Added for plugin per spec §4.1
  source?: "desktop" | "youtube" | "web";
  pageUrl?: string;
  videoUrl?: string;
  syncStatus?: "synced" | "pending";
}

export function makeVocabId(expression: string): string {
  return expression.toLowerCase().trim();
}
```

- [ ] **Step 4: Create bridge.ts with the 4 ports**

```ts
// packages/shared-types/src/bridge.ts
/** Deterministic candidate ports for the localhost desktop bridge.
 *  All 4 in IANA Dynamic/Private range (49152–65535), spaced > 1500 apart.
 *  See spec §6.1. */
export const BRIDGE_PORTS = [51737, 53401, 59283, 62015] as const;

export interface PingResponse {
  service: "whatsub-bridge";
  version: string;
  desktopVersion: string;
}
```

- [ ] **Step 5: Create corpus.ts (local CorpusEntry, distinct from server schema)**

```ts
// packages/shared-types/src/corpus.ts
export interface CorpusEntry {
  id: string;
  cueText: string;
  cueTr: string;
  videoId: string;
  videoUrl: string;
  videoTitle: string;
  cueTime: number;
  capturedAt: string;
  highlightWords?: string[];
  highlightTranslations?: string[];
  keyNote?: string;
}
```

- [ ] **Step 6: Copy Settings from client**

Copy `client/src/types/settings.ts` content into `packages/shared-types/src/settings.ts` as-is (no field changes — plugin-specific fields go in plugin code, not shared types).

- [ ] **Step 7: Create index.ts barrel**

```ts
// packages/shared-types/src/index.ts
export * from "./vocab";
export * from "./settings";
export * from "./bridge";
export * from "./corpus";
```

- [ ] **Step 8: Run typecheck**

Run: `pnpm --filter @whatsub/shared-types typecheck`
Expected: PASS, 0 errors

- [ ] **Step 9: Commit**

```bash
git add packages/shared-types/
git commit -m "feat(shared-types): add cross-package types for vocab + bridge + corpus"
```

---

### Task 3: Extract @whatsub/llm-core package

**Files:**
- Create: `packages/llm-core/package.json`
- Create: `packages/llm-core/tsconfig.json`
- Create: `packages/llm-core/src/index.ts`
- Create: `packages/llm-core/src/protocols/{types,openaiCompatible,claude,gemini}.ts`
- Create: `packages/llm-core/src/{streamingJson,batchSubtitles,analyze,lookupExpression,normalizeExpression,friendlyError,vendors}.ts`
- Create: `packages/llm-core/src/**/*.test.ts` (copied from client)

- [ ] **Step 1: Scaffold package.json**

```json
{
  "name": "@whatsub/llm-core",
  "version": "0.1.0",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@whatsub/shared-types": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Add tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Move files from client/src/llm/ to packages/llm-core/src/**

Use `git mv` to preserve history:

```bash
mkdir -p packages/llm-core/src/protocols
git mv client/src/llm/types.ts packages/llm-core/src/protocols/types.ts
git mv client/src/llm/providers/openaiCompatible.ts packages/llm-core/src/protocols/openaiCompatible.ts
git mv client/src/llm/providers/claude.ts packages/llm-core/src/protocols/claude.ts
git mv client/src/llm/providers/gemini.ts packages/llm-core/src/protocols/gemini.ts
git mv client/src/llm/providers/index.ts packages/llm-core/src/protocols/index.ts
git mv client/src/llm/streamingJson.ts packages/llm-core/src/streamingJson.ts
git mv client/src/llm/batchSubtitles.ts packages/llm-core/src/batchSubtitles.ts
git mv client/src/llm/analyze.ts packages/llm-core/src/analyze.ts
git mv client/src/llm/lookupExpression.ts packages/llm-core/src/lookupExpression.ts
git mv client/src/llm/vendors.ts packages/llm-core/src/vendors.ts
git mv client/src/llm/prompts.ts packages/llm-core/src/prompts.ts
git mv client/src/utils/normalizeExpression.ts packages/llm-core/src/normalizeExpression.ts
git mv client/src/utils/friendlyError.ts packages/llm-core/src/friendlyError.ts
git mv client/src/llm/streamingJson.test.ts packages/llm-core/src/streamingJson.test.ts
```

Note: `client/src/llm/modelTiers.ts` and `client/src/llm/phonetic.ts` STAY in `client/` — they reference whisper / asset-only deps that don't belong in a shared package.

- [ ] **Step 4: Update import paths in moved files**

Open each moved file and change relative imports:
- `../types/settings` → `@whatsub/shared-types`
- `../types/vocab` → `@whatsub/shared-types`
- `./types` (when inside protocols/) → `./types`

Run a regex find/replace in `packages/llm-core/src/**/*.ts`:
- `from "../../types/settings"` → `from "@whatsub/shared-types"`
- `from "../../types/vocab"` → `from "@whatsub/shared-types"`

- [ ] **Step 5: Create index.ts barrel**

```ts
// packages/llm-core/src/index.ts
export * from "./protocols";
export * from "./streamingJson";
export * from "./batchSubtitles";
export * from "./analyze";
export * from "./lookupExpression";
export * from "./vendors";
export * from "./prompts";
export { normalizeExpression } from "./normalizeExpression";
export { friendlyError } from "./friendlyError";
```

- [ ] **Step 6: Run llm-core's own tests**

Run: `pnpm --filter @whatsub/llm-core test`
Expected: PASS — streamingJson.test.ts validates parser; any other moved tests pass

- [ ] **Step 7: Commit (preserves git mv history)**

```bash
git add packages/llm-core/ client/src/llm/ client/src/utils/
git commit -m "refactor(llm-core): extract LLM protocol layer into @whatsub/llm-core workspace package"
```

---

### Task 4: Wire desktop client to consume the new packages

**Files:**
- Modify: `client/package.json`
- Modify: `client/src/**/*.ts*` (import path updates)

- [ ] **Step 1: Add workspace deps to client/package.json**

```json
{
  "dependencies": {
    "@whatsub/llm-core": "workspace:*",
    "@whatsub/shared-types": "workspace:*"
  }
}
```

- [ ] **Step 2: Update client imports**

Find and replace across `client/src/**/*.{ts,tsx}`:
- `from "./types/vocab"` → `from "@whatsub/shared-types"` (when target is VocabEntry/makeVocabId)
- `from "./types/settings"` → `from "@whatsub/shared-types"`
- `from "./llm/analyze"` → `from "@whatsub/llm-core"`
- `from "./llm/batchSubtitles"` → `from "@whatsub/llm-core"`
- `from "./llm/lookupExpression"` → `from "@whatsub/llm-core"`
- `from "./llm/vendors"` → `from "@whatsub/llm-core"`
- `from "./llm/providers"` → `from "@whatsub/llm-core"`
- `from "./utils/normalizeExpression"` → `from "@whatsub/llm-core"`
- `from "./utils/friendlyError"` → `from "@whatsub/llm-core"`

Adjust relative path prefixes (`./` vs `../` vs `../../`) per file location.

- [ ] **Step 3: Delete stale files in client/src/llm/ that are now in llm-core**

Only `modelTiers.ts` + `phonetic.ts` remain. Delete empty `client/src/llm/providers/` directory.

Run: `ls client/src/llm/`
Expected: `modelTiers.ts`, `phonetic.ts` only (plus their .test.ts if any)

- [ ] **Step 4: Verify desktop client builds**

Run: `pnpm --filter client typecheck && pnpm --filter client test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/
git commit -m "refactor(client): consume @whatsub/llm-core + @whatsub/shared-types"
```

---

### Task 5: VocabEntry shallow-merge guarantee in desktop

**Files:**
- Modify: `client/src/store/vocab.ts`
- Create/Modify test: `client/src/store/vocab.test.ts`

Spec §4.1 mandates: when the desktop receives a plugin-written VocabEntry containing `source` / `pageUrl` / `videoUrl`, re-saving must preserve those fields. Current `vocab` upsert may strip unknown fields.

- [ ] **Step 1: Write failing test**

```ts
// client/src/store/vocab.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { useVocabulary } from "./vocab";
import type { VocabEntry } from "@whatsub/shared-types";

describe("vocab upsert preserves unknown fields", () => {
  beforeEach(async () => {
    await useVocabulary.getState().clear();
  });

  it("preserves source / pageUrl when desktop re-saves a plugin-written entry", async () => {
    const incoming: VocabEntry = {
      id: "save up money",
      expression: "save up money",
      meaningZh: "攒钱",
      usage: "",
      videoId: "abc123",
      videoTitle: "Budget tips",
      addedAt: new Date().toISOString(),
      source: "youtube",
      videoUrl: "https://youtu.be/abc123?t=46",
    };
    await useVocabulary.getState().add(incoming);

    // Desktop re-edits meaningZh
    await useVocabulary.getState().add({ ...incoming, meaningZh: "存点钱" });

    const after = useVocabulary.getState().entries.find(e => e.id === "save up money");
    expect(after?.source).toBe("youtube");
    expect(after?.videoUrl).toBe("https://youtu.be/abc123?t=46");
    expect(after?.meaningZh).toBe("存点钱");
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm --filter client test vocab.test.ts`
Expected: FAIL — source/videoUrl undefined after re-save

- [ ] **Step 3: Update upsert to shallow-merge**

Open `client/src/store/vocab.ts`. Find the `add` action. Ensure it does `{ ...existing, ...incoming }` not `incoming` outright:

```ts
add: async (entry: VocabEntry) => {
  set((state) => {
    const idx = state.entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      // Shallow merge so plugin-written fields (source, pageUrl, videoUrl,
      // syncStatus) survive desktop edits — spec §4.1.
      const merged = { ...state.entries[idx], ...entry };
      const next = [...state.entries];
      next[idx] = merged;
      return { entries: next };
    }
    return { entries: [...state.entries, entry] };
  });
  await persistVocab(get().entries);
},
```

- [ ] **Step 4: Re-run test, verify PASS**

Run: `pnpm --filter client test vocab.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/store/vocab.ts client/src/store/vocab.test.ts
git commit -m "fix(vocab): shallow-merge so plugin-written fields survive desktop re-save"
```

---

### Task 6: Plugin scaffold — Vite + crxjs + manifest shell

**Files:**
- Create: `web-plugin/package.json`
- Create: `web-plugin/tsconfig.json`
- Create: `web-plugin/vite.config.ts`
- Create: `web-plugin/src/manifest.ts`
- Create: `web-plugin/tailwind.config.js`
- Create: `web-plugin/postcss.config.js`
- Create: `web-plugin/src/style.css`
- Create: `web-plugin/src/ui/popup/Popup.tsx`
- Create: `web-plugin/src/ui/popup/index.html`
- Create: `web-plugin/src/ui/options/Options.tsx`
- Create: `web-plugin/src/ui/options/index.html`
- Create: `web-plugin/src/sw/index.ts`
- Create: `web-plugin/src/cs/youtube/index.ts`
- Create: `web-plugin/src/cs/web/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "web-plugin",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@whatsub/llm-core": "workspace:*",
    "@whatsub/shared-types": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0",
    "idb": "^8.0.0",
    "lucide-react": "^0.460.0"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0-beta.27",
    "@types/chrome": "^0.0.290",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.0",
    "autoprefixer": "^10.4.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^3.0.0",
    "@testing-library/react": "^16.0.0"
  }
}
```

- [ ] **Step 2: Add tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "lib": ["ES2022", "DOM"],
    "types": ["chrome", "vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create manifest.ts**

```ts
// web-plugin/src/manifest.ts
import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json";

export default defineManifest({
  manifest_version: 3,
  name: "whatsub · YouTube 双语字幕 + AI 标黄",
  version: pkg.version,
  description: "YouTube 双语字幕 + 大模型重点标黄 + 跨网页词汇收藏",
  permissions: ["storage", "alarms", "scripting"],
  host_permissions: [
    "*://*.youtube.com/*",
    "http://127.0.0.1/*",
  ],
  background: {
    service_worker: "src/sw/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["*://*.youtube.com/watch*"],
      js: ["src/cs/youtube/index.ts"],
      run_at: "document_idle",
    },
    {
      matches: ["http://*/*", "https://*/*"],
      exclude_matches: ["*://*.youtube.com/watch*"],
      js: ["src/cs/web/index.ts"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],
  action: { default_popup: "src/ui/popup/index.html" },
  options_ui: { page: "src/ui/options/index.html", open_in_tab: true },
});
```

- [ ] **Step 4: Create vite.config.ts**

```ts
// web-plugin/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
});
```

- [ ] **Step 5: Create Tailwind config with preflight off**

```js
// web-plugin/tailwind.config.js
module.exports = {
  content: ["./src/**/*.{ts,tsx,html}"],
  corePlugins: { preflight: false },  // Shadow DOM compat — spec §3.2
  theme: { extend: {} },
  plugins: [],
};
```

```js
// web-plugin/postcss.config.js
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

```css
/* web-plugin/src/style.css */
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 6: Create skeleton shells**

```tsx
// web-plugin/src/ui/popup/Popup.tsx
export function Popup() {
  return (
    <div className="w-80 p-3 bg-zinc-900 text-zinc-100 text-sm">
      <h1 className="font-semibold">whatsub</h1>
      <p className="text-zinc-400 mt-2">Vocab list arrives in Task 19.</p>
    </div>
  );
}

import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<Popup />);
```

```html
<!-- web-plugin/src/ui/popup/index.html -->
<!doctype html>
<html><head><meta charset="UTF-8"></head>
<body><div id="root"></div><script type="module" src="./Popup.tsx"></script></body>
</html>
```

```tsx
// web-plugin/src/ui/options/Options.tsx
export function Options() {
  return <div className="p-6 bg-zinc-950 text-zinc-100 min-h-screen">Options page · LlmConfig arrives in Task 19.</div>;
}
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<Options />);
```

```html
<!-- web-plugin/src/ui/options/index.html -->
<!doctype html>
<html><head><meta charset="UTF-8"></head>
<body><div id="root"></div><script type="module" src="./Options.tsx"></script></body>
</html>
```

- [ ] **Step 7: Service worker + content script stubs**

```ts
// web-plugin/src/sw/index.ts
console.info("[whatsub] SW alive");
chrome.runtime.onConnect.addListener((port) => {
  console.info("[whatsub] port connected:", port.name);
});
```

```ts
// web-plugin/src/cs/youtube/index.ts
console.info("[whatsub] yt-cs loaded on", location.href);
```

```ts
// web-plugin/src/cs/web/index.ts
console.info("[whatsub] web-cs loaded on", location.href);
```

- [ ] **Step 8: Verify build**

Run: `pnpm --filter web-plugin build`
Expected: `dist/` produced; `dist/manifest.json` has correct content; `dist/src/sw/index.js` exists

- [ ] **Step 9: Verify dev load**

Run: `pnpm --filter web-plugin dev`. In Chrome → `chrome://extensions` → Developer mode → Load unpacked → select `web-plugin/dist`. Should load without errors.

- [ ] **Step 10: Commit**

```bash
git add web-plugin/
git commit -m "feat(plugin): scaffold MV3 extension with Vite + crxjs + Tailwind"
```

---

### Task 7: Contributor ID + settings storage

**Files:**
- Create: `web-plugin/src/util/contributorId.ts`
- Create: `web-plugin/src/util/contributorId.test.ts`
- Create: `web-plugin/src/state/settings.ts`

- [ ] **Step 1: Write failing test**

```ts
// web-plugin/src/util/contributorId.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getOrCreateContributorId } from "./contributorId";

describe("contributorId", () => {
  const storage = new Map<string, unknown>();
  beforeEach(() => {
    storage.clear();
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async (k: string) => ({ [k]: storage.get(k) })),
          set: vi.fn(async (kv: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(kv)) storage.set(k, v);
          }),
        },
      },
    } as unknown as typeof chrome;
  });

  it("returns existing id on second call", async () => {
    const a = await getOrCreateContributorId();
    const b = await getOrCreateContributorId();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-/);
  });

  it("creates new id when none exists", async () => {
    const id = await getOrCreateContributorId();
    expect(id).toBeTruthy();
    expect(storage.get("contributorId")).toBe(id);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm --filter web-plugin test contributorId.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// web-plugin/src/util/contributorId.ts
export async function getOrCreateContributorId(): Promise<string> {
  const { contributorId } = await chrome.storage.local.get("contributorId");
  if (typeof contributorId === "string" && contributorId) return contributorId;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ contributorId: fresh });
  return fresh;
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: same as Step 2
Expected: PASS

- [ ] **Step 5: Implement settings zustand store**

```ts
// web-plugin/src/state/settings.ts
import { create } from "zustand";
import type { Settings } from "@whatsub/shared-types";

export interface PluginSettings {
  llmProvider: "openai-compatible" | "claude" | "gemini";
  openaiCompatible: { apiKey: string; baseUrl: string; model: string };
  claude: { apiKey: string; model: string };
  gemini: { apiKey: string; model: string };
  autoTranslateOnCC: boolean;
  showSidePanelByDefault: boolean;
  highlightStyleAmber: boolean;
  importedFromDesktop?: boolean;
}

const DEFAULTS: PluginSettings = {
  llmProvider: "openai-compatible",
  openaiCompatible: { apiKey: "", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  claude: { apiKey: "", model: "claude-sonnet-4-6" },
  gemini: { apiKey: "", model: "gemini-2.0-flash" },
  autoTranslateOnCC: true,
  showSidePanelByDefault: true,
  highlightStyleAmber: true,
};

interface Store {
  settings: PluginSettings;
  loaded: boolean;
  load: () => Promise<void>;
  save: (next: Partial<PluginSettings>) => Promise<void>;
}

export const useSettings = create<Store>((set, get) => ({
  settings: DEFAULTS,
  loaded: false,
  load: async () => {
    const { settings } = await chrome.storage.local.get("settings");
    set({ settings: { ...DEFAULTS, ...settings }, loaded: true });
  },
  save: async (next) => {
    const merged = { ...get().settings, ...next };
    await chrome.storage.local.set({ settings: merged });
    set({ settings: merged });
  },
}));
```

- [ ] **Step 6: Commit**

```bash
git add web-plugin/src/util/contributorId.ts web-plugin/src/util/contributorId.test.ts web-plugin/src/state/settings.ts
git commit -m "feat(plugin): anonymous contributorId + settings store"
```

---

### Task 8: YouTube timedtext JSON3 parser

**Files:**
- Create: `web-plugin/src/sw/transcripts/parseTimedtextJson3.ts`
- Create: `web-plugin/src/sw/transcripts/parseTimedtextJson3.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// web-plugin/src/sw/transcripts/parseTimedtextJson3.test.ts
import { describe, it, expect } from "vitest";
import { parseTimedtextJson3 } from "./parseTimedtextJson3";

const sample = {
  events: [
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
    { tStartMs: 4000, dDurationMs: 1500, segs: [{ utf8: "Foo" }] },
    { tStartMs: 6000, dDurationMs: 500 },  // no segs → skip
  ],
};

describe("parseTimedtextJson3", () => {
  it("converts events to cues with start/end times in seconds", () => {
    const cues = parseTimedtextJson3(sample);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ idx: 0, time: 1, end: 3, text: "Hello world", tr: "" });
    expect(cues[1]).toEqual({ idx: 1, time: 4, end: 5.5, text: "Foo", tr: "" });
  });

  it("returns empty array when events missing", () => {
    expect(parseTimedtextJson3({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm --filter web-plugin test parseTimedtextJson3.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// web-plugin/src/sw/transcripts/parseTimedtextJson3.ts
export interface Cue {
  idx: number;
  time: number;
  end: number;
  text: string;
  tr: string;
}

export function parseTimedtextJson3(raw: unknown): Cue[] {
  const events = (raw as { events?: unknown[] })?.events;
  if (!Array.isArray(events)) return [];
  const cues: Cue[] = [];
  let idx = 0;
  for (const ev of events) {
    const e = ev as { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] };
    if (!Array.isArray(e.segs)) continue;
    const text = e.segs.map((s) => s.utf8 ?? "").join("").trim();
    if (!text) continue;
    const start = (e.tStartMs ?? 0) / 1000;
    const end = start + (e.dDurationMs ?? 0) / 1000;
    cues.push({ idx: idx++, time: start, end, text, tr: "" });
  }
  return cues;
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add web-plugin/src/sw/transcripts/parseTimedtextJson3.ts web-plugin/src/sw/transcripts/parseTimedtextJson3.test.ts
git commit -m "feat(plugin/transcripts): json3 timedtext parser"
```

---

### Task 9: Caption tracks extractor + CC listener

**Files:**
- Create: `web-plugin/src/cs/youtube/extractCaptionTracks.ts`
- Create: `web-plugin/src/cs/youtube/extractCaptionTracks.test.ts`
- Create: `web-plugin/src/cs/youtube/ccListener.ts`

- [ ] **Step 1: Write failing test for extractor**

```ts
// web-plugin/src/cs/youtube/extractCaptionTracks.test.ts
import { describe, it, expect } from "vitest";
import { extractCaptionTracks } from "./extractCaptionTracks";

const sample = `<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc","languageCode":"en","kind":"asr"}]}}};</script>`;

describe("extractCaptionTracks", () => {
  it("parses captionTracks from ytInitialPlayerResponse string blob", () => {
    const tracks = extractCaptionTracks(sample);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].languageCode).toBe("en");
    expect(tracks[0].baseUrl).toContain("timedtext");
  });

  it("returns empty array when missing", () => {
    expect(extractCaptionTracks("<html></html>")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm --filter web-plugin test extractCaptionTracks.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
// web-plugin/src/cs/youtube/extractCaptionTracks.ts
export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: "asr" | "";
}

export function extractCaptionTracks(html: string): CaptionTrack[] {
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*var/);
  if (!m) return [];
  try {
    const obj = JSON.parse(m[1]);
    const tracks = obj?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks)) return [];
    return tracks.map((t: { baseUrl: string; languageCode: string; kind?: string }) => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode,
      kind: t.kind === "asr" ? "asr" : "",
    }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Implement CC listener (no test — DOM-heavy, manual verify)**

```ts
// web-plugin/src/cs/youtube/ccListener.ts
import { extractCaptionTracks } from "./extractCaptionTracks";

export interface CcEvent {
  kind: "cc-on" | "cc-off";
  videoId: string;
  baseUrl?: string;
  languageCode?: string;
}

export function watchCcToggle(onEvent: (e: CcEvent) => void): () => void {
  let lastMode: TextTrackMode | null = null;

  const tick = () => {
    const video = document.querySelector("video");
    if (!video) return;
    const tracks = Array.from(video.textTracks);
    const showing = tracks.find((t) => t.mode === "showing");
    const mode = showing ? "showing" : "disabled";
    if (mode === lastMode) return;
    lastMode = mode;

    const url = new URL(location.href);
    const videoId = url.searchParams.get("v") ?? "";
    if (mode === "showing") {
      const captionTracks = extractCaptionTracks(document.documentElement.outerHTML);
      const match = captionTracks.find((t) => t.languageCode.startsWith("en")) ?? captionTracks[0];
      onEvent({ kind: "cc-on", videoId, baseUrl: match?.baseUrl, languageCode: match?.languageCode });
    } else {
      onEvent({ kind: "cc-off", videoId });
    }
  };

  const id = setInterval(tick, 500);
  tick();
  return () => clearInterval(id);
}
```

- [ ] **Step 6: Commit**

```bash
git add web-plugin/src/cs/youtube/extractCaptionTracks.ts web-plugin/src/cs/youtube/extractCaptionTracks.test.ts web-plugin/src/cs/youtube/ccListener.ts
git commit -m "feat(plugin/yt): caption tracks extractor + CC toggle listener"
```

---

### Task 10: IndexedDB transcript cache

**Files:**
- Create: `web-plugin/src/sw/transcripts/idb.ts`
- Create: `web-plugin/src/sw/transcripts/idb.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// web-plugin/src/sw/transcripts/idb.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { getTranscript, putTranscript, updateAnalysis } from "./idb";

describe("transcript idb", () => {
  beforeEach(async () => {
    indexedDB.deleteDatabase("whatsub");
  });

  it("round-trips a transcript", async () => {
    await putTranscript({
      videoId: "abc",
      videoTitle: "Test",
      channelId: "",
      durationSec: 600,
      langPair: "en->zh-CN",
      cues: [{ idx: 0, time: 0, end: 1, text: "Hi", tr: "" }],
      fetchedAt: 1000,
    });
    const got = await getTranscript("abc");
    expect(got?.cues[0].text).toBe("Hi");
  });

  it("updates analysis in place", async () => {
    await putTranscript({
      videoId: "abc",
      videoTitle: "Test",
      channelId: "",
      durationSec: 600,
      langPair: "en->zh-CN",
      cues: [{ idx: 0, time: 0, end: 1, text: "Hi", tr: "你好" }],
      fetchedAt: 1000,
    });
    await updateAnalysis("abc", [{ idx: 0, highlightWords: ["Hi"], highlightTranslations: ["你好"], keyNotes: "招呼" }]);
    const got = await getTranscript("abc");
    expect(got?.analysis?.[0].highlightWords).toEqual(["Hi"]);
    expect(got?.analyzedAt).toBeDefined();
  });
});
```

Add dev dep: `pnpm --filter web-plugin add -D fake-indexeddb`.

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm --filter web-plugin test idb.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// web-plugin/src/sw/transcripts/idb.ts
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Cue } from "./parseTimedtextJson3";

export interface TranscriptRow {
  videoId: string;
  videoTitle: string;
  channelId: string;
  durationSec: number;
  langPair: "en->zh-CN";
  cues: Cue[];
  analysis?: Array<{ idx: number; highlightWords: string[]; highlightTranslations: string[]; keyNotes: string }>;
  fetchedAt: number;
  translatedAt?: number;
  analyzedAt?: number;
}

interface Schema extends DBSchema {
  transcripts: { key: string; value: TranscriptRow };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;
function db() {
  return (dbPromise ??= openDB<Schema>("whatsub", 1, {
    upgrade(d) {
      d.createObjectStore("transcripts", { keyPath: "videoId" });
    },
  }));
}

export async function getTranscript(videoId: string): Promise<TranscriptRow | undefined> {
  return (await db()).get("transcripts", videoId);
}

export async function putTranscript(row: TranscriptRow): Promise<void> {
  await (await db()).put("transcripts", row);
}

export async function updateCueTr(videoId: string, idx: number, tr: string): Promise<void> {
  const d = await db();
  const row = await d.get("transcripts", videoId);
  if (!row) return;
  row.cues[idx].tr = tr;
  row.translatedAt = Date.now();
  await d.put("transcripts", row);
}

export async function updateAnalysis(
  videoId: string,
  analysis: TranscriptRow["analysis"]
): Promise<void> {
  const d = await db();
  const row = await d.get("transcripts", videoId);
  if (!row) return;
  row.analysis = analysis;
  row.analyzedAt = Date.now();
  await d.put("transcripts", row);
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add web-plugin/src/sw/transcripts/idb.ts web-plugin/src/sw/transcripts/idb.test.ts web-plugin/package.json
git commit -m "feat(plugin/transcripts): IndexedDB cache via idb"
```

---

### Task 11: SW ↔ CS message protocol via long-lived port

**Files:**
- Create: `web-plugin/src/sw/messaging.ts`
- Create: `web-plugin/src/sw/messaging.test.ts`

- [ ] **Step 1: Write failing test for protocol type guards**

```ts
// web-plugin/src/sw/messaging.test.ts
import { describe, it, expect } from "vitest";
import { isClientMessage, isServerMessage, type ClientMessage } from "./messaging";

describe("port protocol type guards", () => {
  it("accepts well-formed client messages", () => {
    const msg: ClientMessage = { type: "transcribe", videoId: "x", baseUrl: "http://" };
    expect(isClientMessage(msg)).toBe(true);
  });
  it("rejects unknown types", () => {
    expect(isClientMessage({ type: "lol" })).toBe(false);
  });
  it("rejects missing fields", () => {
    expect(isClientMessage({ type: "transcribe" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm --filter web-plugin test messaging.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// web-plugin/src/sw/messaging.ts

export type ClientMessage =
  | { type: "transcribe"; videoId: string; baseUrl: string }
  | { type: "translate-cancel"; videoId: string }
  | { type: "analyze"; videoId: string }
  | { type: "save-vocab"; entry: import("@whatsub/shared-types").VocabEntry }
  | { type: "lookup-expression"; expression: string; cueText: string };

export type ServerMessage =
  | { type: "transcript-ready"; videoId: string; cues: Array<{ idx: number; time: number; end: number; text: string; tr: string }> }
  | { type: "cue-translated"; videoId: string; idx: number; tr: string }
  | { type: "cue-analyzed"; videoId: string; idx: number; highlightWords: string[]; highlightTranslations: string[]; keyNotes: string }
  | { type: "error"; reason: string }
  | { type: "lookup-result"; meaningZh: string; usage: string };

export function isClientMessage(x: unknown): x is ClientMessage {
  if (!x || typeof x !== "object") return false;
  const o = x as { type?: unknown };
  switch (o.type) {
    case "transcribe": return typeof (x as { videoId?: unknown }).videoId === "string" && typeof (x as { baseUrl?: unknown }).baseUrl === "string";
    case "translate-cancel": return typeof (x as { videoId?: unknown }).videoId === "string";
    case "analyze": return typeof (x as { videoId?: unknown }).videoId === "string";
    case "save-vocab": return typeof (x as { entry?: unknown }).entry === "object";
    case "lookup-expression": return typeof (x as { expression?: unknown }).expression === "string";
    default: return false;
  }
}

export function isServerMessage(x: unknown): x is ServerMessage {
  if (!x || typeof x !== "object") return false;
  const t = (x as { type?: unknown }).type;
  return ["transcript-ready", "cue-translated", "cue-analyzed", "error", "lookup-result"].includes(t as string);
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add web-plugin/src/sw/messaging.ts web-plugin/src/sw/messaging.test.ts
git commit -m "feat(plugin/sw): long-lived port protocol types + guards"
```

---

### Task 12: SW streaming translate session

**Files:**
- Create: `web-plugin/src/sw/transcripts/fetchCC.ts`
- Create: `web-plugin/src/sw/transcripts/fetchCC.test.ts`
- Create: `web-plugin/src/sw/transcripts/translate.ts`
- Modify: `web-plugin/src/sw/index.ts`

- [ ] **Step 1: Write failing test for fetchCC**

```ts
// web-plugin/src/sw/transcripts/fetchCC.test.ts
import { describe, it, expect, vi } from "vitest";
import { fetchCcCues } from "./fetchCC";

describe("fetchCcCues", () => {
  it("appends fmt=json3 and parses response", async () => {
    const json3 = { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hi" }] }] };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => json3 });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const cues = await fetchCcCues("https://www.youtube.com/api/timedtext?v=abc&lang=en");
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("fmt=json3"));
    expect(cues).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

- [ ] **Step 3: Implement fetchCC**

```ts
// web-plugin/src/sw/transcripts/fetchCC.ts
import { parseTimedtextJson3, type Cue } from "./parseTimedtextJson3";

export async function fetchCcCues(baseUrl: string): Promise<Cue[]> {
  const u = new URL(baseUrl);
  u.searchParams.set("fmt", "json3");
  const r = await fetch(u.toString());
  if (!r.ok) throw new Error(`timedtext ${r.status}`);
  return parseTimedtextJson3(await r.json());
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Implement streaming translate session**

```ts
// web-plugin/src/sw/transcripts/translate.ts
import { batchSubtitles } from "@whatsub/llm-core";
import type { PluginSettings } from "../../state/settings";
import { fetchCcCues } from "./fetchCC";
import { getTranscript, putTranscript, updateCueTr } from "./idb";

export async function startTranslateSession(
  videoId: string,
  videoTitle: string,
  baseUrl: string,
  settings: PluginSettings,
  onCue: (idx: number, tr: string) => void,
  signal: AbortSignal,
): Promise<void> {
  let row = await getTranscript(videoId);
  if (!row) {
    const cues = await fetchCcCues(baseUrl);
    row = {
      videoId, videoTitle, channelId: "",
      durationSec: cues.at(-1)?.end ?? 0,
      langPair: "en->zh-CN",
      cues,
      fetchedAt: Date.now(),
    };
    await putTranscript(row);
  }

  // Stream-translate cues that have empty tr
  const pending = row.cues.filter((c) => !c.tr);
  if (pending.length === 0) {
    // All cached, replay
    for (const c of row.cues) onCue(c.idx, c.tr);
    return;
  }
  for (const c of row.cues.filter((c) => c.tr)) onCue(c.idx, c.tr);

  await batchSubtitles({
    cues: pending.map((c) => ({ idx: c.idx, text: c.text })),
    settings,
    signal,
    onTranslated: async (idx, tr) => {
      await updateCueTr(videoId, idx, tr);
      onCue(idx, tr);
    },
  });
}
```

Note: `batchSubtitles` API in `@whatsub/llm-core` must expose `{ cues, settings, signal, onTranslated }` shape. If the current export uses a different signature, refactor it as part of this task (one extra commit `refactor(llm-core): expose batchSubtitles streaming callback API`).

- [ ] **Step 6: Wire SW port handler**

```ts
// web-plugin/src/sw/index.ts
import { isClientMessage, type ServerMessage } from "./messaging";
import { startTranslateSession } from "./transcripts/translate";
import { useSettings } from "../state/settings";

const translateControllers = new Map<string, AbortController>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "whatsub") return;
  const send = (msg: ServerMessage) => port.postMessage(msg);

  port.onMessage.addListener(async (raw) => {
    if (!isClientMessage(raw)) return;
    if (raw.type === "transcribe") {
      await useSettings.getState().load();
      const settings = useSettings.getState().settings;
      const ctl = new AbortController();
      translateControllers.set(raw.videoId, ctl);
      try {
        await startTranslateSession(
          raw.videoId, "" /* title filled by CS */, raw.baseUrl, settings,
          (idx, tr) => send({ type: "cue-translated", videoId: raw.videoId, idx, tr }),
          ctl.signal,
        );
      } catch (e) {
        send({ type: "error", reason: String(e) });
      } finally {
        translateControllers.delete(raw.videoId);
      }
    } else if (raw.type === "translate-cancel") {
      translateControllers.get(raw.videoId)?.abort();
    }
  });
});
```

- [ ] **Step 7: Commit**

```bash
git add web-plugin/src/sw/
git commit -m "feat(plugin/sw): streaming subtitle translation via llm-core"
```

---

### Task 13: SW keep-alive heartbeat

**Files:**
- Create: `web-plugin/src/sw/keepAlive.ts`
- Modify: `web-plugin/src/sw/index.ts`

- [ ] **Step 1: Implement**

```ts
// web-plugin/src/sw/keepAlive.ts
/** MV3 service workers are killed after 30s idle. While we hold any
 *  long-lived port (open translation stream), schedule a 25s alarm that
 *  fires a no-op listener — enough activity to keep the SW alive. */
let refCount = 0;

export function acquireKeepAlive(): () => void {
  if (refCount === 0) {
    chrome.alarms.create("keep-alive", { periodInMinutes: 25 / 60 });
  }
  refCount++;
  return () => {
    refCount--;
    if (refCount === 0) chrome.alarms.clear("keep-alive");
  };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keep-alive") {
    // no-op — just the alarm firing counts as activity
  }
});
```

- [ ] **Step 2: Wire into port handler**

In `web-plugin/src/sw/index.ts`, around the port open/close:

```ts
import { acquireKeepAlive } from "./keepAlive";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "whatsub") return;
  const release = acquireKeepAlive();
  port.onDisconnect.addListener(release);
  // ... existing handlers
});
```

- [ ] **Step 3: Commit**

```bash
git add web-plugin/src/sw/keepAlive.ts web-plugin/src/sw/index.ts
git commit -m "feat(plugin/sw): chrome.alarms keep-alive while ports open"
```

---

### Task 14: Side panel React mount + subtitle list

**Files:**
- Create: `web-plugin/src/ui/SidePanel/SidePanel.tsx`
- Create: `web-plugin/src/ui/SidePanel/SubtitleList.tsx`
- Create: `web-plugin/src/ui/SidePanel/SubtitleCue.tsx`
- Create: `web-plugin/src/ui/SidePanel/SubtitleList.test.tsx`
- Create: `web-plugin/src/cs/youtube/sidePanelMount.ts`
- Modify: `web-plugin/src/cs/youtube/index.ts`

- [ ] **Step 1: Write failing test for SubtitleList rendering**

```tsx
// web-plugin/src/ui/SidePanel/SubtitleList.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SubtitleList } from "./SubtitleList";

describe("SubtitleList", () => {
  it("renders English + Chinese for each cue and highlights the active one", () => {
    const cues = [
      { idx: 0, time: 0, end: 1, text: "Hi", tr: "你好" },
      { idx: 1, time: 1, end: 2, text: "Bye", tr: "再见" },
    ];
    const { getAllByTestId, getByTestId } = render(
      <SubtitleList cues={cues} currentTime={1.5} analysis={undefined} onSeek={() => {}} />
    );
    const rows = getAllByTestId(/cue-/);
    expect(rows).toHaveLength(2);
    expect(getByTestId("cue-1").className).toContain("bg-zinc-800");
  });
});
```

- [ ] **Step 2: Run test, verify failure**

- [ ] **Step 3: Implement SubtitleCue**

```tsx
// web-plugin/src/ui/SidePanel/SubtitleCue.tsx
import type { Cue } from "../../sw/transcripts/parseTimedtextJson3";

interface Props {
  cue: Cue;
  active: boolean;
  analysis?: { highlightWords: string[]; highlightTranslations: string[]; keyNotes: string };
  onSeek: (time: number) => void;
}

export function SubtitleCue({ cue, active, analysis, onSeek }: Props) {
  return (
    <div
      data-testid={`cue-${cue.idx}`}
      data-idx={cue.idx}
      onClick={() => onSeek(cue.time)}
      className={
        "px-3 py-2 cursor-pointer text-sm " +
        (active ? "bg-zinc-800 border-l-2 border-blue-400" : "hover:bg-zinc-900")
      }
    >
      <div className="text-zinc-100">{renderHighlights(cue.text, analysis?.highlightWords)}</div>
      {cue.tr && <div className="text-zinc-400 text-xs mt-0.5">{renderHighlights(cue.tr, analysis?.highlightTranslations)}</div>}
    </div>
  );
}

function renderHighlights(text: string, words?: string[]) {
  if (!words?.length) return text;
  // Simple non-overlapping highlight — for production, use a proper offset matcher
  let out: (string | JSX.Element)[] = [text];
  for (const w of words) {
    out = out.flatMap((part, i) => {
      if (typeof part !== "string") return part;
      const segs = part.split(w);
      return segs.flatMap((s, j) => [s, j < segs.length - 1 ? <mark key={`${i}-${j}-${w}`} className="bg-amber-400/30 text-amber-100 rounded px-0.5">{w}</mark> : null]).filter(Boolean) as (string | JSX.Element)[];
    });
  }
  return out;
}
```

- [ ] **Step 4: Implement SubtitleList**

```tsx
// web-plugin/src/ui/SidePanel/SubtitleList.tsx
import { useEffect, useRef } from "react";
import { SubtitleCue } from "./SubtitleCue";
import type { Cue } from "../../sw/transcripts/parseTimedtextJson3";

interface Props {
  cues: Cue[];
  currentTime: number;
  analysis?: Array<{ idx: number; highlightWords: string[]; highlightTranslations: string[]; keyNotes: string }>;
  onSeek: (time: number) => void;
}

export function SubtitleList({ cues, currentTime, analysis, onSeek }: Props) {
  const activeIdx = cues.findIndex((c) => currentTime >= c.time && currentTime < c.end);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeIdx < 0) return;
    const el = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIdx]);

  const analysisMap = new Map(analysis?.map((a) => [a.idx, a]));

  return (
    <div ref={listRef} className="overflow-y-auto h-full">
      {cues.map((c) => (
        <SubtitleCue key={c.idx} cue={c} active={c.idx === activeIdx} analysis={analysisMap.get(c.idx)} onSeek={onSeek} />
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run test, verify PASS**

- [ ] **Step 6: Implement SidePanel root + mount**

```tsx
// web-plugin/src/ui/SidePanel/SidePanel.tsx
import { useEffect, useState } from "react";
import { SubtitleList } from "./SubtitleList";
import type { Cue } from "../../sw/transcripts/parseTimedtextJson3";

export function SidePanel({ videoId, baseUrl }: { videoId: string; baseUrl: string }) {
  const [cues, setCues] = useState<Cue[]>([]);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    const port = chrome.runtime.connect({ name: "whatsub" });
    port.postMessage({ type: "transcribe", videoId, baseUrl });
    port.onMessage.addListener((msg) => {
      if (msg.type === "transcript-ready") setCues(msg.cues);
      if (msg.type === "cue-translated") {
        setCues((prev) => prev.map((c) => (c.idx === msg.idx ? { ...c, tr: msg.tr } : c)));
      }
    });
    return () => port.disconnect();
  }, [videoId, baseUrl]);

  useEffect(() => {
    const v = document.querySelector("video");
    if (!v) return;
    const handler = () => setCurrentTime(v.currentTime);
    v.addEventListener("timeupdate", handler);
    return () => v.removeEventListener("timeupdate", handler);
  }, []);

  const seek = (t: number) => {
    const v = document.querySelector("video") as HTMLVideoElement | null;
    if (v) v.currentTime = t;
  };

  return (
    <div className="h-full flex flex-col bg-zinc-950 text-zinc-100 rounded">
      <div className="px-3 py-2 border-b border-zinc-800 text-xs font-semibold">whatsub · 字幕</div>
      <div className="flex-1 min-h-0">
        <SubtitleList cues={cues} currentTime={currentTime} onSeek={seek} />
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Implement Shadow DOM mount**

```ts
// web-plugin/src/cs/youtube/sidePanelMount.ts
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { SidePanel } from "../../ui/SidePanel/SidePanel";
import styleText from "../../style.css?inline";

let root: Root | null = null;
let host: HTMLElement | null = null;

export function mountSidePanel(videoId: string, baseUrl: string) {
  unmountSidePanel();
  const anchor = document.querySelector("#secondary-inner") || document.querySelector("#secondary");
  if (!anchor) return;

  host = document.createElement("div");
  host.id = "whatsub-side-panel-host";
  host.style.cssText = "all:initial;display:block;margin-bottom:12px;height:480px";
  anchor.prepend(host);

  const shadow = host.attachShadow({ mode: "closed" });
  const styleEl = document.createElement("style");
  styleEl.textContent = styleText;
  shadow.appendChild(styleEl);
  const reactRoot = document.createElement("div");
  reactRoot.style.cssText = "height:100%";
  shadow.appendChild(reactRoot);

  root = createRoot(reactRoot);
  root.render(createElement(SidePanel, { videoId, baseUrl }));
}

export function unmountSidePanel() {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
}
```

- [ ] **Step 8: Wire in yt-cs**

```ts
// web-plugin/src/cs/youtube/index.ts
import { watchCcToggle } from "./ccListener";
import { mountSidePanel, unmountSidePanel } from "./sidePanelMount";

watchCcToggle((ev) => {
  if (ev.kind === "cc-on" && ev.baseUrl) {
    mountSidePanel(ev.videoId, ev.baseUrl);
  } else {
    unmountSidePanel();
  }
});
```

- [ ] **Step 9: Commit**

```bash
git add web-plugin/src/ui/SidePanel/ web-plugin/src/cs/youtube/
git commit -m "feat(plugin/yt): side panel with live subtitle list in shadow DOM"
```

---

### Task 15: Video-bottom bilingual overlay

**Files:**
- Create: `web-plugin/src/ui/Overlay/BottomBilingual.tsx`
- Create: `web-plugin/src/cs/youtube/overlayMount.ts`
- Modify: `web-plugin/src/cs/youtube/index.ts`

- [ ] **Step 1: Implement overlay component**

```tsx
// web-plugin/src/ui/Overlay/BottomBilingual.tsx
import { useEffect, useState } from "react";
import type { Cue } from "../../sw/transcripts/parseTimedtextJson3";

export function BottomBilingual({ cues }: { cues: Cue[] }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const v = document.querySelector("video") as HTMLVideoElement | null;
    if (!v) return;
    const h = () => setT(v.currentTime);
    v.addEventListener("timeupdate", h);
    return () => v.removeEventListener("timeupdate", h);
  }, []);

  const cue = cues.find((c) => t >= c.time && t < c.end);
  if (!cue?.tr) return null;
  return (
    <div className="text-center text-sm bg-black/60 rounded px-3 py-1 text-amber-200 pointer-events-none select-none">
      {cue.tr}
    </div>
  );
}
```

- [ ] **Step 2: Mount above YouTube's caption window**

```ts
// web-plugin/src/cs/youtube/overlayMount.ts
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { BottomBilingual } from "../../ui/Overlay/BottomBilingual";
import styleText from "../../style.css?inline";
import type { Cue } from "../../sw/transcripts/parseTimedtextJson3";

let root: Root | null = null;
let host: HTMLElement | null = null;

export function mountOverlay(cuesRef: { current: Cue[] }) {
  unmountOverlay();
  const player = document.querySelector(".html5-video-player");
  if (!player) return;
  host = document.createElement("div");
  host.id = "whatsub-overlay-host";
  host.style.cssText = "position:absolute;left:0;right:0;bottom:80px;z-index:50;pointer-events:none;display:flex;justify-content:center";
  (player as HTMLElement).appendChild(host);

  const shadow = host.attachShadow({ mode: "closed" });
  const styleEl = document.createElement("style");
  styleEl.textContent = styleText;
  shadow.appendChild(styleEl);
  const reactRoot = document.createElement("div");
  shadow.appendChild(reactRoot);

  root = createRoot(reactRoot);
  // Wrap so cuesRef updates reflow render
  function Wrap() { return <BottomBilingual cues={cuesRef.current} />; }
  root.render(createElement(Wrap));
}

export function unmountOverlay() {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
}
```

- [ ] **Step 3: Share cues between side panel and overlay**

Refactor `sidePanelMount.ts` and `overlayMount.ts` to share a single `cuesRef` (mutable ref object). Update yt-cs entry to maintain that ref and pass to both mounts.

- [ ] **Step 4: Commit**

```bash
git add web-plugin/src/ui/Overlay/ web-plugin/src/cs/youtube/
git commit -m "feat(plugin/yt): bottom bilingual overlay above YT caption window"
```

---

### Task 16: AI 标黄 button + flow

**Files:**
- Create: `web-plugin/src/ui/SidePanel/AnalyzeButton.tsx`
- Create: `web-plugin/src/sw/transcripts/analyze.ts`
- Modify: `web-plugin/src/sw/index.ts` (handle `analyze` message)
- Modify: `web-plugin/src/ui/SidePanel/SidePanel.tsx` (consume analysis)

- [ ] **Step 1: SW handler for analyze**

```ts
// web-plugin/src/sw/transcripts/analyze.ts
import { runAnalysis } from "@whatsub/llm-core";
import type { PluginSettings } from "../../state/settings";
import { getTranscript, updateAnalysis } from "./idb";

export async function startAnalyzeSession(
  videoId: string,
  settings: PluginSettings,
  onCue: (idx: number, hw: string[], ht: string[], keyNotes: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const row = await getTranscript(videoId);
  if (!row) throw new Error("transcript missing");

  if (row.analysis) {
    for (const a of row.analysis) onCue(a.idx, a.highlightWords, a.highlightTranslations, a.keyNotes);
    return;
  }

  const collected: NonNullable<typeof row.analysis> = [];
  await runAnalysis({
    cues: row.cues.map((c) => ({ idx: c.idx, text: c.text, tr: c.tr })),
    settings,
    signal,
    onCue: (idx, hw, ht, keyNotes) => {
      collected.push({ idx, highlightWords: hw, highlightTranslations: ht, keyNotes });
      onCue(idx, hw, ht, keyNotes);
    },
  });
  await updateAnalysis(videoId, collected);
}
```

Note: `runAnalysis` in `@whatsub/llm-core` may need to be renamed / wrapped — verify the export name matches existing `analyze.ts`.

- [ ] **Step 2: Wire SW**

In `web-plugin/src/sw/index.ts`, add to the port message switch:

```ts
} else if (raw.type === "analyze") {
  const ctl = new AbortController();
  // (could track in a separate Map for cancellation)
  await startAnalyzeSession(
    raw.videoId, settings,
    (idx, hw, ht, keyNotes) => send({ type: "cue-analyzed", videoId: raw.videoId, idx, highlightWords: hw, highlightTranslations: ht, keyNotes }),
    ctl.signal,
  );
}
```

- [ ] **Step 3: AnalyzeButton component**

```tsx
// web-plugin/src/ui/SidePanel/AnalyzeButton.tsx
import { useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";

interface Props { onAnalyze: () => void; analyzing: boolean; analyzed: boolean; }
export function AnalyzeButton({ onAnalyze, analyzing, analyzed }: Props) {
  return (
    <button
      type="button"
      disabled={analyzing || analyzed}
      onClick={onAnalyze}
      className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs text-white bg-gradient-to-r from-indigo-500 to-purple-500 disabled:opacity-40"
    >
      {analyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
      {analyzed ? "已标黄" : analyzing ? "解析中" : "AI 标黄"}
    </button>
  );
}
```

- [ ] **Step 4: SidePanel consumes analysis**

Update `SidePanel.tsx` to send `analyze` message on button click, accumulate `cue-analyzed` server messages into a `Map<idx, AnalysisRow>`, and pass to `<SubtitleList analysis={Array.from(...)} />`.

- [ ] **Step 5: Commit**

```bash
git add web-plugin/src/ui/SidePanel/AnalyzeButton.tsx web-plugin/src/sw/
git commit -m "feat(plugin/yt): on-demand AI key-phrase highlighting"
```

---

### Task 17: Selection bubble — universal content script

**Files:**
- Create: `web-plugin/src/ui/Bubble/SelectionBubble.tsx`
- Create: `web-plugin/src/cs/web/contentEditableGuard.ts`
- Create: `web-plugin/src/cs/web/selectionBubble.ts`
- Modify: `web-plugin/src/cs/web/index.ts`

- [ ] **Step 1: Implement contentEditableGuard**

```ts
// web-plugin/src/cs/web/contentEditableGuard.ts
export function isInsideEditable(node: Node | null): boolean {
  let n: Node | null = node;
  while (n) {
    if (n instanceof HTMLElement) {
      if (n.isContentEditable) return true;
      const tag = n.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return true;
    }
    n = n.parentNode;
  }
  return false;
}
```

- [ ] **Step 2: SelectionBubble component (port stripped-down version from desktop client)**

```tsx
// web-plugin/src/ui/Bubble/SelectionBubble.tsx
import { useState } from "react";
import { Sparkles, Star, X } from "lucide-react";
import { normalizeExpression } from "@whatsub/llm-core";

interface Props {
  rect: DOMRect;
  expression: string;
  contextSentence: string;
  source: { kind: "youtube" | "web"; url: string; title: string; cueTime?: number };
  onClose: () => void;
}

export function SelectionBubble({ rect, expression, contextSentence, source, onClose }: Props) {
  const [meaningZh, setMeaningZh] = useState("");
  const [usage, setUsage] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [saved, setSaved] = useState(false);
  const top = Math.max(8, rect.top - 200);
  const left = Math.max(8, rect.left);

  const lookup = async () => {
    setLookingUp(true);
    const port = chrome.runtime.connect({ name: "whatsub" });
    port.postMessage({ type: "lookup-expression", expression: normalizeExpression(expression), cueText: contextSentence });
    port.onMessage.addListener((m) => {
      if (m.type === "lookup-result") {
        setMeaningZh(m.meaningZh); setUsage(m.usage); setLookingUp(false); port.disconnect();
      }
    });
  };
  const save = async () => {
    const port = chrome.runtime.connect({ name: "whatsub" });
    port.postMessage({
      type: "save-vocab",
      entry: {
        id: normalizeExpression(expression).toLowerCase().trim(),
        expression: normalizeExpression(expression),
        meaningZh, usage,
        videoId: source.kind === "youtube" ? new URL(source.url).searchParams.get("v") ?? "" : "",
        videoTitle: source.title,
        addedAt: new Date().toISOString(),
        cueTime: source.cueTime,
        cueText: contextSentence,
        source: source.kind,
        videoUrl: source.kind === "youtube" ? source.url : undefined,
        pageUrl: source.kind === "web" ? source.url : undefined,
        syncStatus: "pending",
      },
    });
    setSaved(true);
    setTimeout(onClose, 600);
  };

  return (
    <div style={{ position: "fixed", top, left, width: 400, zIndex: 2147483647 }}
         className="rounded-lg border border-zinc-700 bg-zinc-900/95 shadow-xl p-2 text-zinc-100">
      <div className="flex items-center gap-2 px-1 pb-1 border-b border-zinc-800">
        <span className="text-sm truncate flex-1">{expression}</span>
        <button onClick={lookup} disabled={lookingUp} className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-indigo-600 disabled:opacity-50">
          <Sparkles className="h-3 w-3" /> AI 查词
        </button>
        <button onClick={save} className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-amber-600">
          <Star className="h-3 w-3 fill-current" /> {saved ? "已收藏" : "收藏"}
        </button>
        <button onClick={onClose}><X className="h-4 w-4 text-zinc-500" /></button>
      </div>
      <textarea value={meaningZh} onChange={(e) => setMeaningZh(e.target.value)} placeholder="中文释义" className="w-full mt-2 px-2 py-1 text-sm bg-zinc-950 border border-zinc-700 rounded" rows={2} />
      <textarea value={usage} onChange={(e) => setUsage(e.target.value)} placeholder="用法" className="w-full mt-1 px-2 py-1 text-sm bg-zinc-950 border border-zinc-700 rounded" rows={2} />
    </div>
  );
}
```

- [ ] **Step 3: Mount logic**

```ts
// web-plugin/src/cs/web/selectionBubble.ts
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { SelectionBubble } from "../../ui/Bubble/SelectionBubble";
import { isInsideEditable } from "./contentEditableGuard";
import styleText from "../../style.css?inline";

let host: HTMLElement | null = null;
let root: Root | null = null;

export function attachSelectionWatcher() {
  document.addEventListener("mouseup", () => setTimeout(handleSelection, 0));
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) close();
  });
}

function handleSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return close();
  const range = sel.getRangeAt(0);
  if (isInsideEditable(range.startContainer) || isInsideEditable(range.endContainer)) return;
  const text = sel.toString().trim();
  if (!text || text.length > 200) return;
  const rect = range.getBoundingClientRect();
  const contextSentence = range.startContainer.parentElement?.textContent?.slice(0, 400) ?? text;
  open(rect, text, contextSentence);
}

function open(rect: DOMRect, expression: string, contextSentence: string) {
  close();
  host = document.createElement("div");
  host.id = "whatsub-bubble-host";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style"); style.textContent = styleText; shadow.appendChild(style);
  const reactRoot = document.createElement("div"); shadow.appendChild(reactRoot);
  root = createRoot(reactRoot);
  const url = location.href;
  const title = document.title;
  root.render(createElement(SelectionBubble, {
    rect, expression, contextSentence,
    source: { kind: "web", url, title },
    onClose: close,
  }));
}

export function close() {
  root?.unmount(); root = null;
  host?.remove(); host = null;
}
```

- [ ] **Step 4: Activate in web-cs**

```ts
// web-plugin/src/cs/web/index.ts
import { attachSelectionWatcher } from "./selectionBubble";
attachSelectionWatcher();
```

- [ ] **Step 5: Commit**

```bash
git add web-plugin/src/ui/Bubble/ web-plugin/src/cs/web/
git commit -m "feat(plugin/web): universal selection bubble with collect + AI lookup"
```

---

### Task 18: SW lookup-expression + save-vocab handlers

**Files:**
- Modify: `web-plugin/src/sw/index.ts`
- Create: `web-plugin/src/sw/vocab.ts`
- Create: `web-plugin/src/sw/vocab.test.ts`

- [ ] **Step 1: Write failing test for vocab store**

```ts
// web-plugin/src/sw/vocab.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { upsertVocab, listVocab } from "./vocab";

describe("vocab store", () => {
  const storage = new Map<string, unknown>();
  beforeEach(() => {
    storage.clear();
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async (k: string) => ({ [k]: storage.get(k) })),
          set: vi.fn(async (kv: Record<string, unknown>) => Object.entries(kv).forEach(([k, v]) => storage.set(k, v))),
        },
      },
    } as unknown as typeof chrome;
  });

  it("dedupes by id", async () => {
    await upsertVocab({ id: "save up", expression: "save up", meaningZh: "", usage: "", videoId: "", videoTitle: "", addedAt: "now", source: "web" });
    await upsertVocab({ id: "save up", expression: "save up", meaningZh: "存", usage: "", videoId: "", videoTitle: "", addedAt: "now2", source: "web" });
    const all = await listVocab();
    expect(all).toHaveLength(1);
    expect(all[0].meaningZh).toBe("存");
  });
});
```

- [ ] **Step 2: Run test, verify failure**

- [ ] **Step 3: Implement vocab store**

```ts
// web-plugin/src/sw/vocab.ts
import type { VocabEntry } from "@whatsub/shared-types";

export async function listVocab(): Promise<VocabEntry[]> {
  const { vocab } = await chrome.storage.local.get("vocab");
  return Array.isArray(vocab) ? vocab : [];
}

export async function upsertVocab(entry: VocabEntry): Promise<void> {
  const all = await listVocab();
  const idx = all.findIndex((v) => v.id === entry.id);
  if (idx >= 0) all[idx] = { ...all[idx], ...entry };
  else all.push(entry);
  await chrome.storage.local.set({ vocab: all });
}

export async function removeVocab(id: string): Promise<void> {
  const all = await listVocab();
  await chrome.storage.local.set({ vocab: all.filter((v) => v.id !== id) });
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Wire SW handlers**

In `web-plugin/src/sw/index.ts`, add to the port message switch:

```ts
} else if (raw.type === "save-vocab") {
  await upsertVocab(raw.entry);
  // Push to sync queue (Task 24 implements queue)
  // enqueueSyncItem({ kind: "vocab", payload: raw.entry, queuedAt: Date.now(), retries: 0 });
  send({ type: "saved", id: raw.entry.id } as unknown as ServerMessage);
} else if (raw.type === "lookup-expression") {
  const result = await lookupExpression(raw.expression, raw.cueText, settings, new AbortController().signal);
  send({ type: "lookup-result", meaningZh: result.meaningZh, usage: result.usage });
}
```

Import `lookupExpression` from `@whatsub/llm-core`.

- [ ] **Step 6: Commit**

```bash
git add web-plugin/src/sw/vocab.ts web-plugin/src/sw/vocab.test.ts web-plugin/src/sw/index.ts
git commit -m "feat(plugin/sw): vocab store + lookup-expression message handlers"
```

---

### Task 19: Popup vocab list

**Files:**
- Modify: `web-plugin/src/ui/popup/Popup.tsx`
- Create: `web-plugin/src/ui/popup/VocabCard.tsx`
- Create: `web-plugin/src/state/vocab.ts`

- [ ] **Step 1: Vocab zustand store**

```ts
// web-plugin/src/state/vocab.ts
import { create } from "zustand";
import type { VocabEntry } from "@whatsub/shared-types";

interface Store {
  entries: VocabEntry[];
  loaded: boolean;
  reload: () => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useVocab = create<Store>((set) => ({
  entries: [],
  loaded: false,
  reload: async () => {
    const { vocab } = await chrome.storage.local.get("vocab");
    set({ entries: Array.isArray(vocab) ? vocab : [], loaded: true });
  },
  remove: async (id) => {
    const { vocab } = await chrome.storage.local.get("vocab");
    const next = (Array.isArray(vocab) ? vocab : []).filter((v: VocabEntry) => v.id !== id);
    await chrome.storage.local.set({ vocab: next });
    set({ entries: next });
  },
}));
```

- [ ] **Step 2: VocabCard component**

```tsx
// web-plugin/src/ui/popup/VocabCard.tsx
import type { VocabEntry } from "@whatsub/shared-types";
import { Trash2 } from "lucide-react";

export function VocabCard({ entry, onRemove }: { entry: VocabEntry; onRemove: () => void }) {
  const href = entry.videoUrl ?? entry.pageUrl ?? "#";
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/50 p-2 group">
      <div className="flex items-center gap-2">
        <a href={href} target="_blank" rel="noreferrer" className="text-amber-300 text-sm font-semibold truncate flex-1">{entry.expression}</a>
        <button onClick={onRemove} className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400">
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      {entry.meaningZh && <div className="text-zinc-200 text-xs mt-1">{entry.meaningZh}</div>}
      {entry.videoTitle && <div className="text-zinc-500 text-[10px] mt-1 truncate">来自：{entry.videoTitle}</div>}
    </div>
  );
}
```

- [ ] **Step 3: Popup uses store + card list**

```tsx
// web-plugin/src/ui/popup/Popup.tsx
import { useEffect } from "react";
import { useVocab } from "../../state/vocab";
import { VocabCard } from "./VocabCard";

export function Popup() {
  const { entries, loaded, reload, remove } = useVocab();
  useEffect(() => { if (!loaded) void reload(); }, [loaded, reload]);
  return (
    <div className="w-96 max-h-[600px] overflow-y-auto p-3 bg-zinc-950 text-zinc-100">
      <h1 className="text-sm font-semibold mb-2">我的词汇本 · {entries.length} 条</h1>
      <div className="space-y-2">
        {entries.length === 0 && <p className="text-zinc-500 text-xs">还没收藏，去 YouTube 或任意网页划词收藏吧</p>}
        {entries.map((e) => <VocabCard key={e.id} entry={e} onRemove={() => void remove(e.id)} />)}
      </div>
    </div>
  );
}

import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<Popup />);
```

- [ ] **Step 4: Commit**

```bash
git add web-plugin/src/ui/popup/ web-plugin/src/state/vocab.ts
git commit -m "feat(plugin/popup): vocab list with delete + deep link"
```

---

### Task 20: Desktop bridge — Rust scaffold + dependencies

**Files:**
- Modify: `client/src-tauri/Cargo.toml`
- Create: `client/src-tauri/src/bridge/mod.rs`
- Create: `client/src-tauri/src/bridge/port.rs`
- Create: `client/src-tauri/src/bridge/server.rs`
- Create: `client/src-tauri/src/bridge/routes.rs`
- Modify: `client/src-tauri/src/lib.rs`

- [ ] **Step 1: Add deps to Cargo.toml**

Append under `[dependencies]`:

```toml
actix-web = "4.9"
actix-cors = "0.7"
tokio = { version = "1.42", features = ["macros", "rt-multi-thread", "sync"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 2: Create bridge module skeleton**

```rust
// client/src-tauri/src/bridge/mod.rs
pub mod port;
pub mod server;
pub mod routes;

use tauri::AppHandle;

pub fn start_bridge(app: AppHandle) {
    tokio::spawn(async move {
        if let Err(e) = server::run(app).await {
            eprintln!("[whatsub-bridge] server stopped: {e}");
        }
    });
}
```

- [ ] **Step 3: Port discovery**

```rust
// client/src-tauri/src/bridge/port.rs
use std::net::{SocketAddr, TcpListener};

/// IANA Dynamic/Private range, sparse — see spec §6.1.
pub const BRIDGE_PORTS: &[u16] = &[51737, 53401, 59283, 62015];

/// Try each candidate in order; return (port, listener) for the first one that binds.
pub fn bind_loopback() -> Option<(u16, TcpListener)> {
    for &p in BRIDGE_PORTS {
        let addr: SocketAddr = ([127, 0, 0, 1], p).into();
        if let Ok(l) = TcpListener::bind(addr) {
            l.set_nonblocking(true).ok()?;
            return Some((p, l));
        }
    }
    None
}
```

- [ ] **Step 4: Stub server.rs**

```rust
// client/src-tauri/src/bridge/server.rs
use actix_web::{App, HttpServer};
use actix_cors::Cors;
use tauri::AppHandle;
use std::io;
use super::{port, routes};

pub async fn run(app: AppHandle) -> io::Result<()> {
    let (chosen, listener) = match port::bind_loopback() {
        Some(x) => x,
        None => {
            eprintln!("[whatsub-bridge] no free port — all 4 candidates busy. Skipping bridge.");
            return Ok(());
        }
    };
    println!("[whatsub-bridge] listening on 127.0.0.1:{chosen}");
    let data = actix_web::web::Data::new(app);
    HttpServer::new(move || {
        let cors = Cors::default()
            .allowed_origin_fn(|origin, _| {
                origin.as_bytes().starts_with(b"chrome-extension://")
                    || origin.as_bytes().starts_with(b"moz-extension://")
            })
            .allowed_methods(vec!["GET", "POST", "DELETE"])
            .allow_any_header()
            .max_age(600);
        App::new()
            .app_data(data.clone())
            .wrap(cors)
            .configure(routes::configure)
    })
    .listen(listener)?
    .run()
    .await
}
```

- [ ] **Step 5: Stub routes**

```rust
// client/src-tauri/src/bridge/routes.rs
use actix_web::{web, HttpResponse, Responder};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/ping").to(ping));
}

#[derive(Serialize)]
struct Ping { service: &'static str, version: String, desktop_version: String }

async fn ping(app: web::Data<AppHandle>) -> impl Responder {
    HttpResponse::Ok().json(Ping {
        service: "whatsub-bridge",
        version: env!("CARGO_PKG_VERSION").to_string(),
        desktop_version: app.config().package.version.clone().unwrap_or_default(),
    })
}
```

- [ ] **Step 6: Wire bridge into Tauri setup**

In `client/src-tauri/src/lib.rs`, find `setup` closure and add:

```rust
mod bridge;
// inside Builder::default().setup(|app| { ... }):
bridge::start_bridge(app.handle().clone());
```

- [ ] **Step 7: Run client + verify /ping**

Run: `pnpm --filter client tauri dev` (terminal A). In terminal B:

```bash
for port in 51737 53401 59283 62015; do
  curl -s --max-time 1 "http://127.0.0.1:$port/ping" && echo
done
```

Expected: one of the four returns `{"service":"whatsub-bridge",...}`.

- [ ] **Step 8: Commit**

```bash
git add client/src-tauri/Cargo.toml client/src-tauri/src/bridge/ client/src-tauri/src/lib.rs
git commit -m "feat(bridge): localhost HTTP server with port-race discovery + /ping"
```

---

### Task 21: Bridge — /vocab + /vocab/batch routes

**Files:**
- Modify: `client/src-tauri/src/bridge/routes.rs`
- Modify: `client/src-tauri/src/commands/vocabulary.rs` (or wherever vocab persistence lives — verify path)

- [ ] **Step 1: Add route handlers**

```rust
// client/src-tauri/src/bridge/routes.rs (extension)
use crate::commands::vocabulary::vocab_upsert;
use whatsub_shared::VocabEntry;  // or define inline if no shared crate yet

#[derive(Deserialize)]
struct VocabBatch { items: Vec<VocabEntry> }

#[derive(Serialize)]
struct UpsertResult { ok: bool, id: String, reason: Option<String> }

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/ping").to(ping))
       .service(web::resource("/vocab").route(web::post().to(post_vocab)).route(web::get().to(get_vocab)))
       .service(web::resource("/vocab/batch").route(web::post().to(post_vocab_batch)));
}

async fn post_vocab(app: web::Data<AppHandle>, body: web::Json<VocabEntry>) -> impl Responder {
    match vocab_upsert(&app, body.into_inner()).await {
        Ok(id) => HttpResponse::Created().json(UpsertResult { ok: true, id, reason: None }),
        Err(e) => HttpResponse::BadRequest().json(UpsertResult { ok: false, id: String::new(), reason: Some(e.to_string()) }),
    }
}

async fn post_vocab_batch(app: web::Data<AppHandle>, body: web::Json<VocabBatch>) -> impl Responder {
    let mut results = Vec::new();
    for entry in body.into_inner().items {
        let id = entry.id.clone();
        results.push(match vocab_upsert(&app, entry).await {
            Ok(_) => UpsertResult { ok: true, id, reason: None },
            Err(e) => UpsertResult { ok: false, id, reason: Some(e.to_string()) },
        });
    }
    HttpResponse::Ok().json(serde_json::json!({ "results": results }))
}

async fn get_vocab(app: web::Data<AppHandle>) -> impl Responder {
    match crate::commands::vocabulary::vocab_list(&app).await {
        Ok(entries) => HttpResponse::Ok().json(serde_json::json!({ "entries": entries })),
        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),
    }
}
```

- [ ] **Step 2: Ensure vocab_upsert exists on Rust side and shallow-merges**

Open `client/src-tauri/src/commands/vocabulary.rs`. The Rust-side persistence must implement the same shallow-merge guarantee as Task 5. If the function doesn't exist, add a non-#[command] wrapper for bridge internal use:

```rust
pub async fn vocab_upsert(app: &AppHandle, entry: VocabEntry) -> Result<String, String> {
    let mut all = load_vocab_from_disk(app)?;
    if let Some(existing) = all.iter_mut().find(|e| e.id == entry.id) {
        // Shallow merge: incoming fields take precedence but unknown fields preserved
        existing.merge_from(&entry);
    } else {
        all.push(entry.clone());
    }
    save_vocab_to_disk(app, &all)?;
    Ok(entry.id)
}
```

- [ ] **Step 3: Manual integration test**

```bash
curl -X POST -H "Content-Type: application/json" \
  -H "Origin: chrome-extension://test" \
  -d '{"id":"test phrase","expression":"test phrase","meaningZh":"","usage":"","videoId":"","videoTitle":"","addedAt":"2026-05-17T00:00:00Z","source":"web","pageUrl":"https://example.com"}' \
  http://127.0.0.1:<port>/vocab
```

Expected: `201 {"ok":true,"id":"test phrase","reason":null}`. Verify entry appears in `%APPDATA%/whatsub/vocabulary.json` with source + pageUrl preserved.

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src/bridge/routes.rs client/src-tauri/src/commands/vocabulary.rs
git commit -m "feat(bridge): /vocab POST + /vocab/batch with shallow-merge upsert"
```

---

### Task 22: Bridge — /settings/llm + handoff with native confirm

**Files:**
- Modify: `client/src-tauri/src/bridge/routes.rs`
- Create: `client/src-tauri/src/bridge/handoff.rs`

- [ ] **Step 1: Read-only /settings/llm route**

```rust
// addition in routes.rs
cfg.service(web::resource("/settings/llm").route(web::get().to(get_settings_llm)));

async fn get_settings_llm(app: web::Data<AppHandle>) -> impl Responder {
    let s = crate::commands::settings::settings_load(&app).await;
    match s {
        Ok(s) => HttpResponse::Ok().json(serde_json::json!({
            "provider": s.llm_provider,
            "model": s.current_model(),
            "baseUrl": s.current_base_url(),
        })),
        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),
    }
}
```

- [ ] **Step 2: Handoff with native confirmation**

```rust
// client/src-tauri/src/bridge/handoff.rs
use tauri::AppHandle;
use tokio::sync::oneshot;
use std::time::Duration;

pub async fn request_handoff(app: &AppHandle, extension_id: &str) -> Result<bool, String> {
    let (tx, rx) = oneshot::channel();
    let title = "插件请求继承翻译配置";
    let body = format!("浏览器插件 (id: {}) 请求一次性读取你的 LLM 配置（含 API Key）。同意吗？", extension_id);
    tauri::async_runtime::spawn(async move {
        // Plugin: dialog from tauri_plugin_dialog (already used by client)
        // Returns Ok(true) on 同意, Ok(false) on 拒绝
        let _ = tx;
    });
    // Spawn dialog using tauri_plugin_dialog::DialogExt; capture user reply through oneshot
    // (Implementation note: tauri_plugin_dialog::ask is async; wire it as:
    //   let answer = tauri_plugin_dialog::DialogExt::dialog(app).message(body).title(title).buttons(...).blocking_show();
    //   tx.send(answer == YES).ok();
    // ) — adapt to the exact API in our pinned plugin version.
    match tokio::time::timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(yes)) => Ok(yes),
        Ok(Err(_)) | Err(_) => Ok(false),
    }
}
```

- [ ] **Step 3: POST /settings/llm/handoff**

```rust
// in routes.rs
#[derive(Deserialize)]
struct HandoffReq { extension_id: String }

cfg.service(web::resource("/settings/llm/handoff").route(web::post().to(post_handoff)));

async fn post_handoff(app: web::Data<AppHandle>, body: web::Json<HandoffReq>) -> impl Responder {
    let ok = handoff::request_handoff(&app, &body.extension_id).await.unwrap_or(false);
    if !ok {
        return HttpResponse::Forbidden().json(serde_json::json!({ "ok": false, "reason": "user_declined" }));
    }
    let s = match crate::commands::settings::settings_load(&app).await {
        Ok(s) => s,
        Err(e) => return HttpResponse::InternalServerError().body(e.to_string()),
    };
    HttpResponse::Ok().json(serde_json::json!({
        "provider": s.llm_provider,
        "model": s.current_model(),
        "baseUrl": s.current_base_url(),
        "apiKey": s.current_api_key(),
    }))
}
```

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src/bridge/
git commit -m "feat(bridge): /settings/llm read + /settings/llm/handoff with native confirm"
```

---

### Task 23: Bridge integration tests (Rust)

**Files:**
- Create: `client/src-tauri/tests/bridge_integration.rs`

- [ ] **Step 1: Write test that boots the actix server on a random port**

```rust
// client/src-tauri/tests/bridge_integration.rs
use actix_web::{test, App};
use serde_json::Value;
use std::env;

// Re-export the configure fn to test without spawning Tauri runtime
#[actix_web::test]
async fn ping_returns_banner() {
    let app = test::init_service(
        App::new().configure(whatsub::bridge::routes::configure)
    ).await;
    let req = test::TestRequest::get().uri("/ping").to_request();
    let resp: Value = test::call_and_read_body_json(&app, req).await;
    assert_eq!(resp["service"], "whatsub-bridge");
}

#[actix_web::test]
async fn cors_rejects_non_extension_origin() {
    let app = test::init_service(
        App::new().wrap(/* same cors layer */).configure(whatsub::bridge::routes::configure)
    ).await;
    let req = test::TestRequest::get().uri("/ping").insert_header(("Origin", "https://evil.com")).to_request();
    let resp = test::call_service(&app, req).await;
    // CORS preflight or response should not include Access-Control-Allow-Origin echoing evil.com
    assert!(resp.headers().get("access-control-allow-origin").map(|v| v.as_bytes() != b"https://evil.com").unwrap_or(true));
}
```

Run: `cd client/src-tauri && cargo test bridge_integration`
Expected: PASS

- [ ] **Step 2: Commit**

```bash
git add client/src-tauri/tests/bridge_integration.rs
git commit -m "test(bridge): ping + CORS rejection of non-extension origins"
```

---

### Task 24: Plugin sync queue + retry

**Files:**
- Create: `web-plugin/src/sw/syncQueue.ts`
- Create: `web-plugin/src/sw/syncQueue.test.ts`
- Modify: `web-plugin/src/sw/index.ts`

- [ ] **Step 1: Write failing test**

```ts
// web-plugin/src/sw/syncQueue.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { enqueue, drain, peek } from "./syncQueue";

describe("syncQueue", () => {
  const storage = new Map<string, unknown>();
  beforeEach(() => {
    storage.clear();
    globalThis.chrome = {
      storage: { local: {
        get: vi.fn(async (k: string) => ({ [k]: storage.get(k) })),
        set: vi.fn(async (kv: Record<string, unknown>) => Object.entries(kv).forEach(([k, v]) => storage.set(k, v))),
      } },
    } as unknown as typeof chrome;
  });

  it("enqueues and drains in FIFO order", async () => {
    await enqueue({ kind: "vocab", payload: { id: "a" } as any, queuedAt: 1, retries: 0 });
    await enqueue({ kind: "vocab", payload: { id: "b" } as any, queuedAt: 2, retries: 0 });
    expect((await peek()).map((i) => i.payload.id)).toEqual(["a", "b"]);
    await drain(2);
    expect(await peek()).toEqual([]);
  });

  it("evicts oldest when over 1000 items", async () => {
    for (let i = 0; i < 1010; i++) await enqueue({ kind: "vocab", payload: { id: `${i}` } as any, queuedAt: i, retries: 0 });
    const all = await peek();
    expect(all.length).toBe(1000);
    expect(all[0].payload.id).toBe("10");
  });
});
```

- [ ] **Step 2: Run test, verify failure**

- [ ] **Step 3: Implement**

```ts
// web-plugin/src/sw/syncQueue.ts
import type { VocabEntry, CorpusEntry } from "@whatsub/shared-types";

export interface SyncQueueItem {
  kind: "vocab" | "corpus";
  payload: VocabEntry | CorpusEntry;
  queuedAt: number;
  retries: number;
}

const MAX_QUEUE = 1000;

export async function peek(): Promise<SyncQueueItem[]> {
  const { syncQueue } = await chrome.storage.local.get("syncQueue");
  return Array.isArray(syncQueue) ? syncQueue : [];
}

export async function enqueue(item: SyncQueueItem): Promise<void> {
  const q = await peek();
  q.push(item);
  // Evict oldest if over limit
  while (q.length > MAX_QUEUE) q.shift();
  await chrome.storage.local.set({ syncQueue: q });
}

export async function drain(n: number): Promise<SyncQueueItem[]> {
  const q = await peek();
  const head = q.splice(0, n);
  await chrome.storage.local.set({ syncQueue: q });
  return head;
}

export async function requeue(items: SyncQueueItem[]): Promise<void> {
  for (const item of items) item.retries += 1;
  const q = await peek();
  await chrome.storage.local.set({ syncQueue: [...items.filter((i) => i.retries < 5), ...q] });
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add web-plugin/src/sw/syncQueue.ts web-plugin/src/sw/syncQueue.test.ts
git commit -m "feat(plugin/sw): persistent sync queue with FIFO + eviction"
```

---

### Task 25: Bridge discovery + replay loop

**Files:**
- Create: `web-plugin/src/sw/bridge/discover.ts`
- Create: `web-plugin/src/sw/bridge/discover.test.ts`
- Create: `web-plugin/src/sw/bridge/client.ts`
- Modify: `web-plugin/src/sw/index.ts`

- [ ] **Step 1: Write failing test for port race**

```ts
// web-plugin/src/sw/bridge/discover.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { discoverBridge } from "./discover";

describe("discoverBridge", () => {
  beforeEach(() => {
    globalThis.chrome = {
      storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    } as unknown as typeof chrome;
  });

  it("returns the first port that responds with banner", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("53401")) {
        return Promise.resolve({ ok: true, json: async () => ({ service: "whatsub-bridge" }) });
      }
      return Promise.reject(new Error("ECONN"));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const port = await discoverBridge();
    expect(port).toBe(53401);
  });

  it("returns null when no port responds", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONN")) as unknown as typeof fetch;
    const port = await discoverBridge();
    expect(port).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

- [ ] **Step 3: Implement discover**

```ts
// web-plugin/src/sw/bridge/discover.ts
import { BRIDGE_PORTS } from "@whatsub/shared-types";

const CACHE_KEY = "bridgePort";
const CACHE_TTL_MS = 60_000;

interface Cached { port: number | null; checkedAt: number }

export async function discoverBridge(): Promise<number | null> {
  const { [CACHE_KEY]: cached } = await chrome.storage.session.get(CACHE_KEY);
  if (cached && Date.now() - (cached as Cached).checkedAt < CACHE_TTL_MS) {
    return (cached as Cached).port;
  }
  const probes = BRIDGE_PORTS.map(async (p) => {
    try {
      const r = await Promise.race([
        fetch(`http://127.0.0.1:${p}/ping`),
        new Promise<Response>((_, rj) => setTimeout(() => rj(new Error("timeout")), 500)),
      ]);
      if (!r.ok) throw new Error("not ok");
      const j = await r.json();
      if (j?.service !== "whatsub-bridge") throw new Error("wrong service");
      return p;
    } catch { return null; }
  });
  const results = await Promise.all(probes);
  const port = results.find((p) => p !== null) ?? null;
  await chrome.storage.session.set({ [CACHE_KEY]: { port, checkedAt: Date.now() } });
  return port;
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Client API helpers**

```ts
// web-plugin/src/sw/bridge/client.ts
import type { VocabEntry, CorpusEntry } from "@whatsub/shared-types";

export async function postVocab(port: number, entry: VocabEntry, extId: string): Promise<boolean> {
  const r = await fetch(`http://127.0.0.1:${port}/vocab`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": `chrome-extension://${extId}` },
    body: JSON.stringify(entry),
  });
  return r.ok;
}

export async function postVocabBatch(port: number, items: VocabEntry[], extId: string): Promise<{ ok: boolean }[]> {
  const r = await fetch(`http://127.0.0.1:${port}/vocab/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": `chrome-extension://${extId}` },
    body: JSON.stringify({ items }),
  });
  if (!r.ok) return items.map(() => ({ ok: false }));
  const j = await r.json();
  return j.results;
}
```

- [ ] **Step 6: Replay loop in SW**

In `web-plugin/src/sw/index.ts`:

```ts
import { discoverBridge } from "./bridge/discover";
import { postVocabBatch } from "./bridge/client";
import { drain, peek, requeue } from "./syncQueue";

async function tryDrain() {
  const port = await discoverBridge();
  if (port === null) return;
  const queued = await peek();
  if (queued.length === 0) return;
  const batch = await drain(100);
  const vocabItems = batch.filter((i) => i.kind === "vocab").map((i) => i.payload as VocabEntry);
  const extId = chrome.runtime.id;
  const results = await postVocabBatch(port, vocabItems, extId);
  // Failed items go back into queue
  const failed = batch.filter((_, i) => !results[i]?.ok);
  await requeue(failed);
}

chrome.alarms.create("sync-drain", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "sync-drain") void tryDrain(); });
```

- [ ] **Step 7: Commit**

```bash
git add web-plugin/src/sw/bridge/ web-plugin/src/sw/index.ts
git commit -m "feat(plugin/sw): bridge discovery + sync-queue replay loop"
```

---

### Task 26: Bridge status indicator

**Files:**
- Create: `web-plugin/src/state/bridge.ts`
- Create: `web-plugin/src/ui/SidePanel/StatusPill.tsx`
- Modify: `web-plugin/src/ui/popup/Popup.tsx` (add pill)
- Modify: `web-plugin/src/sw/index.ts` (broadcast status changes)

- [ ] **Step 1: Bridge zustand store**

```ts
// web-plugin/src/state/bridge.ts
import { create } from "zustand";
import { peek } from "../sw/syncQueue";
import { discoverBridge } from "../sw/bridge/discover";

export type BridgeState = "connected" | "queued" | "offline";

interface Store {
  state: BridgeState;
  pending: number;
  refresh: () => Promise<void>;
}

export const useBridge = create<Store>((set) => ({
  state: "offline",
  pending: 0,
  refresh: async () => {
    const port = await discoverBridge();
    const queue = await peek();
    if (port !== null) set({ state: "connected", pending: queue.length });
    else if (queue.length > 0) set({ state: "queued", pending: queue.length });
    else set({ state: "offline", pending: 0 });
  },
}));
```

- [ ] **Step 2: Status pill**

```tsx
// web-plugin/src/ui/SidePanel/StatusPill.tsx
import { useEffect } from "react";
import { useBridge, type BridgeState } from "../../state/bridge";

const LABEL: Record<BridgeState, string> = {
  connected: "桌面端已连接",
  queued: "条待同步",
  offline: "仅插件",
};
const DOT: Record<BridgeState, string> = {
  connected: "bg-emerald-400 shadow-[0_0_6px_#5fc97a]",
  queued: "bg-amber-400",
  offline: "bg-zinc-500",
};

export function StatusPill() {
  const { state, pending, refresh } = useBridge();
  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, state === "connected" ? 5000 : 60000);
    return () => clearInterval(id);
  }, [state, refresh]);
  return (
    <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] bg-zinc-900 border border-zinc-700">
      <span className={`w-1.5 h-1.5 rounded-full ${DOT[state]}`} />
      <span className="text-zinc-300">
        {state === "queued" ? `${pending} ${LABEL.queued}` : LABEL[state]}
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Render pill in popup header**

In `Popup.tsx`, place `<StatusPill />` next to the h1.

- [ ] **Step 4: Commit**

```bash
git add web-plugin/src/state/bridge.ts web-plugin/src/ui/SidePanel/StatusPill.tsx web-plugin/src/ui/popup/Popup.tsx
git commit -m "feat(plugin/ui): 3-state bridge status pill"
```

---

### Task 27: Options page LLM config + handoff button

**Files:**
- Create: `web-plugin/src/ui/options/LlmConfig.tsx`
- Create: `web-plugin/src/ui/options/HandoffButton.tsx`
- Modify: `web-plugin/src/ui/options/Options.tsx`

- [ ] **Step 1: LlmConfig form**

```tsx
// web-plugin/src/ui/options/LlmConfig.tsx
import { useSettings } from "../../state/settings";
import { useEffect } from "react";

export function LlmConfig() {
  const { settings, loaded, load, save } = useSettings();
  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);

  const updateOAI = (k: "apiKey" | "baseUrl" | "model", v: string) =>
    save({ openaiCompatible: { ...settings.openaiCompatible, [k]: v } });

  return (
    <section className="space-y-3 max-w-xl">
      <h2 className="font-semibold">LLM 翻译配置</h2>
      <label className="block text-sm">
        厂商
        <select value={settings.llmProvider} onChange={(e) => save({ llmProvider: e.target.value as any })}
                className="block w-full mt-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1">
          <option value="openai-compatible">OpenAI 兼容（DeepSeek / Kimi / Qwen ...）</option>
          <option value="claude">Claude</option>
          <option value="gemini">Gemini</option>
        </select>
      </label>
      {settings.llmProvider === "openai-compatible" && (
        <>
          <label className="block text-sm">Base URL
            <input value={settings.openaiCompatible.baseUrl} onChange={(e) => updateOAI("baseUrl", e.target.value)}
                   className="block w-full mt-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1" />
          </label>
          <label className="block text-sm">API Key
            <input type="password" value={settings.openaiCompatible.apiKey} onChange={(e) => updateOAI("apiKey", e.target.value)}
                   className="block w-full mt-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1" />
          </label>
          <label className="block text-sm">Model
            <input value={settings.openaiCompatible.model} onChange={(e) => updateOAI("model", e.target.value)}
                   className="block w-full mt-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1" />
          </label>
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Handoff button**

```tsx
// web-plugin/src/ui/options/HandoffButton.tsx
import { useState } from "react";
import { useSettings } from "../../state/settings";
import { discoverBridge } from "../../sw/bridge/discover";

export function HandoffButton() {
  const { settings, save } = useSettings();
  const [status, setStatus] = useState<"idle" | "asking" | "done" | "declined" | "no-bridge">("idle");

  const handoff = async () => {
    setStatus("asking");
    const port = await discoverBridge();
    if (port === null) { setStatus("no-bridge"); return; }
    const r = await fetch(`http://127.0.0.1:${port}/settings/llm/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extension_id: chrome.runtime.id }),
    });
    if (!r.ok) { setStatus("declined"); return; }
    const { provider, baseUrl, apiKey, model } = await r.json();
    await save({
      llmProvider: provider,
      openaiCompatible: { ...settings.openaiCompatible, baseUrl, apiKey, model },
      importedFromDesktop: true,
    });
    setStatus("done");
  };

  return (
    <div>
      <button onClick={handoff} disabled={status === "asking" || settings.importedFromDesktop}
              className="px-3 py-1.5 rounded bg-blue-600 text-sm disabled:opacity-50">
        {settings.importedFromDesktop ? "已继承桌面端配置" : "一键继承桌面端配置"}
      </button>
      {status === "asking" && <p className="text-xs text-zinc-400 mt-1">请在桌面端确认...</p>}
      {status === "declined" && <p className="text-xs text-red-400 mt-1">桌面端拒绝或超时</p>}
      {status === "no-bridge" && <p className="text-xs text-amber-400 mt-1">未检测到桌面端运行</p>}
      {status === "done" && <p className="text-xs text-emerald-400 mt-1">已继承</p>}
    </div>
  );
}
```

- [ ] **Step 3: Wire into Options**

```tsx
// web-plugin/src/ui/options/Options.tsx
import { LlmConfig } from "./LlmConfig";
import { HandoffButton } from "./HandoffButton";

export function Options() {
  return (
    <div className="p-6 bg-zinc-950 text-zinc-100 min-h-screen space-y-6">
      <h1 className="text-lg font-semibold">whatsub · 设置</h1>
      <HandoffButton />
      <LlmConfig />
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add web-plugin/src/ui/options/
git commit -m "feat(plugin/options): LLM config + one-shot desktop handoff"
```

---

### Task 28: Manual end-to-end smoke test + version bump

**Files:**
- Modify: `web-plugin/package.json` (version → 0.1.0)
- Create: `web-plugin/README.md`

- [ ] **Step 1: Smoke checklist (manual, document in README)**

```markdown
# whatsub Browser Plugin

MV3 extension for bilingual subtitles + AI key-phrase highlighting on YouTube.

## Smoke test before shipping

1. `pnpm --filter web-plugin build`
2. Chrome → chrome://extensions → Load unpacked → web-plugin/dist
3. Open https://www.youtube.com/watch?v=<a video with CC>
4. Click YouTube's CC button → side panel slides in on the right
5. Wait 5-30s → cues populate with Chinese translation
6. Click "AI 标黄" → highlight marks appear on key phrases
7. Drag-select a phrase in the side panel → bubble appears
8. Click "+ 收藏" → confirm popup shows the entry
9. On https://en.wikipedia.org/wiki/* → drag-select a word → bubble appears
10. With whatsub desktop running, popup shows "桌面端已连接"; without it → "仅插件"
11. With desktop running, save a vocab → check %APPDATA%/whatsub/vocabulary.json has it with source/pageUrl
12. Options → "一键继承桌面端配置" → confirm dialog on desktop → after Yes, key appears in plugin settings
```

- [ ] **Step 2: Bump version**

```json
"version": "0.1.0"
```

- [ ] **Step 3: Commit**

```bash
git add web-plugin/package.json web-plugin/README.md
git commit -m "chore(plugin): v0.1.0 — manual smoke checklist documented"
```

---

## Self-review checklist

Before declaring this plan complete, verify each:

- [ ] Manifest declares only `storage`, `alarms`, `scripting` permissions — no `tabs`, no `<all_urls>` host permission beyond what's strictly needed for `*://*.youtube.com/*` + `http://127.0.0.1/*`.
- [ ] API keys never appear in `console.log`, `console.info`, error stack traces, or any analytics payload (we have none, but verify).
- [ ] Shadow DOM roots are `mode: "closed"` (not "open") to prevent page scripts from poking at our internals.
- [ ] CC track baseUrl extraction has a fallback path — if regex fails (YouTube rev'd the JSON shape), CS still works in degraded mode (no translation, just panel visible empty).
- [ ] Service worker never holds a `setInterval` with period < 30s for keepalive — uses `chrome.alarms` per Task 13.
- [ ] When user switches video mid-translation, the previous video's stream is aborted (`AbortController`) and partial cues stay in IndexedDB. New video uses cached cues if revisited.
- [ ] `vocab` upsert on the Rust desktop side preserves unknown fields (Task 5 + Task 21 both guarantee).
- [ ] Bridge binds to `127.0.0.1` exclusively — never `0.0.0.0`. Verified via `netstat -an | grep 51737`.
- [ ] All 4 bridge ports (`[51737, 53401, 59283, 62015]`) are spread across IANA Dynamic/Private range and don't collide with Clash (7890), frp (7000), Vite (5173), Tomcat (8443), or any other common dev port.
- [ ] CORS layer rejects `Origin` headers that are not `chrome-extension://*` or `moz-extension://*` — verified by Task 23 integration test.
- [ ] No bridge route panics on malformed JSON — every handler uses `web::Json<T>` extractor which returns 400 on bad bodies.
- [ ] Plugin works standalone (no desktop running): pill shows "仅插件", but bilingual + AI highlight + vocab collection still function — spec hard rule §0.
- [ ] Selection bubble does not appear inside `<input>`, `<textarea>`, or `contenteditable` elements — Task 17 guard.
- [ ] Bubble's `z-index: 2147483647` (max signed 32-bit int) so no host site CSS can hide it.
- [ ] `pnpm test:all` from repo root passes (workspace test discovery).
- [ ] `pnpm typecheck:all` from repo root passes (no missing types after extraction).
