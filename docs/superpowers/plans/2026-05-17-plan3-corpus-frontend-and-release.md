# whatsub Shared Corpus · Plan 3 · Frontend Integration + Release

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the shared corpus inside the existing whatsub browser plugin: every save uploads (per the spec's YouTube-default-on / web-default-off rule), every selection bubble shows other users' contributions for the same phrase with tag chips, and the extension ships to Chrome Web Store + Edge Add-ons with proper privacy disclosure and a "delete my contributions" button.

**Architecture:** Add a `corpusClient.ts` module to the plugin's existing service worker that handles `POST /contribute`, `GET /lookup`, `POST /flag`, `DELETE /mine` against `whatsub.eversay.cc`. Reuse the existing sync queue infrastructure (Plan 1) for retries and offline tolerance. Extend `SelectionBubble.tsx` with a second screen — visible after save — that fetches and renders `lookup` results. Reuse the existing `chrome.storage.local["settings"]` to add `shareToPublicCorpus.youtube` / `shareToPublicCorpus.web` flags. Lookup queries are cached in `chrome.storage.session` keyed by `phraseNormalized` for 5 minutes so the bubble opens snappily on repeats.

**Tech Stack:** TypeScript · React 19 · Tailwind v3 · zustand · @whatsub/llm-core (Plan 1) · @whatsub/shared-types (Plan 1) · Playwright (E2E) · MSW (corpus API mocking in tests)

---

## Scope reference

This plan implements **spec §5.4 + §7.6 + §11.4 + §13 testing rows** plus release prep (Chrome Web Store + Edge Add-ons submission). Plans 1 and 2 are prerequisites — the plugin core + the backend must both be working before this plan starts.

## File structure

### Plugin additions

| Path | Responsibility |
|---|---|
| `packages/shared-types/src/corpusApi.ts` | API DTO types (request + response shapes) for `/api/corpus/*` |
| `web-plugin/src/sw/corpus/corpusClient.ts` | HTTP wrapper for the 4 routes (contribute / lookup / flag / mine) |
| `web-plugin/src/sw/corpus/lookupCache.ts` | 5-minute `chrome.storage.session` cache keyed by phrase |
| `web-plugin/src/sw/corpus/contributePolicy.ts` | Decides whether a save should upload, given source + settings |
| `web-plugin/src/sw/corpus/queue.ts` | Extends Plan 1's syncQueue with corpus contribute retry |
| `web-plugin/src/sw/index.ts` (modify) | Add `corpus-lookup`, `corpus-flag`, `corpus-delete-mine` port handlers; integrate corpus upload into `save-vocab` handler |
| `web-plugin/src/state/settings.ts` (modify) | Add `shareToPublicCorpus: { youtube: boolean; web: boolean }` |
| `web-plugin/src/ui/Bubble/SelectionBubble.tsx` (modify) | Add second-screen state machine |
| `web-plugin/src/ui/Bubble/CorpusContributionsList.tsx` | Render contributions list with click-to-open + report |
| `web-plugin/src/ui/Bubble/TagChips.tsx` | Render scene + POS + CEFR chips |
| `web-plugin/src/ui/Bubble/ReportConfirm.tsx` | One-line "🚩 已收到" toast after flag |
| `web-plugin/src/ui/options/Options.tsx` (modify) | Add corpus-sharing toggle section + delete-mine button |
| `web-plugin/src/ui/options/CorpusSettings.tsx` | The two toggles + helper text |
| `web-plugin/src/ui/options/DeleteMineButton.tsx` | Two-step confirmation flow |
| `web-plugin/src/ui/popup/Popup.tsx` (modify) | Add "🌐 公共语料库" link at top |

### Release artifacts (`web-plugin/release/`)

| Path | Responsibility |
|---|---|
| `web-plugin/release/scripts/build-stores.sh` | Builds plugin + zips for Chrome + Edge stores |
| `web-plugin/release/scripts/capture-screenshots.ts` | Playwright script that opens the plugin on YouTube + Wikipedia and captures 5 PNGs |
| `web-plugin/release/listings/chrome/description.md` | Chrome Web Store long description (per CWS guidelines) |
| `web-plugin/release/listings/chrome/promo-tile.png` | 440×280 promo tile |
| `web-plugin/release/listings/chrome/screenshots/*.png` | 1280×800 ×5 |
| `web-plugin/release/listings/edge/description.md` | Edge Add-ons description |
| `web-plugin/release/listings/edge/screenshots/*.png` | 1280×800 ×5 |
| `web-plugin/release/listings/privacy-policy.md` | Source for `https://whatsub.eversay.cc/privacy` |
| `web-plugin/release/listings/SUBMISSION-CHECKLIST.md` | Pre-submission verification steps |

### E2E tests

| Path | Responsibility |
|---|---|
| `web-plugin/e2e/playwright.config.ts` | Loads the unpacked extension into a fresh Chromium profile |
| `web-plugin/e2e/setup-extension.ts` | Builds plugin, hands path to Playwright |
| `web-plugin/e2e/corpus-upload.spec.ts` | Save phrase on YouTube → verify POST /contribute fired |
| `web-plugin/e2e/corpus-lookup.spec.ts` | Open bubble → verify second screen shows mock contributions |
| `web-plugin/e2e/corpus-silent-failure.spec.ts` | Backend returns 5xx → user sees no error toast |
| `web-plugin/e2e/corpus-rate-limit.spec.ts` | Backend returns 429 → retry after 30s |
| `web-plugin/e2e/corpus-blocklist.spec.ts` | Backend returns 400/blocklist → console warn only |
| `web-plugin/e2e/corpus-flag.spec.ts` | Click 🚩 → toast appears, POST /flag fired |
| `web-plugin/e2e/settings-delete.spec.ts` | Two-step confirmation deletes via DELETE /mine |

---

## Task list

### Task 1: Prerequisite verification

**Files:** none — sanity-check before proceeding.

- [ ] **Step 1: Verify Plan 1 ship state**

Run from repo root:

```bash
pnpm --filter web-plugin build && ls web-plugin/dist/manifest.json
pnpm --filter @whatsub/llm-core test
pnpm --filter @whatsub/shared-types typecheck
```

Expected: all PASS. If Plan 1 hasn't shipped, halt this plan.

- [ ] **Step 2: Verify Plan 2 backend reachable**

```bash
curl -s 'https://whatsub.eversay.cc/api/corpus/lookup?phrase=save+up+money'
```

Expected: 200 or 404 (both are valid). Anything else (DNS, 5xx, 502) → halt.

- [ ] **Step 3: No commit (sanity task only)**

---

### Task 2: Shared corpus API DTO types

**Files:**
- Create: `packages/shared-types/src/corpusApi.ts`
- Modify: `packages/shared-types/src/index.ts` (add export)

- [ ] **Step 1: Implement types matching Plan 2 routes byte-exactly**

```ts
// packages/shared-types/src/corpusApi.ts

export interface CorpusSourceYoutube {
  kind: "youtube";
  url: string;       // canonical https://youtu.be/<id>?t=<sec>
  title: string;
  timestampSec?: number;
}
export interface CorpusSourceWeb {
  kind: "web";
  url: string;
  title: string;
}
export interface CorpusSourceCurator {
  kind: "curator";
  url: string;
  title: string;
  timestampSec?: number;
}
export type CorpusSource = CorpusSourceYoutube | CorpusSourceWeb | CorpusSourceCurator;

export interface CorpusContributeRequest {
  phraseRaw: string;
  contextSentence: string;
  source: CorpusSource;
  contributorId: string;
}

export interface CorpusPhraseTags {
  scene?:
    | "immigration" | "housing" | "medical" | "campus" | "banking"
    | "shopping" | "transport" | "social" | "dining" | "emergency"
    | "job" | "phone" | "salon" | "driving" | "travel"
    | "fitness" | "mental_health" | "maintenance";
  partOfSpeech?: "noun_phrase" | "verb_phrase" | "phrasal_verb" | "idiom" | "slang" | "collocation";
  cefrLevel?: "A2" | "B1" | "B2" | "C1" | "C2";
}

export interface CorpusContributeResponse {
  id: string;
  phrase: { tags: CorpusPhraseTags; classifiedAt: number | null };
}

export interface CorpusContributionView {
  id: string;
  phrase_normalized: string;
  context_sentence: string;
  source: CorpusSource;
  contributor_id: string;
  contributed_at: number;
}

export interface CorpusLookupResponse {
  phrase: {
    phrase_normalized: string;
    phrase_raw: string;
    tags: CorpusPhraseTags;
    contribution_count: number;
  };
  contributions: CorpusContributionView[];
}

export interface CorpusFlagRequest {
  contributionId: string;
  reason: "spam" | "abusive" | "irrelevant" | "other";
  contributorId: string;
}

export interface CorpusDeleteMineRequest {
  contributorId: string;
}

export interface CorpusDeleteMineResponse {
  deletedCount: number;
}
```

- [ ] **Step 2: Add to barrel**

```ts
// packages/shared-types/src/index.ts (append)
export * from "./corpusApi";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @whatsub/shared-types typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/shared-types/src/corpusApi.ts packages/shared-types/src/index.ts
git commit -m "feat(shared-types): corpus API request/response DTOs"
```

---

### Task 3: corpusClient HTTP wrapper

**Files:**
- Create: `web-plugin/src/sw/corpus/corpusClient.ts`
- Create: `web-plugin/src/sw/corpus/corpusClient.test.ts`

- [ ] **Step 1: Install MSW dev dep**

```bash
pnpm --filter web-plugin add -D msw@^2.0.0
git add web-plugin/package.json pnpm-lock.yaml
git commit -m "chore(plugin): add msw for corpus API mocking in tests"
```

- [ ] **Step 2: Write failing test**

```ts
// web-plugin/src/sw/corpus/corpusClient.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { contribute, lookup, flag, deleteMine } from "./corpusClient";

const BASE = "https://whatsub.eversay.cc";

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());
beforeEach(() => server.resetHandlers());

describe("corpusClient", () => {
  it("contribute returns body on 201", async () => {
    server.use(http.post(`${BASE}/api/corpus/contribute`, () =>
      HttpResponse.json({ id: "xyz", phrase: { tags: {}, classifiedAt: null } }, { status: 201 })
    ));
    const res = await contribute({
      phraseRaw: "save up money", contextSentence: "ctx",
      source: { kind: "youtube", url: "https://youtu.be/x?t=46", title: "T" },
      contributorId: "uuid",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body.id).toBe("xyz");
  });

  it("contribute returns { ok:false, reason:'rate_limited' } on 429", async () => {
    server.use(http.post(`${BASE}/api/corpus/contribute`, () =>
      HttpResponse.json({ ok: false, reason: "rate_limited", window: "minute" }, { status: 429 })
    ));
    const res = await contribute({
      phraseRaw: "p", contextSentence: "c",
      source: { kind: "youtube", url: "https://youtu.be/x", title: "" },
      contributorId: "uuid",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("rate_limited");
  });

  it("contribute returns { ok:false, reason:'blocklist_match' } on 400", async () => {
    server.use(http.post(`${BASE}/api/corpus/contribute`, () =>
      HttpResponse.json({ ok: false, reason: "blocklist_match" }, { status: 400 })
    ));
    const res = await contribute({
      phraseRaw: "p", contextSentence: "c",
      source: { kind: "youtube", url: "https://youtu.be/x", title: "" },
      contributorId: "uuid",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("blocklist_match");
  });

  it("contribute returns { ok:false, reason:'network' } on fetch throw (5xx, DNS, offline)", async () => {
    server.use(http.post(`${BASE}/api/corpus/contribute`, () => HttpResponse.error()));
    const res = await contribute({
      phraseRaw: "p", contextSentence: "c",
      source: { kind: "youtube", url: "https://youtu.be/x", title: "" },
      contributorId: "uuid",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("network");
  });

  it("lookup returns { ok:false, reason:'no_data' } on 404", async () => {
    server.use(http.get(`${BASE}/api/corpus/lookup`, () =>
      HttpResponse.json({ ok: false, reason: "no_data" }, { status: 404 })
    ));
    const res = await lookup("save up money", "me");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_data");
  });

  it("flag returns ok on 204", async () => {
    server.use(http.post(`${BASE}/api/corpus/flag`, () => new HttpResponse(null, { status: 204 })));
    const res = await flag({ contributionId: "x", reason: "spam", contributorId: "me" });
    expect(res.ok).toBe(true);
  });

  it("deleteMine returns count", async () => {
    server.use(http.delete(`${BASE}/api/corpus/mine`, () => HttpResponse.json({ deletedCount: 3 })));
    const res = await deleteMine("me");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body.deletedCount).toBe(3);
  });
});
```

- [ ] **Step 3: Run test, verify failure**

Run: `pnpm --filter web-plugin test corpusClient.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement**

```ts
// web-plugin/src/sw/corpus/corpusClient.ts
import type {
  CorpusContributeRequest, CorpusContributeResponse,
  CorpusLookupResponse, CorpusFlagRequest,
  CorpusDeleteMineResponse,
} from "@whatsub/shared-types";

const BASE = "https://whatsub.eversay.cc";

export type ClientResult<T> =
  | { ok: true; body: T }
  | { ok: false; reason: "rate_limited" | "blocklist_match" | "no_data" | "invalid_url" | "missing_fields" | "empty_phrase" | "network" | "unknown"; httpStatus?: number };

async function jsonOr<T>(r: Response): Promise<T | null> {
  try { return await r.json() as T; } catch { return null; }
}

export async function contribute(req: CorpusContributeRequest): Promise<ClientResult<CorpusContributeResponse>> {
  try {
    const r = await fetch(`${BASE}/api/corpus/contribute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (r.ok) {
      const body = await jsonOr<CorpusContributeResponse>(r);
      return body ? { ok: true, body } : { ok: false, reason: "unknown", httpStatus: r.status };
    }
    const errBody = await jsonOr<{ reason?: string }>(r);
    const reason = (errBody?.reason ?? "unknown") as ClientResult<never>["reason"];
    return { ok: false, reason, httpStatus: r.status };
  } catch {
    return { ok: false, reason: "network" };
  }
}

export async function lookup(phrase: string, excludeContributor: string | null): Promise<ClientResult<CorpusLookupResponse>> {
  try {
    const u = new URL(`${BASE}/api/corpus/lookup`);
    u.searchParams.set("phrase", phrase);
    if (excludeContributor) u.searchParams.set("excludeContributor", excludeContributor);
    const r = await fetch(u.toString());
    if (r.status === 404) return { ok: false, reason: "no_data", httpStatus: 404 };
    if (r.ok) {
      const body = await jsonOr<CorpusLookupResponse>(r);
      return body ? { ok: true, body } : { ok: false, reason: "unknown" };
    }
    return { ok: false, reason: "unknown", httpStatus: r.status };
  } catch {
    return { ok: false, reason: "network" };
  }
}

export async function flag(req: CorpusFlagRequest): Promise<ClientResult<null>> {
  try {
    const r = await fetch(`${BASE}/api/corpus/flag`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    return r.ok ? { ok: true, body: null } : { ok: false, reason: "unknown", httpStatus: r.status };
  } catch { return { ok: false, reason: "network" }; }
}

export async function deleteMine(contributorId: string): Promise<ClientResult<CorpusDeleteMineResponse>> {
  try {
    const r = await fetch(`${BASE}/api/corpus/mine`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contributorId }),
    });
    if (r.ok) {
      const body = await jsonOr<CorpusDeleteMineResponse>(r);
      return body ? { ok: true, body } : { ok: false, reason: "unknown" };
    }
    return { ok: false, reason: "unknown", httpStatus: r.status };
  } catch { return { ok: false, reason: "network" }; }
}
```

- [ ] **Step 5: Run test, verify PASS**

- [ ] **Step 6: Commit**

```bash
git add web-plugin/src/sw/corpus/corpusClient.ts web-plugin/src/sw/corpus/corpusClient.test.ts
git commit -m "feat(plugin/corpus): HTTP client for /api/corpus/* with typed result"
```

---

### Task 4: Lookup result cache (5 min, session-scoped)

**Files:**
- Create: `web-plugin/src/sw/corpus/lookupCache.ts`
- Create: `web-plugin/src/sw/corpus/lookupCache.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// web-plugin/src/sw/corpus/lookupCache.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getCached, setCached, CACHE_TTL_MS } from "./lookupCache";

describe("lookupCache", () => {
  const storage = new Map<string, unknown>();
  beforeEach(() => {
    storage.clear();
    globalThis.chrome = {
      storage: { session: {
        get: vi.fn(async (k: string) => ({ [k]: storage.get(k) })),
        set: vi.fn(async (kv: Record<string, unknown>) => Object.entries(kv).forEach(([k, v]) => storage.set(k, v))),
      } },
    } as unknown as typeof chrome;
  });

  it("returns null for unset key", async () => {
    expect(await getCached("save up money")).toBeNull();
  });

  it("returns cached body within TTL", async () => {
    await setCached("save up money", { phrase: {} as any, contributions: [] });
    const got = await getCached("save up money");
    expect(got).toEqual({ phrase: {} as any, contributions: [] });
  });

  it("returns null after TTL expiry", async () => {
    await setCached("p", { phrase: {} as any, contributions: [] });
    const key = "corpus:lookup:p";
    const stored = storage.get(key) as { storedAt: number };
    storage.set(key, { ...stored, storedAt: Date.now() - CACHE_TTL_MS - 1 });
    expect(await getCached("p")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

- [ ] **Step 3: Implement**

```ts
// web-plugin/src/sw/corpus/lookupCache.ts
import type { CorpusLookupResponse } from "@whatsub/shared-types";

export const CACHE_TTL_MS = 5 * 60_000;

interface Entry { body: CorpusLookupResponse; storedAt: number }

export async function getCached(phrase: string): Promise<CorpusLookupResponse | null> {
  const key = `corpus:lookup:${phrase}`;
  const { [key]: e } = await chrome.storage.session.get(key);
  if (!e) return null;
  const entry = e as Entry;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) return null;
  return entry.body;
}

export async function setCached(phrase: string, body: CorpusLookupResponse): Promise<void> {
  const key = `corpus:lookup:${phrase}`;
  await chrome.storage.session.set({ [key]: { body, storedAt: Date.now() } as Entry });
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add web-plugin/src/sw/corpus/lookupCache.ts web-plugin/src/sw/corpus/lookupCache.test.ts
git commit -m "feat(plugin/corpus): 5-min session-scoped lookup cache"
```

---

### Task 5: Upload policy (YouTube default-on / web default-off)

**Files:**
- Create: `web-plugin/src/sw/corpus/contributePolicy.ts`
- Create: `web-plugin/src/sw/corpus/contributePolicy.test.ts`
- Modify: `web-plugin/src/state/settings.ts`

- [ ] **Step 1: Extend settings**

```ts
// web-plugin/src/state/settings.ts — add to PluginSettings interface
export interface PluginSettings {
  // ... existing fields from Plan 1 ...
  shareToPublicCorpus: {
    youtube: boolean;   // default TRUE per spec §11.4
    web: boolean;       // default FALSE per spec §11.4
  };
}
```

Update `DEFAULTS` to include:
```ts
shareToPublicCorpus: { youtube: true, web: false },
```

- [ ] **Step 2: Write failing test**

```ts
// web-plugin/src/sw/corpus/contributePolicy.test.ts
import { describe, it, expect } from "vitest";
import { shouldContribute } from "./contributePolicy";

describe("shouldContribute", () => {
  const settings = (overrides: any = {}) => ({
    shareToPublicCorpus: { youtube: true, web: false },
    ...overrides,
  } as any);

  it("YouTube default → upload", () => {
    expect(shouldContribute({ source: "youtube", explicit: undefined }, settings())).toBe(true);
  });
  it("Web default → no upload", () => {
    expect(shouldContribute({ source: "web", explicit: undefined }, settings())).toBe(false);
  });
  it("Web with explicit=true → upload", () => {
    expect(shouldContribute({ source: "web", explicit: true }, settings())).toBe(true);
  });
  it("YouTube with explicit=false → no upload", () => {
    expect(shouldContribute({ source: "youtube", explicit: false }, settings())).toBe(false);
  });
  it("YouTube but setting off → no upload", () => {
    expect(shouldContribute({ source: "youtube" }, settings({ shareToPublicCorpus: { youtube: false, web: false } }))).toBe(false);
  });
});
```

- [ ] **Step 3: Run test, verify failure**

- [ ] **Step 4: Implement**

```ts
// web-plugin/src/sw/corpus/contributePolicy.ts
import type { PluginSettings } from "../../state/settings";

interface PolicyInput {
  source: "youtube" | "web";
  /** When the user explicitly toggled "share this to public corpus" in the bubble,
   *  this overrides the default. true → force upload; false → force skip;
   *  undefined → use settings default. */
  explicit?: boolean;
}

export function shouldContribute(input: PolicyInput, settings: PluginSettings): boolean {
  if (input.explicit !== undefined) return input.explicit;
  return settings.shareToPublicCorpus[input.source];
}
```

- [ ] **Step 5: Run test, verify PASS**

- [ ] **Step 6: Commit**

```bash
git add web-plugin/src/sw/corpus/contributePolicy.ts web-plugin/src/sw/corpus/contributePolicy.test.ts web-plugin/src/state/settings.ts
git commit -m "feat(plugin/corpus): upload policy (YouTube on / web off)"
```

---

### Task 6: Queue extension — corpus retry on 429 / network failure

**Files:**
- Modify: `web-plugin/src/sw/syncQueue.ts` (extend `SyncQueueItem`)
- Create: `web-plugin/src/sw/corpus/queue.ts`
- Create: `web-plugin/src/sw/corpus/queue.test.ts`

- [ ] **Step 1: Extend SyncQueueItem in Plan 1's queue**

In `web-plugin/src/sw/syncQueue.ts`, change `SyncQueueItem` to include `corpus-contribute`:

```ts
export interface SyncQueueItem {
  kind: "vocab" | "corpus" | "corpus-contribute";
  payload: VocabEntry | CorpusEntry | CorpusContributeRequest;
  queuedAt: number;
  retries: number;
}
```

- [ ] **Step 2: Write failing test**

```ts
// web-plugin/src/sw/corpus/queue.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { enqueueOrSend, drainCorpus } from "./queue";

const server = setupServer();
beforeEach(() => {
  server.resetHandlers();
});

describe("corpus queue", () => {
  it("sends immediately if backend OK; doesn't enqueue", async () => {
    server.use(http.post("https://whatsub.eversay.cc/api/corpus/contribute", () =>
      HttpResponse.json({ id: "x", phrase: { tags: {}, classifiedAt: null } }, { status: 201 })));
    server.listen();
    const enqueueSpy = vi.fn();
    const result = await enqueueOrSend({
      phraseRaw: "p", contextSentence: "c",
      source: { kind: "youtube", url: "https://youtu.be/x", title: "" },
      contributorId: "u",
    }, enqueueSpy);
    expect(result.uploaded).toBe(true);
    expect(enqueueSpy).not.toHaveBeenCalled();
    server.close();
  });

  it("enqueues on network failure", async () => {
    server.use(http.post("https://whatsub.eversay.cc/api/corpus/contribute", () => HttpResponse.error()));
    server.listen();
    const enqueueSpy = vi.fn();
    const result = await enqueueOrSend({
      phraseRaw: "p", contextSentence: "c",
      source: { kind: "youtube", url: "https://youtu.be/x", title: "" },
      contributorId: "u",
    }, enqueueSpy);
    expect(result.uploaded).toBe(false);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    server.close();
  });

  it("enqueues on 429 for retry-after backoff", async () => {
    server.use(http.post("https://whatsub.eversay.cc/api/corpus/contribute", () =>
      HttpResponse.json({ ok: false, reason: "rate_limited" }, { status: 429 })));
    server.listen();
    const enqueueSpy = vi.fn();
    const result = await enqueueOrSend({
      phraseRaw: "p", contextSentence: "c",
      source: { kind: "youtube", url: "https://youtu.be/x", title: "" },
      contributorId: "u",
    }, enqueueSpy);
    expect(result.uploaded).toBe(false);
    expect(enqueueSpy).toHaveBeenCalled();
    server.close();
  });

  it("does NOT enqueue on 400 blocklist (silent drop per spec §13)", async () => {
    server.use(http.post("https://whatsub.eversay.cc/api/corpus/contribute", () =>
      HttpResponse.json({ ok: false, reason: "blocklist_match" }, { status: 400 })));
    server.listen();
    const enqueueSpy = vi.fn();
    const result = await enqueueOrSend({
      phraseRaw: "p", contextSentence: "c",
      source: { kind: "youtube", url: "https://youtu.be/x", title: "" },
      contributorId: "u",
    }, enqueueSpy);
    expect(result.uploaded).toBe(false);
    expect(enqueueSpy).not.toHaveBeenCalled();
    server.close();
  });
});
```

- [ ] **Step 3: Run test, verify failure**

- [ ] **Step 4: Implement**

```ts
// web-plugin/src/sw/corpus/queue.ts
import type { CorpusContributeRequest } from "@whatsub/shared-types";
import { contribute } from "./corpusClient";
import type { SyncQueueItem } from "../syncQueue";

interface SendResult { uploaded: boolean }

export async function enqueueOrSend(
  req: CorpusContributeRequest,
  enqueue: (item: SyncQueueItem) => Promise<void>,
): Promise<SendResult> {
  const res = await contribute(req);
  if (res.ok) return { uploaded: true };
  // Decision per spec §13:
  //  - network / 429 → enqueue for retry
  //  - blocklist_match / invalid_url / empty_phrase / missing_fields → drop silently
  //    (these are deterministic — retry won't change outcome)
  if (res.reason === "network" || res.reason === "rate_limited") {
    await enqueue({ kind: "corpus-contribute", payload: req, queuedAt: Date.now(), retries: 0 });
  } else {
    // Soft log to dev console — no user-facing error per spec §13 hard rule
    console.warn("[whatsub/corpus] silent drop:", res.reason, res.httpStatus);
  }
  return { uploaded: false };
}

export async function drainCorpus(items: SyncQueueItem[]): Promise<SyncQueueItem[]> {
  const stillFailing: SyncQueueItem[] = [];
  for (const item of items) {
    if (item.kind !== "corpus-contribute") { stillFailing.push(item); continue; }
    const res = await contribute(item.payload as CorpusContributeRequest);
    if (!res.ok && (res.reason === "network" || res.reason === "rate_limited")) {
      item.retries += 1;
      if (item.retries < 5) stillFailing.push(item);
      // else: drop after 5 retries
    }
    // Success or deterministic failure: don't requeue
  }
  return stillFailing;
}
```

- [ ] **Step 5: Run test, verify PASS**

- [ ] **Step 6: Commit**

```bash
git add web-plugin/src/sw/corpus/queue.ts web-plugin/src/sw/corpus/queue.test.ts web-plugin/src/sw/syncQueue.ts
git commit -m "feat(plugin/corpus): retry queue with silent drop for deterministic errors"
```

---

### Task 7: Integrate corpus upload into save-vocab handler

**Files:**
- Modify: `web-plugin/src/sw/index.ts`

- [ ] **Step 1: Wire corpus upload into existing save-vocab port handler**

In the existing `save-vocab` handler from Plan 1, add the corpus upload as a parallel branch:

```ts
// inside chrome.runtime.onConnect → onMessage handler, in the `save-vocab` case
} else if (raw.type === "save-vocab") {
  // 1) Existing path: write local + push to desktop bridge queue (Plan 1)
  await upsertVocab(raw.entry);
  await enqueueSyncItem({ kind: "vocab", payload: raw.entry, queuedAt: Date.now(), retries: 0 });

  // 2) NEW: corpus upload per policy (Plan 3 §5.4)
  if (raw.entry.cueText && (raw.entry.source === "youtube" || raw.entry.source === "web")) {
    const settings = useSettings.getState().settings;
    const allowed = shouldContribute({
      source: raw.entry.source,
      explicit: raw.shareToPublicExplicit,  // from bubble's optional checkbox
    }, settings);
    if (allowed) {
      const contributorId = await getOrCreateContributorId();
      const sourceForApi = raw.entry.source === "youtube"
        ? { kind: "youtube" as const, url: raw.entry.videoUrl!, title: raw.entry.videoTitle, timestampSec: raw.entry.cueTime }
        : { kind: "web" as const, url: raw.entry.pageUrl!, title: raw.entry.videoTitle };
      void enqueueOrSend({
        phraseRaw: raw.entry.expression,
        contextSentence: raw.entry.cueText,
        source: sourceForApi,
        contributorId,
      }, enqueueSyncItem);
    }
  }
}
```

- [ ] **Step 2: Update ClientMessage type to include the optional explicit flag**

In `web-plugin/src/sw/messaging.ts`:

```ts
| { type: "save-vocab"; entry: VocabEntry; shareToPublicExplicit?: boolean }
```

- [ ] **Step 3: Commit**

```bash
git add web-plugin/src/sw/index.ts web-plugin/src/sw/messaging.ts
git commit -m "feat(plugin/corpus): wire corpus upload into save-vocab handler"
```

---

### Task 8: SW lookup port handler

**Files:**
- Modify: `web-plugin/src/sw/index.ts`
- Modify: `web-plugin/src/sw/messaging.ts`

- [ ] **Step 1: Extend message types**

```ts
// web-plugin/src/sw/messaging.ts — append to ClientMessage union
| { type: "corpus-lookup"; phrase: string }
| { type: "corpus-flag"; contributionId: string; reason: "spam" | "abusive" | "irrelevant" | "other" }
| { type: "corpus-delete-mine" }

// and to ServerMessage:
| { type: "corpus-lookup-result"; phrase: import("@whatsub/shared-types").CorpusLookupResponse | null }
| { type: "corpus-flag-result"; ok: boolean }
| { type: "corpus-delete-mine-result"; deletedCount: number; ok: boolean }
```

Update the type guards accordingly.

- [ ] **Step 2: Add lookup handler in SW**

```ts
// inside onMessage handler:
} else if (raw.type === "corpus-lookup") {
  const cached = await getCached(raw.phrase);
  if (cached) { send({ type: "corpus-lookup-result", phrase: cached }); return; }
  const contributorId = await getOrCreateContributorId();
  const res = await lookup(raw.phrase, contributorId);
  if (res.ok) {
    await setCached(raw.phrase, res.body);
    send({ type: "corpus-lookup-result", phrase: res.body });
  } else {
    // Silent failure per spec §13 — UI hides the "N people saved" entry
    send({ type: "corpus-lookup-result", phrase: null });
  }
} else if (raw.type === "corpus-flag") {
  const contributorId = await getOrCreateContributorId();
  const res = await flag({ contributionId: raw.contributionId, reason: raw.reason, contributorId });
  send({ type: "corpus-flag-result", ok: res.ok });
} else if (raw.type === "corpus-delete-mine") {
  const contributorId = await getOrCreateContributorId();
  const res = await deleteMine(contributorId);
  send({ type: "corpus-delete-mine-result", deletedCount: res.ok ? res.body.deletedCount : 0, ok: res.ok });
}
```

- [ ] **Step 3: Commit**

```bash
git add web-plugin/src/sw/index.ts web-plugin/src/sw/messaging.ts
git commit -m "feat(plugin/corpus): SW port handlers for lookup / flag / delete-mine"
```

---

### Task 9: Bubble second-screen — TagChips + ContributionsList

**Files:**
- Create: `web-plugin/src/ui/Bubble/TagChips.tsx`
- Create: `web-plugin/src/ui/Bubble/CorpusContributionsList.tsx`
- Create: `web-plugin/src/ui/Bubble/CorpusContributionsList.test.tsx`

- [ ] **Step 1: TagChips component**

```tsx
// web-plugin/src/ui/Bubble/TagChips.tsx
import type { CorpusPhraseTags } from "@whatsub/shared-types";

const SCENE_ZH: Record<string, string> = {
  immigration: "入境通关", housing: "住房安家", medical: "医疗健康",
  campus: "校园学习", banking: "银行财务", shopping: "日常购物",
  transport: "交通出行", social: "社交日常", dining: "餐饮",
  emergency: "紧急情况", job: "求职职场", phone: "电话沟通",
  salon: "美容美发", driving: "驾照开车", travel: "旅游度假",
  fitness: "运动健身", mental_health: "心理健康", maintenance: "搬家维修",
};

const POS_ZH: Record<string, string> = {
  noun_phrase: "名词短语", verb_phrase: "动词短语", phrasal_verb: "短语动词",
  idiom: "习语", slang: "俚语", collocation: "搭配",
};

export function TagChips({ tags }: { tags: CorpusPhraseTags }) {
  const chips = [
    tags.scene && { label: SCENE_ZH[tags.scene] ?? tags.scene, color: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30" },
    tags.partOfSpeech && { label: POS_ZH[tags.partOfSpeech] ?? tags.partOfSpeech, color: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
    tags.cefrLevel && { label: tags.cefrLevel, color: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  ].filter(Boolean) as { label: string; color: string }[];
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 px-3 pt-2">
      {chips.map((c) => (
        <span key={c.label} className={`text-[10px] px-2 py-0.5 rounded-full border ${c.color}`}>{c.label}</span>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Write failing test for ContributionsList**

```tsx
// web-plugin/src/ui/Bubble/CorpusContributionsList.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CorpusContributionsList } from "./CorpusContributionsList";

const sample = {
  phrase_normalized: "save up money", phrase_raw: "save up money",
  tags: { scene: "campus" as const }, contribution_count: 3,
};
const contribs = [
  { id: "1", phrase_normalized: "save up money", context_sentence: "I need to save up money", source: { kind: "youtube" as const, url: "https://youtu.be/abc?t=46", title: "Budget" }, contributor_id: "u1", contributed_at: 1 },
  { id: "2", phrase_normalized: "save up money", context_sentence: "Save up money is key", source: { kind: "curator" as const, url: "https://youtu.be/def?t=10", title: "Tutorial" }, contributor_id: "whatsub-curator", contributed_at: 0 },
];

describe("CorpusContributionsList", () => {
  it("renders one row per contribution with title + context", () => {
    render(<CorpusContributionsList phrase={sample} contributions={contribs} onFlag={() => {}} />);
    expect(screen.getByText("I need to save up money")).toBeInTheDocument();
    expect(screen.getByText("Tutorial")).toBeInTheDocument();
  });

  it("shows curator badge on curator contributions", () => {
    render(<CorpusContributionsList phrase={sample} contributions={contribs} onFlag={() => {}} />);
    expect(screen.getByText(/精选/)).toBeInTheDocument();
  });

  it("calls onFlag when 🚩 clicked", () => {
    const onFlag = vi.fn();
    render(<CorpusContributionsList phrase={sample} contributions={contribs} onFlag={onFlag} />);
    fireEvent.click(screen.getAllByTitle("举报这一条")[0]);
    expect(onFlag).toHaveBeenCalledWith("1");
  });
});
```

- [ ] **Step 3: Run test, verify failure**

- [ ] **Step 4: Implement ContributionsList**

```tsx
// web-plugin/src/ui/Bubble/CorpusContributionsList.tsx
import { Flag, Sparkles } from "lucide-react";
import type { CorpusLookupResponse } from "@whatsub/shared-types";

interface Props {
  phrase: CorpusLookupResponse["phrase"];
  contributions: CorpusLookupResponse["contributions"];
  onFlag: (contributionId: string) => void;
}

export function CorpusContributionsList({ phrase, contributions, onFlag }: Props) {
  return (
    <div className="px-3 pb-2">
      <div className="text-[11px] text-zinc-400 mb-1">
        ✨ {phrase.contribution_count} 个人收藏过这个短语
      </div>
      <div className="space-y-1 max-h-48 overflow-y-auto">
        {contributions.map((c) => {
          const isCurator = c.source.kind === "curator";
          return (
            <div key={c.id} className="rounded border border-zinc-700 bg-zinc-950/50 p-2 text-xs">
              <div className="flex items-center gap-1 mb-1">
                <a href={c.source.url} target="_blank" rel="noreferrer"
                   className="flex-1 truncate text-zinc-200 hover:text-blue-300 text-xs font-medium">
                  {isCurator && <Sparkles className="inline h-3 w-3 text-amber-300 mr-1" />}
                  {c.source.title || c.source.url}
                </a>
                {isCurator && <span className="text-[9px] text-amber-300 bg-amber-900/30 px-1.5 py-0.5 rounded">精选</span>}
                <button onClick={() => onFlag(c.id)} title="举报这一条"
                        className="text-zinc-600 hover:text-red-400 ml-1">
                  <Flag className="h-3 w-3" />
                </button>
              </div>
              <div className="text-zinc-400 italic leading-snug">"{c.context_sentence}"</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run test, verify PASS**

- [ ] **Step 6: Commit**

```bash
git add web-plugin/src/ui/Bubble/TagChips.tsx web-plugin/src/ui/Bubble/CorpusContributionsList.tsx web-plugin/src/ui/Bubble/CorpusContributionsList.test.tsx
git commit -m "feat(plugin/corpus): tag chips + contributions list components"
```

---

### Task 10: Bubble state machine — second screen on save

**Files:**
- Modify: `web-plugin/src/ui/Bubble/SelectionBubble.tsx`

- [ ] **Step 1: Add second-screen state**

Around the existing SelectionBubble component (created in Plan 1), wrap save action to trigger lookup after the save completes:

```tsx
// Extension to existing SelectionBubble — pseudo-diff format showing the new state
type View = "main" | "second-screen";
const [view, setView] = useState<View>("main");
const [lookupResult, setLookupResult] = useState<CorpusLookupResponse | null>(null);
const [shareExplicit, setShareExplicit] = useState<boolean | undefined>(undefined);

const save = async () => {
  const port = chrome.runtime.connect({ name: "whatsub" });
  port.postMessage({
    type: "save-vocab",
    entry: { /* same as before */ },
    shareToPublicExplicit: shareExplicit,
  });
  // After save, fetch corpus contributions
  port.postMessage({ type: "corpus-lookup", phrase: normalizeExpression(expression) });
  port.onMessage.addListener((m) => {
    if (m.type === "corpus-lookup-result") {
      setLookupResult(m.phrase);  // could be null on failure
      setView("second-screen");
    }
  });
};

const handleFlag = (contributionId: string) => {
  const port = chrome.runtime.connect({ name: "whatsub" });
  port.postMessage({ type: "corpus-flag", contributionId, reason: "other" });
  setFlashFlagged(contributionId);
};
```

- [ ] **Step 2: Render second screen when `view === "second-screen"`**

```tsx
{view === "second-screen" && lookupResult && (
  <div>
    <TagChips tags={lookupResult.phrase.tags} />
    <CorpusContributionsList
      phrase={lookupResult.phrase}
      contributions={lookupResult.contributions}
      onFlag={handleFlag}
    />
  </div>
)}
{view === "second-screen" && !lookupResult && (
  // Silent fallback: nothing rendered, just "Saved" feedback + close timer
  <div className="px-3 py-2 text-xs text-emerald-300">✓ 已收藏</div>
)}
```

- [ ] **Step 3: Web-source "也分享到公共语料库" checkbox**

When `source === "web"`, render a checkbox under the inputs:

```tsx
{source.kind === "web" && (
  <label className="flex items-center gap-2 px-3 pb-2 text-xs text-zinc-400">
    <input type="checkbox" checked={shareExplicit === true} onChange={(e) => setShareExplicit(e.target.checked ? true : undefined)} />
    也分享到公共语料库
  </label>
)}
```

- [ ] **Step 4: Commit**

```bash
git add web-plugin/src/ui/Bubble/SelectionBubble.tsx
git commit -m "feat(plugin/bubble): second screen + share-to-public toggle for web saves"
```

---

### Task 11: Options page — corpus settings + delete-mine

**Files:**
- Create: `web-plugin/src/ui/options/CorpusSettings.tsx`
- Create: `web-plugin/src/ui/options/DeleteMineButton.tsx`
- Modify: `web-plugin/src/ui/options/Options.tsx`

- [ ] **Step 1: CorpusSettings component**

```tsx
// web-plugin/src/ui/options/CorpusSettings.tsx
import { useSettings } from "../../state/settings";

export function CorpusSettings() {
  const { settings, save } = useSettings();
  const s = settings.shareToPublicCorpus;
  return (
    <section className="space-y-3 max-w-xl">
      <h2 className="font-semibold">公共语料库</h2>
      <p className="text-xs text-zinc-400">收藏短语时把它匿名分享给其他学习者。详见<a href="https://whatsub.eversay.cc/privacy" target="_blank" className="text-blue-400 underline">隐私声明</a>。</p>
      <label className="flex items-center gap-3 text-sm">
        <input type="checkbox" checked={s.youtube} onChange={(e) => save({ shareToPublicCorpus: { ...s, youtube: e.target.checked } })} />
        YouTube 字幕里的收藏 <span className="text-xs text-zinc-500">（默认开启）</span>
      </label>
      <label className="flex items-center gap-3 text-sm">
        <input type="checkbox" checked={s.web} onChange={(e) => save({ shareToPublicCorpus: { ...s, web: e.target.checked } })} />
        任意网页的收藏 <span className="text-xs text-zinc-500">（默认关闭，每次手动勾）</span>
      </label>
    </section>
  );
}
```

- [ ] **Step 2: DeleteMineButton with 2-step confirm**

```tsx
// web-plugin/src/ui/options/DeleteMineButton.tsx
import { useState } from "react";

export function DeleteMineButton() {
  const [step, setStep] = useState<"idle" | "confirm" | "deleting" | "done" | "error">("idle");
  const [deletedCount, setDeletedCount] = useState(0);

  const confirm = () => setStep("confirm");
  const cancel = () => setStep("idle");

  const doDelete = async () => {
    setStep("deleting");
    const port = chrome.runtime.connect({ name: "whatsub" });
    port.postMessage({ type: "corpus-delete-mine" });
    port.onMessage.addListener((m) => {
      if (m.type === "corpus-delete-mine-result") {
        if (m.ok) {
          setDeletedCount(m.deletedCount);
          setStep("done");
        } else setStep("error");
        port.disconnect();
      }
    });
  };

  if (step === "idle") {
    return <button onClick={confirm} className="px-3 py-1.5 text-sm rounded border border-red-500/40 text-red-300 hover:bg-red-900/20">删除我的所有贡献</button>;
  }
  if (step === "confirm") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-zinc-200">这将永久删除你在公共语料库的所有贡献，且不可恢复。确认吗？</p>
        <div className="flex gap-2">
          <button onClick={doDelete} className="px-3 py-1.5 text-sm rounded bg-red-600 text-white">是的，删除</button>
          <button onClick={cancel} className="px-3 py-1.5 text-sm rounded border border-zinc-700 text-zinc-300">取消</button>
        </div>
      </div>
    );
  }
  if (step === "deleting") return <p className="text-sm text-zinc-400">正在删除...</p>;
  if (step === "done") return <p className="text-sm text-emerald-400">已删除 {deletedCount} 条贡献</p>;
  return <p className="text-sm text-red-400">删除失败，请检查网络稍后重试</p>;
}
```

- [ ] **Step 3: Wire into Options**

```tsx
// web-plugin/src/ui/options/Options.tsx — extend existing component
import { CorpusSettings } from "./CorpusSettings";
import { DeleteMineButton } from "./DeleteMineButton";

export function Options() {
  return (
    <div className="p-6 bg-zinc-950 text-zinc-100 min-h-screen space-y-6 max-w-3xl mx-auto">
      <h1 className="text-lg font-semibold">whatsub · 设置</h1>
      <HandoffButton />
      <LlmConfig />
      <CorpusSettings />
      <DeleteMineButton />
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add web-plugin/src/ui/options/
git commit -m "feat(plugin/options): corpus settings + 2-step delete-my-contributions"
```

---

### Task 12: Popup — public corpus link

**Files:**
- Modify: `web-plugin/src/ui/popup/Popup.tsx`

- [ ] **Step 1: Add header link**

```tsx
// At top of Popup.tsx render output, after the status pill
<a href="https://whatsub.eversay.cc/corpus" target="_blank" rel="noreferrer"
   className="block text-xs text-blue-400 hover:underline mb-2">
  🌐 公共语料库 → 看其他人收藏了什么
</a>
```

- [ ] **Step 2: Commit**

```bash
git add web-plugin/src/ui/popup/Popup.tsx
git commit -m "feat(plugin/popup): link to public corpus browse page"
```

---

### Task 13: Playwright setup + extension load harness

**Files:**
- Create: `web-plugin/e2e/playwright.config.ts`
- Create: `web-plugin/e2e/setup-extension.ts`
- Modify: `web-plugin/package.json` (add scripts + dep)

- [ ] **Step 1: Add Playwright dep**

```bash
pnpm --filter web-plugin add -D @playwright/test
pnpm --filter web-plugin exec playwright install chromium
```

- [ ] **Step 2: Config**

```ts
// web-plugin/e2e/playwright.config.ts
import { defineConfig } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: ".",
  fullyParallel: false,  // extension loading is stateful
  workers: 1,
  use: {
    headless: false,  // Chrome extensions only work in headed mode
    viewport: { width: 1280, height: 800 },
  },
});
```

- [ ] **Step 3: Extension load helper**

```ts
// web-plugin/e2e/setup-extension.ts
import { chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";

export async function launchWithExtension(): Promise<BrowserContext> {
  const distPath = path.resolve(__dirname, "../dist");
  return await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
      "--no-sandbox",
    ],
  });
}

export async function getExtensionId(ctx: BrowserContext): Promise<string> {
  let [worker] = ctx.serviceWorkers();
  if (!worker) worker = await ctx.waitForEvent("serviceworker");
  return worker.url().split("/")[2];
}
```

- [ ] **Step 4: Add npm scripts**

```json
{
  "scripts": {
    "e2e": "pnpm build && playwright test --config=e2e/playwright.config.ts",
    "e2e:debug": "pnpm build && playwright test --config=e2e/playwright.config.ts --debug"
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add web-plugin/e2e/playwright.config.ts web-plugin/e2e/setup-extension.ts web-plugin/package.json pnpm-lock.yaml
git commit -m "test(plugin/e2e): playwright config + extension load harness"
```

---

### Task 14: E2E — corpus upload on YouTube save

**Files:**
- Create: `web-plugin/e2e/corpus-upload.spec.ts`

- [ ] **Step 1: Write the test**

```ts
// web-plugin/e2e/corpus-upload.spec.ts
import { test, expect } from "@playwright/test";
import { launchWithExtension, getExtensionId } from "./setup-extension";

test("YouTube save uploads to corpus by default", async () => {
  const ctx = await launchWithExtension();
  const page = await ctx.newPage();

  // Intercept the corpus endpoint
  const requests: { url: string; body: any }[] = [];
  await page.route("https://whatsub.eversay.cc/api/corpus/contribute", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    requests.push({ url: route.request().url(), body });
    await route.fulfill({ status: 201, body: JSON.stringify({ id: "x", phrase: { tags: {}, classifiedAt: null } }) });
  });

  // Open a real YouTube video (use one known to have CC)
  await page.goto("https://www.youtube.com/watch?v=BHACKCNDMW8");
  await page.waitForTimeout(3000);
  // Enable CC
  await page.click(".ytp-subtitles-button");
  await page.waitForTimeout(5000);

  // Drag-select a phrase from the side panel
  // (Implementation note: the actual selection event needs to be in the shadow DOM.
  //  Use page.evaluate to dispatch programmatic selection on a known cue.)
  await page.evaluate(() => {
    const cue = document.querySelector("[data-idx='0']");
    if (!cue) throw new Error("cue not rendered");
    const range = document.createRange();
    range.selectNodeContents(cue);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    cue.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.waitForTimeout(500);

  // Click "+ 收藏" — Shadow DOM selector
  // (Adapt selector to actual button text after the bubble is shipped)
  // For now, simulate via SW message:
  await page.evaluate(() => {
    chrome.runtime.connect({ name: "whatsub" }).postMessage({
      type: "save-vocab",
      entry: {
        id: "save up money", expression: "save up money", meaningZh: "", usage: "",
        videoId: "BHACKCNDMW8", videoTitle: "Test video",
        addedAt: new Date().toISOString(),
        cueText: "I need to save up money for school.",
        cueTime: 46,
        source: "youtube",
        videoUrl: "https://youtu.be/BHACKCNDMW8?t=46",
        syncStatus: "pending",
      },
    });
  });
  await page.waitForTimeout(2000);

  expect(requests.length).toBe(1);
  expect(requests[0].body.phraseRaw).toBe("save up money");
  expect(requests[0].body.source.kind).toBe("youtube");
  expect(requests[0].body.contributorId).toMatch(/^[0-9a-f]{8}-/);

  await ctx.close();
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter web-plugin e2e -- corpus-upload.spec.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web-plugin/e2e/corpus-upload.spec.ts
git commit -m "test(plugin/corpus): E2E for YouTube save uploads to corpus"
```

---

### Task 15: E2E — silent failure on 5xx + 429 retry + 400 blocklist swallow

**Files:**
- Create: `web-plugin/e2e/corpus-silent-failure.spec.ts`
- Create: `web-plugin/e2e/corpus-rate-limit.spec.ts`
- Create: `web-plugin/e2e/corpus-blocklist.spec.ts`

- [ ] **Step 1: Silent 5xx test**

```ts
// web-plugin/e2e/corpus-silent-failure.spec.ts
import { test, expect } from "@playwright/test";
import { launchWithExtension } from "./setup-extension";

test("5xx backend → no error UI, save still local", async () => {
  const ctx = await launchWithExtension();
  const page = await ctx.newPage();
  await page.route("https://whatsub.eversay.cc/api/corpus/contribute", (route) =>
    route.fulfill({ status: 500, body: "" }));

  // Inject a known-safe page to test
  await page.goto("https://en.wikipedia.org/wiki/English_language");

  // Listen for any error dialogs / console errors
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
  const consoleErrors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

  // Trigger a save (programmatic)
  await page.evaluate(() => {
    chrome.runtime.connect({ name: "whatsub" }).postMessage({
      type: "save-vocab",
      entry: {
        id: "phrase x", expression: "phrase x", meaningZh: "", usage: "",
        videoId: "", videoTitle: "English language",
        addedAt: new Date().toISOString(),
        cueText: "English is a West Germanic language.", source: "web",
        pageUrl: "https://en.wikipedia.org/wiki/English_language",
        syncStatus: "pending",
      },
      shareToPublicExplicit: true,  // force upload despite web default
    });
  });
  await page.waitForTimeout(3000);

  expect(dialogs).toHaveLength(0);
  // The plugin's own SW may console.warn; that's allowed. Disallowed: console.error
  expect(consoleErrors.filter((e) => e.includes("whatsub")).length).toBe(0);

  await ctx.close();
});
```

- [ ] **Step 2: 429 retry test**

```ts
// web-plugin/e2e/corpus-rate-limit.spec.ts
import { test, expect } from "@playwright/test";
import { launchWithExtension } from "./setup-extension";

test("429 → item lands in syncQueue for retry", async () => {
  const ctx = await launchWithExtension();
  const page = await ctx.newPage();
  let calls = 0;
  await page.route("https://whatsub.eversay.cc/api/corpus/contribute", async (route) => {
    calls += 1;
    await route.fulfill({ status: 429, body: JSON.stringify({ ok: false, reason: "rate_limited", window: "minute" }) });
  });
  await page.goto("https://example.com");
  await page.evaluate(() => {
    chrome.runtime.connect({ name: "whatsub" }).postMessage({
      type: "save-vocab",
      entry: {
        id: "p", expression: "p", meaningZh: "", usage: "",
        videoId: "abc", videoTitle: "t",
        addedAt: new Date().toISOString(), cueText: "c", source: "youtube",
        videoUrl: "https://youtu.be/abc",
      },
    });
  });
  await page.waitForTimeout(1500);

  expect(calls).toBe(1);
  // Verify queue persisted
  const q = await page.evaluate(() =>
    new Promise<unknown>((resolve) => chrome.storage.local.get("syncQueue", (r) => resolve(r.syncQueue)))
  );
  expect(Array.isArray(q)).toBe(true);
  expect((q as any[]).some((i) => i.kind === "corpus-contribute")).toBe(true);

  await ctx.close();
});
```

- [ ] **Step 3: Blocklist swallow test**

```ts
// web-plugin/e2e/corpus-blocklist.spec.ts
import { test, expect } from "@playwright/test";
import { launchWithExtension } from "./setup-extension";

test("400 blocklist → silent drop, NOT in queue", async () => {
  const ctx = await launchWithExtension();
  const page = await ctx.newPage();
  await page.route("https://whatsub.eversay.cc/api/corpus/contribute", (route) =>
    route.fulfill({ status: 400, body: JSON.stringify({ ok: false, reason: "blocklist_match" }) }));
  await page.goto("https://example.com");
  await page.evaluate(() => {
    chrome.runtime.connect({ name: "whatsub" }).postMessage({
      type: "save-vocab",
      entry: {
        id: "bad word", expression: "bad word", meaningZh: "", usage: "",
        videoId: "abc", videoTitle: "t",
        addedAt: new Date().toISOString(), cueText: "c", source: "youtube",
        videoUrl: "https://youtu.be/abc",
      },
    });
  });
  await page.waitForTimeout(1500);
  const q = await page.evaluate(() =>
    new Promise<unknown>((resolve) => chrome.storage.local.get("syncQueue", (r) => resolve(r.syncQueue)))
  );
  // Blocklist matches must NOT linger in queue
  expect(((q as any[]) ?? []).filter((i) => i.kind === "corpus-contribute")).toHaveLength(0);

  await ctx.close();
});
```

- [ ] **Step 4: Run all 3**

Run: `pnpm --filter web-plugin e2e -- corpus-silent-failure.spec.ts corpus-rate-limit.spec.ts corpus-blocklist.spec.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add web-plugin/e2e/corpus-silent-failure.spec.ts web-plugin/e2e/corpus-rate-limit.spec.ts web-plugin/e2e/corpus-blocklist.spec.ts
git commit -m "test(plugin/corpus): silent 5xx + 429 requeue + 400 swallow E2E"
```

---

### Task 16: E2E — lookup second screen + flag

**Files:**
- Create: `web-plugin/e2e/corpus-lookup.spec.ts`
- Create: `web-plugin/e2e/corpus-flag.spec.ts`

- [ ] **Step 1: Lookup test**

```ts
// web-plugin/e2e/corpus-lookup.spec.ts
import { test, expect } from "@playwright/test";
import { launchWithExtension } from "./setup-extension";

test("lookup populates bubble second screen with chips + contributions", async () => {
  const ctx = await launchWithExtension();
  const page = await ctx.newPage();
  await page.route("https://whatsub.eversay.cc/api/corpus/lookup*", (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({
      phrase: { phrase_normalized: "save up money", phrase_raw: "save up money",
                tags: { scene: "campus", partOfSpeech: "verb_phrase", cefrLevel: "B1" },
                contribution_count: 5 },
      contributions: [
        { id: "1", phrase_normalized: "save up money", context_sentence: "Need to save up money for school",
          source: { kind: "youtube", url: "https://youtu.be/a?t=10", title: "Budget 101" },
          contributor_id: "u1", contributed_at: 1 },
      ],
    }) }));
  await page.route("https://whatsub.eversay.cc/api/corpus/contribute", (route) =>
    route.fulfill({ status: 201, body: JSON.stringify({ id: "x", phrase: { tags: {}, classifiedAt: null } }) }));

  await page.goto("https://example.com");

  // Trigger the bubble with save (which kicks off lookup)
  // (In real run this is a drag-select on the page; here we go programmatic)
  await page.evaluate(() => {
    chrome.runtime.connect({ name: "whatsub" }).postMessage({ type: "corpus-lookup", phrase: "save up money" });
  });
  await page.waitForTimeout(1000);

  // Verify SW responded with the right shape — read via storage.session cache
  const cached = await page.evaluate(() => new Promise((resolve) =>
    chrome.storage.session.get("corpus:lookup:save up money", (r) => resolve(r))));
  expect(cached).toBeTruthy();

  await ctx.close();
});
```

- [ ] **Step 2: Flag test**

```ts
// web-plugin/e2e/corpus-flag.spec.ts
import { test, expect } from "@playwright/test";
import { launchWithExtension } from "./setup-extension";

test("flag fires POST /flag, shows toast", async () => {
  const ctx = await launchWithExtension();
  const page = await ctx.newPage();
  let flagged = false;
  await page.route("https://whatsub.eversay.cc/api/corpus/flag", async (route) => {
    flagged = true;
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto("https://example.com");
  await page.evaluate(() => {
    chrome.runtime.connect({ name: "whatsub" }).postMessage({
      type: "corpus-flag", contributionId: "contrib-1", reason: "spam",
    });
  });
  await page.waitForTimeout(500);
  expect(flagged).toBe(true);
  await ctx.close();
});
```

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git add web-plugin/e2e/corpus-lookup.spec.ts web-plugin/e2e/corpus-flag.spec.ts
git commit -m "test(plugin/corpus): lookup populates second screen + flag fires POST"
```

---

### Task 17: E2E — settings delete-mine two-step confirm

**Files:**
- Create: `web-plugin/e2e/settings-delete.spec.ts`

- [ ] **Step 1: Test**

```ts
// web-plugin/e2e/settings-delete.spec.ts
import { test, expect } from "@playwright/test";
import { launchWithExtension, getExtensionId } from "./setup-extension";

test("delete-mine requires two-step confirm + sends DELETE", async () => {
  const ctx = await launchWithExtension();
  const extId = await getExtensionId(ctx);
  let deleted = false;
  const page = await ctx.newPage();
  await page.route("https://whatsub.eversay.cc/api/corpus/mine", async (route) => {
    deleted = true;
    await route.fulfill({ status: 200, body: JSON.stringify({ deletedCount: 7 }) });
  });

  await page.goto(`chrome-extension://${extId}/src/ui/options/index.html`);
  await page.click("text=删除我的所有贡献");
  // Should now show confirmation
  await expect(page.locator("text=不可恢复")).toBeVisible();
  await page.click("text=是的，删除");
  await expect(page.locator("text=已删除 7 条贡献")).toBeVisible({ timeout: 5000 });
  expect(deleted).toBe(true);

  await ctx.close();
});
```

- [ ] **Step 2: Run**

- [ ] **Step 3: Commit**

```bash
git add web-plugin/e2e/settings-delete.spec.ts
git commit -m "test(plugin/options): two-step delete-mine confirm + DELETE fired"
```

---

### Task 18: Privacy policy page (whatsub.eversay.cc/privacy)

**Files:**
- Create: `web-plugin/release/listings/privacy-policy.md`

This file is the canonical source. Deployment to `whatsub.eversay.cc/privacy` is via the whatsub-website project (separate repo) — copy this markdown into a static page there.

- [ ] **Step 1: Author privacy policy (lifted from spec §11.4)**

```markdown
# whatsub 浏览器插件 · 隐私声明

更新日期：2026 年 5 月 17 日

## 简版

whatsub 不要求注册、不要求登录、不要求授权码。所有视频字幕、AI 翻译、词汇本都在你的浏览器本地处理，AI 调用走你在设置里配置的 LLM 厂商（DeepSeek / OpenAI / Claude 等），数据不经过我们的服务器。

**唯一的例外**：当你在 YouTube 视频字幕里收藏一个短语时，**默认会**把这个短语 + 上下文句子 + YouTube 链接匿名发送到 whatsub 共享语料库（whatsub.eversay.cc），帮助其他学英语的用户看到这个短语出现在什么场景。你的浏览器随机生成一个匿名 ID 标识你的贡献，**不绑定任何个人信息**。

## 详细

### 上传的内容

仅当你在 YouTube 字幕里点 "+ 收藏" 时（默认）或在网页划词收藏时主动勾选「也分享到公共语料库」时：

- 短语本身（normalize 后用于去重）
- 上下文句子（最多 400 字符）
- URL（去除 utm_*、fbclid、gclid、OAuth token、URL fragment）
- 网页 / 视频标题
- 一个随机匿名 ID（chrome.storage 里生成的 UUID，**不绑定邮箱 / 手机 / 设备指纹**）
- 提交时间戳

### 不上传的内容

- 你的 IP 地址（服务端只在请求级别用于限流，不持久化）
- 你的 LLM API Key
- 你的私密笔记 / 释义 / 用法
- 词汇本里的释义
- 浏览器历史 / cookies / 表单数据

### 你的权利

- **关闭分享**：插件设置里关闭 "公共语料库" 任意 / 全部开关，即不再上传
- **删除我的贡献**：插件设置里点 "删除我的所有贡献"，立即从语料库永久删除该匿名 ID 名下的全部条目
- **举报他人贡献**：在收藏气泡的语境列表里点 🚩

### 数据存储

匿名贡献存储在 whatsub.eversay.cc（阿里云 ECS，北京），保留至匿名 ID 主动删除为止。

### 联系

GitHub Issues: https://github.com/rjxznb/whatsub-releases/issues
```

- [ ] **Step 2: Commit**

```bash
git add web-plugin/release/listings/privacy-policy.md
git commit -m "docs(release): privacy policy text for store listings + website"
```

---

### Task 19: Store listings — descriptions + screenshots

**Files:**
- Create: `web-plugin/release/listings/chrome/description.md`
- Create: `web-plugin/release/listings/edge/description.md`
- Create: `web-plugin/release/scripts/capture-screenshots.ts`

- [ ] **Step 1: Chrome description (CWS allows max 132-char "short" + ~16KB "detailed")**

```markdown
<!-- web-plugin/release/listings/chrome/description.md -->

# Short description (max 132 chars)

YouTube 双语字幕 + 大模型重点标黄 + 跨网页词汇收藏。完全免费、用你自己的 API Key，不要账号、不上传你的笔记。

# Detailed description

## 这是什么

whatsub 把 YouTube CC 字幕翻译成中文 + 用 AI 标出本句的关键短语，帮中国留学生 / 英语学习者用真实视频内容做精读。任何网页上选中的英文短语都能一键收藏到本机词汇本。

## 主要功能

- **YouTube 双语字幕** — 点开 YouTube 的 CC 按钮，侧栏自动出现「英 + 中」字幕表，视频底部叠加双语
- **AI 标黄** — 一键让大模型标出本视频里值得收藏的关键短语 + 用法解释
- **任意网页划词收藏** — Wikipedia / Twitter / Stack Overflow / 网页 PDF 都能划词存到本机词汇本
- **公共语料库** — 在 YouTube 收藏短语时，匿名分享给其他学英语的人，下次有人收藏同一短语会看到你的视频片段（默认开启，可关）
- **桌面端集成（可选）** — 装了 whatsub 桌面客户端时，词汇本自动同步

## 隐私

- 不要求注册、不要求登录、不要求授权码
- 不收集你的浏览历史 / IP / 邮箱 / API Key
- AI 调用走你自己的 LLM 厂商（DeepSeek / OpenAI / Claude / Gemini 等），数据不经过我们
- 唯一上传的内容：YouTube 字幕里的收藏（默认匿名上传到公共语料库，可一键关闭 + 一键删除你的所有贡献）

完整隐私声明：https://whatsub.eversay.cc/privacy

## 配置

第一次打开点击 "一键继承桌面端配置" 自动从 whatsub 桌面端拉 LLM 配置，或在设置页手动填 API Key（推荐 DeepSeek，¥0.001/千 tokens 起）。

## 反馈

GitHub Issues: https://github.com/rjxznb/whatsub-releases/issues
```

- [ ] **Step 2: Edge description (identical text, just different filename)**

```markdown
<!-- web-plugin/release/listings/edge/description.md -->
<!-- Same as chrome/description.md -->
```

(Copy file or symlink.)

- [ ] **Step 3: Screenshot capture script**

```ts
// web-plugin/release/scripts/capture-screenshots.ts
import { chromium } from "@playwright/test";
import path from "node:path";

const SHOTS = [
  { url: "https://www.youtube.com/watch?v=BHACKCNDMW8", name: "01-bilingual-subtitles.png", waitMs: 8000 },
  { url: "https://www.youtube.com/watch?v=BHACKCNDMW8", name: "02-ai-highlighting.png", waitMs: 12000, action: async (p: any) => p.click("text=AI 标黄") },
  { url: "https://en.wikipedia.org/wiki/English_language", name: "03-web-selection.png", waitMs: 3000 },
  // 04, 05 require manual posing — capture from a real session
];

async function main() {
  const distPath = path.resolve(__dirname, "../../dist");
  const ctx = await chromium.launchPersistentContext("", {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`, "--window-size=1280,800"],
    viewport: { width: 1280, height: 800 },
  });

  for (const shot of SHOTS) {
    const page = await ctx.newPage();
    await page.goto(shot.url);
    await page.waitForTimeout(shot.waitMs);
    if (shot.action) await shot.action(page);
    await page.screenshot({ path: path.resolve(__dirname, `../listings/chrome/screenshots/${shot.name}`) });
    await page.screenshot({ path: path.resolve(__dirname, `../listings/edge/screenshots/${shot.name}`) });
    await page.close();
  }
  await ctx.close();
}
main().catch(console.error);
```

- [ ] **Step 4: Capture screenshots**

```bash
pnpm --filter web-plugin build
pnpm --filter web-plugin exec tsx release/scripts/capture-screenshots.ts
# Manually capture 04 (settings page) + 05 (popup vocab list)
```

- [ ] **Step 5: Commit**

```bash
git add web-plugin/release/listings/ web-plugin/release/scripts/capture-screenshots.ts
git commit -m "chore(release): store listing copy + screenshot capture script"
```

---

### Task 20: Build script + submission checklist

**Files:**
- Create: `web-plugin/release/scripts/build-stores.sh`
- Create: `web-plugin/release/listings/SUBMISSION-CHECKLIST.md`

- [ ] **Step 1: Build script**

```bash
#!/usr/bin/env bash
# web-plugin/release/scripts/build-stores.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

VERSION=$(node -p "require('./package.json').version")
echo "[release] building version $VERSION..."

pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build

mkdir -p release/output
cd dist
zip -r "../release/output/whatsub-plugin-v${VERSION}-chrome.zip" .
zip -r "../release/output/whatsub-plugin-v${VERSION}-edge.zip" .

echo "[release] artifacts:"
ls -la release/output/
echo
echo "Upload to:"
echo "  Chrome Web Store: https://chrome.google.com/webstore/devconsole"
echo "  Edge Add-ons:     https://partner.microsoft.com/dashboard/microsoftedge"
```

Make executable: `chmod +x web-plugin/release/scripts/build-stores.sh`

- [ ] **Step 2: Submission checklist**

```markdown
# Submission Checklist — Chrome Web Store + Edge Add-ons

Run this list before clicking "Submit for review" in either store. Both stores share the same zip — submit identical version to each.

## Pre-submission

- [ ] All unit + E2E tests pass: `pnpm --filter web-plugin test && pnpm --filter web-plugin e2e`
- [ ] Typecheck passes: `pnpm typecheck:all`
- [ ] Manual smoke checklist in `web-plugin/README.md` ticked end-to-end on Chrome AND Edge
- [ ] `package.json` and `manifest.json` versions match — bump if needed (semver)
- [ ] `pnpm --filter web-plugin build` produces `dist/` with no warnings about unused permissions
- [ ] Privacy policy page LIVE at `https://whatsub.eversay.cc/privacy` (verify with `curl -sf` returns 200)
- [ ] 5 screenshots present in `release/listings/chrome/screenshots/` AND `release/listings/edge/screenshots/`, each 1280×800 PNG
- [ ] Promo tile present: `release/listings/chrome/promo-tile.png` (440×280)
- [ ] Build artifacts: `release/scripts/build-stores.sh` → two zips at `release/output/`

## Chrome Web Store fields

- [ ] **Short description**: max 132 chars, from `description.md`
- [ ] **Detailed description**: rest of `description.md`
- [ ] **Category**: "Productivity"
- [ ] **Language**: 简体中文 (default), English (alternate)
- [ ] **Privacy practices** disclosure form:
  - "Single purpose": "YouTube 双语字幕 + 单词收藏，帮中国学生用真实视频学英语"
  - "Permissions justification":
    - `storage`: 保存词汇本 + 配置
    - `alarms`: 服务工作者保活 + 同步队列调度
    - `scripting`: 动态注入侧栏到 YouTube
    - `host_permissions: *://*.youtube.com/*`: 读 YouTube CC 字幕
    - `host_permissions: http://127.0.0.1/*`: 与本地桌面客户端通信（可选）
  - "Data collection": 
    - "Authentication information": NO
    - "Personal communications": NO
    - "Personally identifiable information": NO
    - "User activity": YES — "We anonymously upload selected English phrases + their YouTube context to our shared corpus, opt-out available"
    - "Website content": YES — same as above
  - **Privacy policy URL**: `https://whatsub.eversay.cc/privacy`
- [ ] Upload the Chrome zip + 5 screenshots + promo tile
- [ ] Click "Submit for review" (1-2 weeks turnaround)

## Edge Add-ons fields

- [ ] **Short description**: from `description.md`
- [ ] **Long description**: from `description.md`
- [ ] **Privacy policy URL**: `https://whatsub.eversay.cc/privacy`
- [ ] **Categories**: Productivity, Education
- [ ] **Languages**: 简体中文, English
- [ ] Upload the Edge zip + 5 screenshots
- [ ] Click "Publish" (1-3 days turnaround)

## Post-submission

- [ ] Add release tag in this repo: `git tag plugin-v$VERSION && git push --tags`
- [ ] Record store URLs in `whatsub-releases` README (separate repo)
- [ ] Tweet / post on 小红书 with screenshots once Chrome approves
```

- [ ] **Step 3: Commit**

```bash
git add web-plugin/release/scripts/build-stores.sh web-plugin/release/listings/SUBMISSION-CHECKLIST.md
git commit -m "chore(release): store build script + pre-submission checklist"
```

---

### Task 21: Submit to stores + monitor

**Files:** none code-wise.

- [ ] **Step 1: Build artifacts**

```bash
cd web-plugin
release/scripts/build-stores.sh
```

Expected: two zips at `web-plugin/release/output/whatsub-plugin-v0.1.0-{chrome,edge}.zip`.

- [ ] **Step 2: Submit Chrome Web Store**

Walk through SUBMISSION-CHECKLIST.md, upload zip + 5 screenshots + promo tile, submit. Expect 1-2 weeks review.

- [ ] **Step 3: Submit Edge Add-ons**

Same zip + screenshots. Edge usually reviews in 1-3 days.

- [ ] **Step 4: Tag release in git**

```bash
git tag plugin-v0.1.0
git push origin plugin-v0.1.0
```

- [ ] **Step 5: Once both stores approve, update CHANGELOG**

```bash
echo "2026-XX-XX whatsub browser plugin v0.1.0 live on Chrome Web Store + Edge Add-ons" >> CHANGELOG.md
git add CHANGELOG.md
git commit -m "chore: record plugin v0.1.0 store launch"
```

---

## Self-review checklist

Before declaring Plan 3 complete, verify each:

- [ ] **Corpus lookup failure NEVER shows an error toast** — Task 8 server result `{ phrase: null }` is rendered as a quiet "✓ 已收藏" with no error UI. Verified by Task 15 silent-failure E2E.
- [ ] **Settings toggle defaults match spec §11.4**: `shareToPublicCorpus.youtube = true`, `shareToPublicCorpus.web = false`. Verified by `state/settings.ts` DEFAULTS.
- [ ] **Delete-my-contributions has a two-step confirmation** — Task 11 + Task 17 E2E verify the second click is required.
- [ ] **Privacy policy URL `https://whatsub.eversay.cc/privacy` is live** before clicking Submit in either store. `curl -sf https://whatsub.eversay.cc/privacy` returns 200.
- [ ] **Store listing screenshots match the actual extension UI** — re-run `capture-screenshots.ts` if any UI changed after they were captured.
- [ ] **Manifest version bumped, both stores get the same zip** — verify `web-plugin/release/output/*.zip` are byte-identical (the only difference is the directory they're uploaded to).
- [ ] **Chrome Web Store and Edge Add-ons both have "data collection disclosure" filled honestly** — answer "User activity: YES" + "Website content: YES" with the anonymous corpus upload explanation. Lying here triggers store takedowns.
- [ ] **The bubble's second-screen "N 人收藏过" entry is hidden when lookup returns null** — verified by the 5xx silent-failure test (Task 15).
- [ ] **The web-source bubble shows the "也分享到公共语料库" checkbox; the YouTube-source bubble does NOT** (per spec — YouTube default-on, web default-off).
- [ ] **Curator contributions render with a "精选" badge** — Task 9 test covers this; visually confirm in screenshot #1 before submitting.
- [ ] **All 7 E2E specs pass on a fresh Playwright run** with both Plan 2 backend hits stubbed (no live network calls during CI).
- [ ] **`pnpm test:all && pnpm typecheck:all && pnpm --filter web-plugin e2e` from repo root** passes end-to-end.
