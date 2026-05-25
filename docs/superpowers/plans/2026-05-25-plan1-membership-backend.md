# 会员配额体系 · Plan 1（后端 whatsub-license）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **仓库**:`C:\Users\renjx\Desktop\whatsub-license`(独立 git 仓,**不是** Get_Video)。所有命令在该仓根目录执行。
> **提交规范**:每个 commit 消息末尾加一行 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。
> **Spec**:`Get_Video/docs/superpowers/specs/2026-05-25-whatsub-membership-quotas-design.md`

**Goal:** 在后端把"统一邮箱会员"接上两个配额——个人语料库(免费 50 / 会员 1000,新建)和云端 Library 视频(免费 3 / 会员 50,修现有 bug),会员判定统一为 `isMember`(license OR iOS 买断 OR iOS 订阅,**不含试用**)。

**Architecture:** 新增 `isMember()` 纯函数(auth.ts)作为**配额分档**判定;顺手修 `hasCorpusAccess()` 把漏掉的 iOS 订阅补进(浏览门槛)。语料库 contribute 入口加 count 上限(复用现有 `{ok:false,reason}` envelope,reason=`quota_exceeded`)。Library 已有的 `quotaLimitFor` 从"只看 `iosSubActive`"改为"用 `isMember`"。四个上限数走 env(默认 50/1000/3/50)。

**Tech Stack:** TypeScript · Hono · node-postgres(`pg.Pool`)· pg-mem(测试用内存 Postgres)· Vitest。

---

## 与 Spec 的偏差（实现按本 plan 为准,spec 待回填）

1. **错误形状**:spec D6 写的 `limit_reached{quota,cap,tier}`。实际代码 Library 已用 `quota_exceeded{used,limit}`;为一致,**语料库也用 `quota_exceeded`**(走语料库的 `{ok:false,reason}` envelope:`{ok:false,reason:"quota_exceeded",used,limit}`)。
2. **Library 不是新建**:`quotaLimitFor` 已存在且数字(3/50)已对,只是会员判定错(只看 `iosSubActive`)。本 plan 是**修**它。
3. **配额按 `videoKey` 计数**:Library 只对"带 OSS 视频的同步"计数(`ownerVideoCount`),非视频条目不占额——保持现状不动。

---

## 文件结构

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/lib/auth.ts` | 会员/权益判定 | **新增** `isMember`;**改** `hasCorpusAccess` 补 `iosSubActive` |
| `src/lib/db.ts` | 所有 SQL | **新增** `countCorpusContributions(contributorId)` |
| `src/routes/corpus.ts` | 语料库路由 | **新增**两个 env 常量 + contribute 里的 count 上限 |
| `src/routes/library.ts` | Library 路由 | **改** `quotaLimitFor` 用 `isMember` + 两个 env 常量;更新 3 处调用点传 `hasLicense` |
| `tests/auth-membership.test.ts` | 新测试 | **新建** |
| `tests/corpus-routes.test.ts` | 语料库测试 | **追加** count 上限用例 |
| `tests/library-routes.test.ts` | Library 测试 | **追加** 会员分档用例 |

---

## Task 1: `isMember` 判定 + 修 `hasCorpusAccess` 补 iOS 订阅

**Files:**
- Modify: `src/lib/auth.ts`（`hasCorpusAccess` 在文件末尾附近;在其前面加 `isMember`）
- Test: `tests/auth-membership.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/auth-membership.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/lib/db.js';
import { isMember, hasCorpusAccess } from '../src/lib/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeDb(): Database {
  const mem = newDb();
  const sql = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf-8');
  mem.public.none(sql);
  const adapter = mem.adapters.createPg();
  return new Database(new adapter.Pool());
}

describe('isMember (配额分档,不含试用)', () => {
  it('无任何权益 → false', async () => {
    const db = makeDb();
    expect(await isMember(db, 'none@x.com', false, Date.now())).toBe(false);
  });

  it('hasLicense=true → true', async () => {
    const db = makeDb();
    expect(await isMember(db, 'lic@x.com', true, Date.now())).toBe(true);
  });

  it('iOS 买断 → true', async () => {
    const db = makeDb();
    await db.grantBuyout('buy@x.com', 'txn-buy', Date.now());
    expect(await isMember(db, 'buy@x.com', false, Date.now())).toBe(true);
  });

  it('iOS 订阅(有效)→ true', async () => {
    const db = makeDb();
    const now = Date.now();
    await db.setSubscription('sub@x.com', now + 86_400_000, 'cc.eversay.whatsub.mobile.year', 'txn-sub', now);
    expect(await isMember(db, 'sub@x.com', false, now)).toBe(true);
  });

  it('仅试用 → isMember=false,但 hasCorpusAccess=true', async () => {
    const db = makeDb();
    const now = Date.now();
    await db.ensureTrialStarted('trial@x.com', now);
    expect(await isMember(db, 'trial@x.com', false, now)).toBe(false);
    expect(await hasCorpusAccess(db, 'trial@x.com', false, now)).toBe(true);
  });

  it('回归:iOS 订阅也算 hasCorpusAccess(修复前为 false)', async () => {
    const db = makeDb();
    const now = Date.now();
    await db.setSubscription('sub2@x.com', now + 86_400_000, 'cc.eversay.whatsub.mobile.year', 'txn-sub2', now);
    expect(await hasCorpusAccess(db, 'sub2@x.com', false, now)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/auth-membership.test.ts`
Expected: FAIL —— `isMember` 未导出(`isMember is not a function`),以及"iOS 订阅 hasCorpusAccess"用例为 false。

- [ ] **Step 3: 实现**

在 `src/lib/auth.ts` 中,把现有 `hasCorpusAccess` 整段:

```typescript
export async function hasCorpusAccess(
  db: Database, email: string, hasLicense: boolean, now: number,
): Promise<boolean> {
  if (hasLicense) return true;
  const ent = await db.getIosEntitlements(email, now);
  if (ent.iosBuyout) return true;
  return ent.trialExpiresAt != null && ent.trialExpiresAt > now;
}
```

替换为(新增 `isMember`,并让 `hasCorpusAccess` 也认订阅):

```typescript
/**
 * 配额分档判定:付费会员 = website license OR iOS 买断 OR iOS 订阅。
 * **不含试用** —— 24h 试用不享会员配额(防薅 OSS)。`hasLicense` 由
 * requireSession 预先放进 context。
 */
export async function isMember(
  db: Database, email: string, hasLicense: boolean, now: number,
): Promise<boolean> {
  if (hasLicense) return true;
  const ent = await db.getIosEntitlements(email, now);
  return ent.iosBuyout || ent.iosSubActive;
}

/**
 * 公共语料库浏览门槛 = isMember OR 有效试用。注意:**含试用**,与 isMember
 * 的唯一区别就是试用。
 */
export async function hasCorpusAccess(
  db: Database, email: string, hasLicense: boolean, now: number,
): Promise<boolean> {
  if (hasLicense) return true;
  const ent = await db.getIosEntitlements(email, now);
  if (ent.iosBuyout || ent.iosSubActive) return true;
  return ent.trialExpiresAt != null && ent.trialExpiresAt > now;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test tests/auth-membership.test.ts`
Expected: PASS（6 个用例全过）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/auth.ts tests/auth-membership.test.ts
git commit -m "feat(auth): add isMember + fix hasCorpusAccess to count iOS subscription"
```

---

## Task 2: 语料库个人配额 count 上限（新建）

**Files:**
- Modify: `src/lib/db.ts`（在 corpus 区域加 `countCorpusContributions`,可放在 `contributeCorpus` 方法附近,约 line 833 之后）
- Modify: `src/routes/corpus.ts`（文件顶部加常量;`POST /contribute` handler 的 blocklist 检查之后加 count 上限,约 line 175）
- Test: `tests/corpus-routes.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `tests/corpus-routes.test.ts` 末尾(最后一个 `});` 之前的顶层)追加。注意:**不能用循环 POST 灌满**(会撞 minute:5 rate limit),要用 `db.contributeCorpus` 直接预灌,再 POST 第 51 条触发上限。`makeApp` / `insertSessionFor` 沿用文件内已有 helper;`createHash` 已在文件顶部 import。

```typescript
describe('个人语料库 count 上限', () => {
  // 直接灌 N 条(绕过 rate limit),contributorId 与路由派生方式一致。
  async function prefill(db: Database, email: string, n: number) {
    const contributorId = createHash('sha256').update(email, 'utf8').digest('hex').slice(0, 16);
    for (let i = 0; i < n; i++) {
      await db.contributeCorpus({
        phraseRaw: `phrase ${i}`,
        phraseNormalized: `phrase ${i}`,
        contextSentence: 'ctx',
        source: { kind: 'webpage', url: 'https://e.com/a' },
        contributorId,
        now: Date.now(),
      });
    }
  }

  async function postOne(rig: AppRig, token: string) {
    return rig.app.request('/api/corpus/contribute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        phraseRaw: 'one more',
        contextSentence: 'one more please',
        source: { kind: 'webpage', url: 'https://e.com/b' },
      }),
    });
  }

  it('免费用户存到 50 后,第 51 条 → 403 quota_exceeded', async () => {
    const rig = makeApp();
    const email = 'capfree@x.com';
    await prefill(rig.db, email, 50);
    const token = await insertSessionFor(rig.db, email);
    const res = await postOne(rig, token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; reason: string; used: number; limit: number };
    expect(body.reason).toBe('quota_exceeded');
    expect(body.limit).toBe(50);
    expect(body.used).toBe(50);
  });

  it('会员(有 license)存到 50 仍可继续(上限 1000)', async () => {
    const rig = makeApp();
    const email = 'capmember@x.com';
    // 直接给该邮箱发一张 license → requireSession 算出 hasActiveLicense=true
    rig.mem.public.none(
      `INSERT INTO licenses (key, email, max_devices, created_at) VALUES ('mk1', '${email}', 3, 1)`,
    );
    await prefill(rig.db, email, 50);
    const token = await insertSessionFor(rig.db, email);
    const res = await postOne(rig, token);
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/corpus-routes.test.ts`
Expected: FAIL —— 免费用例拿到 201(还没有上限),期望 403。

- [ ] **Step 3a: 加 db 方法**

在 `src/lib/db.ts` 中 `contributeCorpus` 方法之后,加:

```typescript
/** 统计某 contributor 的个人语料条数(配额判定用)。 */
async countCorpusContributions(contributorId: string): Promise<number> {
  const { rows } = await this.pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM corpus_contributions WHERE contributor_id = $1`,
    [contributorId],
  );
  return parseInt(rows[0]?.n ?? '0', 10);
}
```

- [ ] **Step 3b: 加 route 常量 + 上限检查**

在 `src/routes/corpus.ts` 顶部(`const CURATOR_ID = 'whatsub-curator';` 那行附近)加:

```typescript
const CORPUS_FREE = parseInt(process.env.CORPUS_FREE_LIMIT ?? '50', 10);
const CORPUS_MEMBER = parseInt(process.env.CORPUS_MEMBER_LIMIT ?? '1000', 10);
```

并把 `isMember` 加进 auth 的 import(第 7 行):

```typescript
import { requireSession, requireCorpusAccess, hasCorpusAccess, isMember } from '../lib/auth.js';
```

在 `POST /contribute` handler 里,**紧接** blocklist 检查那段之后:

```typescript
  if (await db.isPhraseBlocked(normalized)) {
    return c.json({ ok: false, reason: 'blocklist_match' }, 400);
  }
```

插入:

```typescript
  // 个人语料库 count 上限(按会员分档)。curator 豁免(其 dual-write 用
  // CURATOR_ID,不计入用户自己的额度)。
  if (!isExempt(contributorId)) {
    const used = await db.countCorpusContributions(contributorId);
    const hasLicense = c.get('hasActiveLicense' as never) as boolean;
    const limit = (await isMember(db, email, hasLicense, Date.now())) ? CORPUS_MEMBER : CORPUS_FREE;
    if (used >= limit) {
      return c.json({ ok: false, reason: 'quota_exceeded', used, limit }, 403);
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test tests/corpus-routes.test.ts`
Expected: PASS（含原有用例 + 2 个新用例）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/db.ts src/routes/corpus.ts tests/corpus-routes.test.ts
git commit -m "feat(corpus): per-user personal-corpus count cap (free 50 / member 1000)"
```

---

## Task 3: Library 配额改用统一 `isMember`（修 bug）

**Files:**
- Modify: `src/routes/library.ts`（顶部加常量;`quotaLimitFor` 改用 `isMember`;3 处调用点 `/sync`、`/import-queue`、`/quota` 传 `hasLicense`）
- Test: `tests/library-routes.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `tests/library-routes.test.ts` 末尾追加。`makeApp` / `insertSessionFor` 沿用文件内已有 helper(若无 `mem` 暴露,见 Step 备注)。

```typescript
describe('Library 配额按统一会员分档', () => {
  async function getQuota(rig: ReturnType<typeof makeApp>, token: string) {
    const res = await rig.app.request('/api/library/quota', {
      headers: { authorization: `Bearer ${token}` },
    });
    return (await res.json()) as { used: number; limit: number };
  }

  it('普通用户 → limit 3', async () => {
    const rig = makeApp();
    const token = await insertSessionFor(rig.db, 'plain@x.com');
    expect((await getQuota(rig, token)).limit).toBe(3);
  });

  it('有 website license → limit 50(修复前为 3)', async () => {
    const rig = makeApp();
    const email = 'liclib@x.com';
    rig.mem.public.none(
      `INSERT INTO licenses (key, email, max_devices, created_at) VALUES ('lk-lib', '${email}', 3, 1)`,
    );
    const token = await insertSessionFor(rig.db, email);
    expect((await getQuota(rig, token)).limit).toBe(50);
  });

  it('iOS 买断 → limit 50(修复前为 3)', async () => {
    const rig = makeApp();
    await rig.db.grantBuyout('buylib@x.com', 'txn-bl', Date.now());
    const token = await insertSessionFor(rig.db, 'buylib@x.com');
    expect((await getQuota(rig, token)).limit).toBe(50);
  });
});
```

> 备注:若 `library-routes.test.ts` 的 `makeApp` 没有把 `mem` 一并返回(corpus 测试的 rig 含 `mem`),先把它的 `makeApp` 返回值加上 `mem`(与 `tests/corpus-routes.test.ts` 的 `AppRig` 一致),再写上面用例。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/library-routes.test.ts`
Expected: FAIL —— "license → 50" 和 "买断 → 50" 拿到 3(当前 `quotaLimitFor` 只看 `iosSubActive`)。

- [ ] **Step 3: 实现**

在 `src/routes/library.ts` 顶部 import 加 `isMember`:

```typescript
import { requireSession, isMember } from '../lib/auth.js';
```

(原第 3 行是 `import { requireSession } from '../lib/auth.js';`,改成上面这行。)

文件顶部 `export function libraryRoute(db: Database) {` 之前加常量:

```typescript
const LIBRARY_FREE = parseInt(process.env.LIBRARY_FREE_LIMIT ?? '3', 10);
const LIBRARY_MEMBER = parseInt(process.env.LIBRARY_MEMBER_LIMIT ?? '50', 10);
```

把现有 `quotaLimitFor`:

```typescript
  const quotaLimitFor = async (email: string) => {
    const ent = await db.getIosEntitlements(email, Date.now());
    return ent.iosSubActive ? 50 : 3;
  };
```

替换为(改用 `isMember`,接收 `hasLicense`):

```typescript
  const quotaLimitFor = async (email: string, hasLicense: boolean) => {
    return (await isMember(db, email, hasLicense, Date.now())) ? LIBRARY_MEMBER : LIBRARY_FREE;
  };
```

然后更新 3 处调用点,都在 `requireSession` 之后,可读 `c.get('hasActiveLicense')`:

`/sync`(约 line 53):
```typescript
      const limit = await quotaLimitFor(email, c.get('hasActiveLicense' as never) as boolean);
```

`/import-queue`(约 line 130):
```typescript
    const limit = await quotaLimitFor(email, c.get('hasActiveLicense' as never) as boolean);
```

`/quota`(约 line 96):
```typescript
    return c.json({ used, limit: await quotaLimitFor(email, c.get('hasActiveLicense' as never) as boolean) });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test tests/library-routes.test.ts`
Expected: PASS（普通 3 / license 50 / 买断 50）。

- [ ] **Step 5: 提交**

```bash
git add src/routes/library.ts tests/library-routes.test.ts
git commit -m "fix(library): tier video quota by unified isMember (license/buyout/sub), not iosSubActive only"
```

---

## Task 4: 全量回归 + 文档

- [ ] **Step 1: 跑全套测试**

Run: `pnpm test`
Expected: 全绿(原有用例 + 新增 3 文件用例)。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 3: 更新 CLAUDE.md / .env 文档**

在 `whatsub-license/CLAUDE.md`(或 `.env.example`,若存在)记录 4 个新 env:`CORPUS_FREE_LIMIT=50` / `CORPUS_MEMBER_LIMIT=1000` / `LIBRARY_FREE_LIMIT=3` / `LIBRARY_MEMBER_LIMIT=50`(都可选,有默认)。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "docs(env): document corpus/library quota limit env vars"
```

---

## 部署提醒（实现完成后,非本 plan 自动执行）

- 无 schema 变更(复用现有列),**不需要** scp schema.sql。
- 走既有部署流程:`docker buildx build --load` → `docker save | gzip | scp` → `ssh: docker load + compose up -d`(见 whatsub-license/CLAUDE.md)。
- 部署前可在生产临时设 env 调数(默认值已是目标值,通常无需设)。

---

## 自检对照（Spec → Task）

| Spec 要求 | 落点 |
|---|---|
| §3.2 `hasCorpusAccess` 补 iosSubActive | Task 1 |
| §3.1 新增 `isMember`(不含试用) | Task 1 |
| §4.1 语料库 免费 50 / 会员 1000 拦截 | Task 2 |
| §4.2 Library 免费 3 / 会员 50(改会员判定) | Task 3 |
| §4.3 4 个数字 env 可配 | Task 2 + 3(常量)+ Task 4(文档) |
| §0.4/§9 撞限非静默(reason 可被客户端识别) | `quota_exceeded` reason(客户端 Plan 2/3 消费) |
| curator 豁免 | Task 2(`isExempt`) |

> 客户端处理(插件 `quota_exceeded` 升级卡 + 可靠队列;桌面 Library 升级提示)在 **Plan 2 / Plan 3**,不在本 plan。
