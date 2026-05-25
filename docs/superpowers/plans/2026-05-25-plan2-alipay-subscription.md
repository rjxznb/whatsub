# 会员配额体系 · Plan 2(支付宝订阅产品)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 superpowers:executing-plans,逐任务实现。步骤用 `- [ ]` 勾选。
>
> **仓库**:`C:\Users\renjx\Desktop\whatsub-license`(独立 git 仓)。所有命令在该仓根目录。
> **分支**:接着 Plan 1 的 `feat/membership-quotas`(已含 Part A:`hasActiveSubscription` + `web_subscriptions` 表 + `setWebSubscription`/`getWebSubExpiry`)。
> **提交规范**:commit 消息末尾加 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。
> **前置依赖(Part A,已完成)**:`db.setWebSubscription(email, addMs, product, now)`、`db.getWebSubExpiry(email)`、`hasActiveSubscription` 已存在;`web_subscriptions` 表已建。本 plan 只负责"**怎么往里写**"(支付宝订阅下单+履约)。

**Goal:** 新增支付宝"订阅"子产品(`sub_month` ¥12 / `sub_year` ¥88,时段制 = 买 N 个月),走现有支付宝电脑网站支付;结算时不发 license,而是 `setWebSubscription` 发放/续期时段会员 → 点亮高档配额(语料库 1000 + Library 50)。

**Architecture:** 复用现有 `/api/payment/*` 流。`orders` 加 `product` 列区分 license / sub_month / sub_year。create-order 按 product 取价(订阅用固定 SKU 价,不走优惠码)。结算(notify + status 查询两条路)按 `order.product` 分叉:订阅 → 新 `db.markOrderPaidAndGrantSubscription`(原子 claim + `setWebSubscription`,不发 license/邮件);license → 照旧。

**Tech Stack:** TypeScript · Hono · node-postgres · pg-mem · Vitest · alipay-sdk(已封装在 `lib/alipay.ts`)。

---

## 关键设计决策

1. **时段制(方式1)**:一次性付款 → `setWebSubscription(email, 时长ms, product, now)`,已有效则**累加续期**。非自动续费。
2. **订阅不走优惠码**:`create-order` 收到 sub SKU 时跳过 promo 逻辑,用固定 SKU 价。
3. **订阅不发 license、不发 license 邮件**:成功页靠轮询 `/status` 显示"会员已开通"。`/status` 对订阅订单多返一个 `product` 字段供前端区分。
4. **幂等**:`markOrderPaidAndGrantSubscription` 用 `UPDATE ... WHERE status='pending' RETURNING email` 原子 claim —— 只有抢到的那次 notify 才 `setWebSubscription`,重复 notify 不会重复续期。
5. **时长**:`sub_month = 30 天`,`sub_year = 365 天`(与 Part A 测试一致)。
6. **价格**:月 ¥12 / 年 ¥88,走 env `SUB_MONTH_PRICE_CNY` / `SUB_YEAR_PRICE_CNY`(与 iOS 订阅价对齐)。

---

## 文件结构

| 文件 | 改动 |
|---|---|
| `schema.sql` | `ALTER TABLE orders ADD COLUMN IF NOT EXISTS product TEXT;` |
| `src/lib/types.ts` | `OrderRow` 加 `product?: string \| null`(+ `appliedPromotion?`) |
| `src/lib/db.ts` | `createOrder` 加 `product`;`RawOrderRow`/`getOrder`/`mapOrderRow` 带 `product`;新增 `markOrderPaidAndGrantSubscription` |
| `src/index.ts` | `PaymentWiring` 加两个 SKU 价 + `requireEnv` + 传入 |
| `src/routes/payment.ts` | SKU 表/常量;create-order 按 product 分叉取价+存 product;notify + status 两处结算按 product 分叉;`/status` 多返 product |
| `.env.example` | 加 `SUB_MONTH_PRICE_CNY=12` / `SUB_YEAR_PRICE_CNY=88` |
| `tests/payment.test.ts` | 订阅下单→notify→发放;status 查询路径;续期累加;价格解析 |

---

## Task 1: orders.product 列 + db 方法

**Files:** `schema.sql`、`src/lib/types.ts`、`src/lib/db.ts`、`tests/db.test.ts`(或 payment.test.ts)

- [ ] **Step 1: 写失败测试**(在 `tests/payment.test.ts` 顶层新增,验证 db 层)

```typescript
describe('orders.product + markOrderPaidAndGrantSubscription', () => {
  it('createOrder 存 product;getOrder 取回', async () => {
    const db = await freshDb();
    await db.createOrder({ outTradeNo: 'o1', email: 'a@x.com', amountCny: '12.00', createdAt: 0, product: 'sub_month' });
    const o = await db.getOrder('o1');
    expect(o!.product).toBe('sub_month');
  });

  it('markOrderPaidAndGrantSubscription:原子 claim + 发放会员,不发 license', async () => {
    const db = await freshDb();
    const now = Date.now();
    await db.createOrder({ outTradeNo: 'o2', email: 'sub@x.com', amountCny: '12.00', createdAt: 0, product: 'sub_month' });
    const r = await db.markOrderPaidAndGrantSubscription({
      outTradeNo: 'o2', alipayTradeNo: 'ali2', paidAt: now, notifyPayload: {}, addMs: 30 * 86400_000, product: 'sub_month', now,
    });
    expect(r.claimed).toBe(true);
    expect(r.email).toBe('sub@x.com');
    expect((await db.getOrder('o2'))!.status).toBe('paid');
    expect((await db.getOrder('o2'))!.licenseKey).toBeNull();
    expect(await db.getWebSubExpiry('sub@x.com')).toBeGreaterThan(now);
  });

  it('重复 claim 幂等:第二次 claimed=false,不重复续期', async () => {
    const db = await freshDb();
    const now = Date.now();
    await db.createOrder({ outTradeNo: 'o3', email: 's3@x.com', amountCny: '12.00', createdAt: 0, product: 'sub_month' });
    const first = await db.markOrderPaidAndGrantSubscription({ outTradeNo: 'o3', alipayTradeNo: 'a', paidAt: now, notifyPayload: {}, addMs: 30 * 86400_000, product: 'sub_month', now });
    const exp1 = await db.getWebSubExpiry('s3@x.com');
    const second = await db.markOrderPaidAndGrantSubscription({ outTradeNo: 'o3', alipayTradeNo: 'a', paidAt: now, notifyPayload: {}, addMs: 30 * 86400_000, product: 'sub_month', now });
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(await db.getWebSubExpiry('s3@x.com')).toBe(exp1); // 没二次累加
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/payment.test.ts`
Expected: FAIL —— `product` 不存在 / `markOrderPaidAndGrantSubscription` 未定义。

- [ ] **Step 3a: schema** —— 在 `schema.sql` 现有 `ALTER TABLE orders ADD COLUMN IF NOT EXISTS applied_promotion TEXT;` 那行后加:

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS product TEXT;
```

- [ ] **Step 3b: types.ts** —— `OrderRow`(约 line 30-40)在 `notifyPayload` 后加:

```typescript
  appliedPromotion?: string | null;
  product?: string | null;
```

- [ ] **Step 3c: db.ts createOrder**(约 282-303)—— input 接口加 `product?: string | null;`(在 `appliedPromotion?` 后),INSERT 改为:

```typescript
    `INSERT INTO orders (out_trade_no, email, amount_cny, created_at, applied_promotion, product)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.outTradeNo,
      input.email,
      input.amountCny,
      input.createdAt,
      input.appliedPromotion ?? null,
      input.product ?? null,
    ],
```

- [ ] **Step 3d: db.ts RawOrderRow + getOrder + mapOrderRow** —— `RawOrderRow`(约 72-82)加 `applied_promotion: string | null;` 和 `product: string | null;`;`getOrder` 的 SELECT 改为:

```typescript
    `SELECT out_trade_no, email, amount_cny, status, alipay_trade_no,
            license_key, created_at, paid_at, notify_payload, applied_promotion, product
     FROM   orders WHERE out_trade_no = $1`,
```

`mapOrderRow`(约 483-495)return 对象加:

```typescript
    appliedPromotion: r.applied_promotion,
    product: r.product,
```

- [ ] **Step 3e: db.ts 新方法** —— 在 `markOrderPaidAndMintLicense`(约 514-586)之后加:

```typescript
  /** 订阅订单结算:原子 claim(status pending→paid)后发放/续期时段会员。
   *  与 mint-license 同款幂等:只有抢到 pending 的那次才 setWebSubscription。
   *  订阅不发 license,licenseKey 永远为 null。 */
  async markOrderPaidAndGrantSubscription(input: {
    outTradeNo: string;
    alipayTradeNo: string;
    paidAt: number;
    notifyPayload: Record<string, unknown>;
    addMs: number;
    product: string;
    now: number;
  }): Promise<{ claimed: boolean; email: string | null; expiresAt: number | null }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claim = await client.query<{ email: string }>(
        `UPDATE orders
         SET    status = 'paid', alipay_trade_no = $2, paid_at = $3, notify_payload = $4
         WHERE  out_trade_no = $1 AND status = 'pending'
         RETURNING email`,
        [input.outTradeNo, input.alipayTradeNo, input.paidAt, JSON.stringify(input.notifyPayload)],
      );
      if (claim.rows.length === 0) {
        await client.query('COMMIT');
        return { claimed: false, email: null, expiresAt: null };
      }
      const email = claim.rows[0]!.email;
      // setWebSubscription 自身是独立查询;在同一事务外执行也安全(claim 已落),
      // 但为简单直接复用 pool 方法(它用 this.pool,不在本 client 事务内)。
      await client.query('COMMIT');
      const expiresAt = await this.setWebSubscription(email, input.addMs, input.product, input.now);
      return { claimed: true, email, expiresAt };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
```

> 注:`setWebSubscription` 在 COMMIT 之后调用 —— claim 已是幂等闸门,确保只有一次 notify 能走到这。即使 setWebSubscription 失败,订单已 paid;可靠性足够(支付宝会重试 notify,但 claim 已 false → 不会重复续期;补偿可后续加,MVP 不需要)。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test tests/payment.test.ts`
Expected: PASS(3 个新 db 用例 + 原有 payment 用例)。

- [ ] **Step 5: 提交**

```bash
git add schema.sql src/lib/types.ts src/lib/db.ts tests/payment.test.ts
git commit -m "feat(orders): add product column + markOrderPaidAndGrantSubscription"
```

---

## Task 2: SKU 价格配置(PaymentDeps + index 接线)

**Files:** `src/index.ts`、`src/routes/payment.ts`、`.env.example`

- [ ] **Step 1: payment.ts PaymentDeps** —— 接口(约 8-14)加两个字段:

```typescript
interface PaymentDeps {
  db: Database;
  alipay: AlipayClient;
  mail: MailService;
  priceCny: string;
  productName: string;
  subMonthPriceCny: string;
  subYearPriceCny: string;
}
```

- [ ] **Step 2: index.ts PaymentWiring + 接线** —— `PaymentWiring`(约 30-35)加 `subMonthPriceCny: string; subYearPriceCny: string;`;`mountPaymentRoutes` 调用(约 116-123)加 `subMonthPriceCny: payment.subMonthPriceCny, subYearPriceCny: payment.subYearPriceCny,`;`buildApp` 调用(约 203-214)的 payment 对象加:

```typescript
      subMonthPriceCny: requireEnv('SUB_MONTH_PRICE_CNY'),
      subYearPriceCny: requireEnv('SUB_YEAR_PRICE_CNY'),
```

- [ ] **Step 3: .env.example** —— 在 `LICENSE_PRODUCT_NAME` 那段后加:

```
# 会员订阅 SKU 价(与 iOS 订阅价对齐)
SUB_MONTH_PRICE_CNY=12
SUB_YEAR_PRICE_CNY=88
```

- [ ] **Step 4: typecheck** —— `pnpm typecheck`,Expected: 无错误(payment.test.ts 的 `buildApp` deps 类型下一任务补)。

> 本任务无独立测试(纯接线);Task 3 的测试覆盖它。先不提交,与 Task 3 一起提交。

---

## Task 3: create-order 支持订阅 SKU

**Files:** `src/routes/payment.ts`、`tests/payment.test.ts`

- [ ] **Step 1: 写失败测试**(payment.test.ts;先更新 `buildApp` helper 的 deps 类型加两个价字段并传 `subMonthPriceCny:'12', subYearPriceCny:'88'`,再加用例)

```typescript
describe('create-order 订阅 SKU', () => {
  it('product=sub_month → 用月价、存 product、subject 含会员', async () => {
    const db = await freshDb();
    const alipay = makeMockAlipay();
    (alipay.createPagePay as any).mockResolvedValue('https://pay/x');
    const app = buildApp({ db, alipay, mail: makeMockMail(), priceCny: '29.90', productName: 'x', subMonthPriceCny: '12', subYearPriceCny: '88' });
    const res = await app.request('/api/payment/create-order', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'm@x.com', product: 'sub_month' }),
    });
    expect(res.status).toBe(200);
    const { outTradeNo } = (await res.json()) as { outTradeNo: string };
    expect((await db.getOrder(outTradeNo))!.product).toBe('sub_month');
    expect((await db.getOrder(outTradeNo))!.amountCny).toBe('12.00');
    expect((alipay.createPagePay as any).mock.calls[0][0].totalAmount).toBe('12');
  });

  it('product=sub_year → 用年价 88', async () => {
    const db = await freshDb();
    const alipay = makeMockAlipay();
    (alipay.createPagePay as any).mockResolvedValue('https://pay/y');
    const app = buildApp({ db, alipay, mail: makeMockMail(), priceCny: '29.90', productName: 'x', subMonthPriceCny: '12', subYearPriceCny: '88' });
    const res = await app.request('/api/payment/create-order', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'y@x.com', product: 'sub_year' }),
    });
    const { outTradeNo } = (await res.json()) as { outTradeNo: string };
    expect((await db.getOrder(outTradeNo))!.amountCny).toBe('88.00');
  });
});
```

> 注:`amountCny` 经 NUMERIC(10,2) 存取后是 `'12.00'`;传给 alipay 的 `totalAmount` 是下单时的原始字符串 `'12'`。两个断言分别覆盖。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/payment.test.ts`
Expected: FAIL —— 订阅订单仍走 license 价(29.90)、product 为 null。

- [ ] **Step 3: 实现** —— `src/routes/payment.ts` 顶部(`EMAIL_RE` 附近)加 SKU 表:

```typescript
const SUB_PRODUCTS = {
  sub_month: { ms: 30 * 24 * 60 * 60 * 1000, subject: 'whatSub 会员 · 月度' },
  sub_year: { ms: 365 * 24 * 60 * 60 * 1000, subject: 'whatSub 会员 · 年度' },
} as const;
type SubProduct = keyof typeof SUB_PRODUCTS;
function isSubProduct(p: unknown): p is SubProduct {
  return p === 'sub_month' || p === 'sub_year';
}
```

`create-order` handler 在解析 body 后、promo 逻辑前分叉。把 body 类型加 `product?`:

```typescript
    let body: { email?: string; promoCode?: string; product?: string };
```

在 email 校验之后插入订阅分支(订阅直接下单,跳过 promo):

```typescript
    if (isSubProduct(body.product)) {
      const product = body.product;
      const amountCny = product === 'sub_month' ? deps.subMonthPriceCny : deps.subYearPriceCny;
      const outTradeNo = `ord_${randomUUID()}`;
      await deps.db.createOrder({ outTradeNo, email: body.email, amountCny, createdAt: Date.now(), product });
      let payUrl: string;
      try {
        payUrl = await deps.alipay.createPagePay({ outTradeNo, totalAmount: amountCny, subject: SUB_PRODUCTS[product].subject });
      } catch (e) {
        console.error('[payment] createPagePay (sub) failed:', e);
        return c.json({ error: 'alipay_unavailable' }, 502);
      }
      return c.json({ outTradeNo, payUrl });
    }
```

(其余 license + promo 逻辑保持不变。)

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test tests/payment.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/index.ts src/routes/payment.ts .env.example tests/payment.test.ts
git commit -m "feat(payment): subscription SKUs (sub_month 12 / sub_year 88) in create-order"
```

---

## Task 4: 结算分叉(notify + status 查询路径)

**Files:** `src/routes/payment.ts`、`tests/payment.test.ts`

- [ ] **Step 1: 写失败测试**(payment.test.ts)

```typescript
describe('订阅结算', () => {
  function subApp(db: Database, alipay: AlipayClient) {
    return buildApp({ db, alipay, mail: makeMockMail(), priceCny: '29.90', productName: 'x', subMonthPriceCny: '12', subYearPriceCny: '88' });
  }

  it('notify TRADE_SUCCESS + sub_month 订单 → 发会员、不发 license/邮件', async () => {
    const db = await freshDb();
    await db.createOrder({ outTradeNo: 'os1', email: 'sub@x.com', amountCny: '12.00', createdAt: 0, product: 'sub_month' });
    const alipay = makeMockAlipay();
    (alipay.verifyNotify as any).mockReturnValue(true);
    const mail = makeMockMail();
    const app = buildApp({ db, alipay, mail, priceCny: '29.90', productName: 'x', subMonthPriceCny: '12', subYearPriceCny: '88' });
    const res = await app.request('/api/payment/notify', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ out_trade_no: 'os1', trade_status: 'TRADE_SUCCESS', trade_no: 'a1', sign: 's' }),
    });
    expect(await res.text()).toBe('success');
    expect((await db.getOrder('os1'))!.status).toBe('paid');
    expect((await db.getOrder('os1'))!.licenseKey).toBeNull();
    expect(await db.getWebSubExpiry('sub@x.com')).toBeGreaterThan(Date.now());
    expect(mail.sendLicenseEmail).not.toHaveBeenCalled();
  });

  it('status 查询路径 TRADE_SUCCESS + sub_year → 发会员', async () => {
    const db = await freshDb();
    await db.createOrder({ outTradeNo: 'os2', email: 'y@x.com', amountCny: '88.00', createdAt: 0, product: 'sub_year' });
    const alipay = makeMockAlipay();
    (alipay.queryTrade as any).mockResolvedValue({ tradeStatus: 'TRADE_SUCCESS', alipayTradeNo: 'a2' });
    const app = buildApp({ db, alipay, mail: makeMockMail(), priceCny: '29.90', productName: 'x', subMonthPriceCny: '12', subYearPriceCny: '88' });
    // createdAt=0 → 已过 5s grace,会走 queryTrade
    const res = await app.request('/api/payment/status/os2');
    const body = (await res.json()) as { status: string; product?: string };
    expect(body.status).toBe('paid');
    expect(body.product).toBe('sub_year');
    expect(await db.getWebSubExpiry('y@x.com')).toBeGreaterThan(Date.now());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/payment.test.ts`
Expected: FAIL —— 订阅订单仍被当 license 结算(mint license)。

- [ ] **Step 3: 实现** —— 在 `payment.ts` 加一个私有结算分发(放在 `mountPaymentRoutes` 内、route 定义前):

```typescript
  // 按订单 product 分叉结算。返回是否为订阅(供调用方决定后续邮件/响应)。
  async function settleSubIfApplicable(
    order: { product?: string | null; outTradeNo: string },
    alipayTradeNo: string,
    notifyPayload: Record<string, unknown>,
  ): Promise<boolean> {
    if (!isSubProduct(order.product)) return false;
    const now = Date.now();
    await deps.db.markOrderPaidAndGrantSubscription({
      outTradeNo: order.outTradeNo, alipayTradeNo, paidAt: now,
      notifyPayload, addMs: SUB_PRODUCTS[order.product].ms, product: order.product, now,
    });
    return true;
  }
```

**notify handler**:在 `const order = await deps.db.getOrder(outTradeNo);` + 已 paid 早返之后,`const generatedKey = ...` 之前插入:

```typescript
    if (await settleSubIfApplicable(order, formBody.trade_no ?? '', formBody)) {
      return c.text('success', 200);
    }
```

**status handler**:在 `queryRes.tradeStatus === 'TRADE_SUCCESS' || ...` 分支内,`const generatedKey = ...` 之前插入:

```typescript
      if (await settleSubIfApplicable(order, queryRes.alipayTradeNo ?? `query_${Date.now()}`, { source: 'query', tradeStatus: queryRes.tradeStatus })) {
        return c.json({ status: 'paid', product: order.product });
      }
```

> 注:status handler 现有代码在分支里没有 `order` 变量(它在函数开头 `const order = await deps.db.getOrder(outTradeNo);` 已取 —— 确认其在作用域内;若没有,先取一次)。`/status` 对订阅返回 `{status:'paid', product}`,license 仍返 `{status:'paid', licenseKey}`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test tests/payment.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/routes/payment.ts tests/payment.test.ts
git commit -m "feat(payment): settle subscription orders by granting web membership (notify + status)"
```

---

## Task 5: 全量回归 + schema 部署说明

- [ ] **Step 1:** `pnpm test` 全绿。
- [ ] **Step 2:** `pnpm typecheck` 无错误。
- [ ] **Step 3:** 在 `whatsub-license/CLAUDE.md` 记一句:`orders.product` + `web_subscriptions` 为本次新增,部署需 `scp schema.sql` + `docker exec psql < schema.sql`(幂等)。
- [ ] **Step 4:** 提交 `git commit -m "docs: note orders.product + web_subscriptions schema additions"`。

---

## 客户端侧(不在本后端 plan,后续)

- **插件/网站**:加"开通会员(月¥12/年¥88)"入口 → `POST /api/payment/create-order {email, product:'sub_month'|'sub_year'}` → 跳 `payUrl` → 成功页轮询 `/status`(订阅返 `{status:'paid', product}` → 显示"会员已开通")。
- **iOS**:站内购买走 Apple IAP(已存在);不得出现站外支付宝入口(苹果合规)。
- **升级提示文案**(撞 `quota_exceeded` 时):区分"语料库 1000 / Library 50 = 会员(订阅)专属",非订阅(license/买断)不解锁。

---

## 自检对照

| 需求 | 落点 |
|---|---|
| 支付宝可买"订阅"会员 | Task 3(create-order SKU) |
| 月¥12 / 年¥88,对齐 iOS | Task 2(env 价) |
| 时段制(买 N 月,续期累加) | Task 1(`markOrderPaidAndGrantSubscription` + 已有 `setWebSubscription` 累加) |
| 订阅 → 高档配额 | Part A 已接(`hasActiveSubscription` 读 `web_subscriptions`) |
| 订阅不发 license | Task 1/4(分叉,licenseKey null) |
| 幂等(防重复续期) | Task 1(原子 claim) |
