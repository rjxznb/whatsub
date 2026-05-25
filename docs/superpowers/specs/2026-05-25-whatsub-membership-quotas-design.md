# whatsub 会员配额体系 · 设计 Spec

> 2026-05-25。一个**邮箱级会员**,统一管两个跨端配额(个人语料库 + 云端 Library),
> 外加把"划词保存"接进现有失败重试队列。后端 `whatsub-license` 是唯一真源。

---

## 0. 定位与硬规则

1. **一份会员,通吃三端**:同一个邮箱的权益,同时解锁 插件(语料库)+ 桌面(Library 云同步)+ iOS。后端按 email 判定,不分端。
2. **配额校验只认服务端**:个人语料库 / Library 都在云上,客户端的计数/拦截只是 UX,**权威拦截必须在后端**(可被绕过的前端检查不算数)。
3. **苹果合规红线**:iOS App 内发起的购买**只能走 Apple IAP**,**不得**出现站外(支付宝)购买入口或链接。但**别处买的会员可以在 iOS 被认可**(多平台内容,3.1.3(b) 合规)。→ 同一套权益、**两条购买通道**。
4. **`limit_reached` 是静默 drop 的例外**:语料库错误默认静默(插件 spec §13),但"配额满"必须**显式提示 + 升级入口**——否则用户一直存、啥也没存还以为成功(撞上当前"乐观显示✓已收藏"的毛病)。
5. **`limit_reached` 不进重试队列**:它是确定性错误(跟 blocklist 一样),队列只重试 `network` / `rate_limited`。

---

## 1. 范围

**In scope**
- 把 `save-vocab` 接进 `enqueueOrSend` 失败重试队列(可靠保存)。
- 两个**服务端强制**配额:语料库 免费 50 / 会员 1000;Library 免费 3 / 会员 50。
- 统一权益判定 `hasCorpusAccess`,并补上漏掉的 iOS 订阅来源。
- 撞限时各端弹**整套会员权益**升级提示(按端选购买通道)。
- 4 个数字做成服务端可配。

**Out of scope**
- iOS App 代码(独立仓):本 spec 只定**后端契约 + 苹果通道约束**,iOS UI 由那边按此实现。
- 新增支付方式(沿用现有 支付宝 web + Apple IAP)。
- "我的语料库"页分页/虚拟滚动(deferred;会员档 1000、Library 列表才几十条,暂不需要;真逼近时再做)。

---

## 2. 决策摘要

| # | 决策 | 备注 |
|---|------|------|
| D1 | 会员 = 邮箱级,`hasCorpusAccess` 聚合:web/支付宝 license **OR** iOS 买断 **OR** iOS 订阅(**新增**) **OR** 有效试用 | 现状漏了订阅,见 §3.2 |
| D2 | 语料库配额:免费 **50** / 会员 **1000** | Postgres 文本,成本≈0(1000 条 ~1.5MB) |
| D3 | Library 配额:免费 **3** / 会员 **50** | 视频→阿里云 OSS,**真实成本**(50 个 720p ≈ 2.5–5GB/人) |
| D4 | 4 个数字服务端可配(env / admin SPA) | 上线后好调 |
| D5 | 拦截点:`POST /api/corpus/contribute`、`POST /api/library/sync` | 都先 `count` 再决定 |
| D6 | 撞限 reason = `limit_reached`,带 `quota`(corpus/library)+ `cap` + `tier` | 客户端据此渲染对应文案 |
| D7 | 购买通道:插件/桌面 → 支付宝 web;iOS → Apple IAP | 苹果合规,见 §0.3 |
| D8 | 试用期 = **免费档**(50 / 3),**不享会员配额** | 防薅:24h 试用不能塞 50 个视频进 OSS。试用仍可浏览公共语料库,但配额走免费档 |
| D9 | 降级(会员到期且已超免费档):**不删数据**,仅禁新增,直到删到免费档以下或续费 | 见 §6.3 |

---

## 3. 权益模型(entitlement)

### 3.1 唯一真源:`hasCorpusAccess(email)`

后端 `whatsub-license/src/lib/auth.ts`。所有端登录后都解析为一个 **email + session**:
- 插件:邮箱 OTP → sessionToken。
- 桌面:license key → `POST /api/auth/from-license` → session(`LicenseSessionGate` 自动登录)。
- iOS:邮箱会话 + `POST /iap/verify` 把 IAP 落到该 email(`grantBuyout(email)` / `setSubscription(email)`)。

**两个判定,别混用**:

- **`hasCorpusAccess(email)`**(**含试用**)= `hasLicense OR iosBuyout OR iosSubActive OR 有效试用`
  → **公共语料库浏览门槛**(现状,不动)。
- **`isMember(email)`**(**不含试用**,新增)= `hasLicense OR iosBuyout OR iosSubActive`
  → **配额档位判定**:`isMember ? 会员档 : 免费档`。

```
hasLicense(email)            // web/支付宝 license    ┐
  OR ent.iosBuyout(email)    // iOS 买断              ├─ isMember(分档)
  OR ent.iosSubActive(email) // iOS 订阅 ← §3.2 必修   ┘
  OR ent.trialExpiresAt > now// 有效试用 ── 只进 hasCorpusAccess(浏览),不进 isMember
```

→ **试用用户**:能浏览公共语料库,但语料库 / Library 走**免费档**(50 / 3)——防 24h 薅 OSS。

**"插件端付费 → iOS 显示"** 成立条件:iOS 用**同一邮箱**登录。机制上 iOS 已有邮箱会话,只要邮箱一致,后端权益为 true,iOS 拉 `/auth/me`(或权益端点)即点亮。

### 3.2 ⚠️ 必修:`hasCorpusAccess` 漏了 iOS 订阅

现状(`auth.ts:91-94`)只查 `iosBuyout` + trial,**没查 `iosSubActive`**。一个 iOS **订阅**用户(非买断)目前 `hasCorpusAccess = false` → 解锁不了语料库/Library/公共库。

**改**:`iosSubActive` 要**同时**喂给 `hasCorpusAccess`(浏览门槛)和新增的 `isMember`(分档)。`getIosEntitlements` 已返回它,只是没被消费。

---

## 4. 两个配额

### 4.1 个人语料库(文本)

- **存**:Postgres `corpus_contributions`,`contributor_id = sha256(email)`。
- **档**:免费 **50** / 会员 **1000**。
- **拦截**:`POST /api/corpus/contribute` 入口处,`cap = isMember ? 1000 : 50`,`SELECT count(*) WHERE contributor_id = sha256(email)`;`>= cap` → `403 { reason: "limit_reached", quota: "corpus", cap, tier }`。
- **成本**:可忽略(1000 条 ~1.5MB;1000 会员全顶满 ~1.5GB)。

### 4.2 云端 Library(视频)

- **存**:阿里云 **OSS** 视频对象 + Postgres 行,iOS App 读取。同步走桌面 `library_sync_to_cloud` → `POST /api/library/sync`(authed,同一 session)。
- **档**:免费 **3** / 会员 **50**。
- **拦截**:`POST /api/library/sync` 入口处,`cap = isMember ? 50 : 3`,`count` 该用户已同步条数;`>= cap` 且是**新增**(非覆盖同 id)→ `403 { reason: "limit_reached", quota: "library", cap, tier }`。
- **成本**:**真实**(OSS 存储 + iOS 流量)。这是经济上最该卡的配额。免费 3 = 让人尝到"手机上能看",想正经用就升级。

### 4.3 配置

4 个数字(`CORPUS_FREE` / `CORPUS_MEMBER` / `LIBRARY_FREE` / `LIBRARY_MEMBER`)走 env,默认 `50 / 1000 / 3 / 50`;若 admin SPA 已有热配机制可挂上去。

---

## 5. 可靠保存(失败重试队列)

### 5.1 现状(缺陷)

`save-vocab` handler(`whatsub-plugin/src/sw/index.ts`)**直接调 `corpusContribute` 后即返回**,绕过了 `sw/corpus/queue.ts` 的 `enqueueOrSend`。后果:保存失败(断网/5xx)**静默丢失、永不重试**;`sync-drain` 闹钟每分钟空转。气泡还乐观显示"✓ 已收藏"。

基础设施(`enqueueOrSend` / `drainCorpus` / `tryDrain` / `sync-drain` 1min 闹钟 / 最多 5 次重试)**都已写好、有测试,只是没接上**。

### 5.2 改法

`save-vocab` 改为走 `enqueueOrSend(corpusReq, enqueueFn)`:
- 成功 → `uploaded:true`。
- `network` / `rate_limited` → 进本地持久化队列,`sync-drain` 每分钟重试,最多 5 次。
- 其它确定性错误(含 **`limit_reached`**) → **不进队列**(重试无用)。

### 5.3 与 `limit_reached` 的交叉(关键)

`limit_reached` 既**不重试**,又**不能静默**。所以:
- 队列侧:`enqueueOrSend` 已天然不 enqueue 非 `network/rate_limited` 的 reason ✅,无需特判。
- UI 侧:气泡当前**不读 `save-vocab-result`**(乐观显示)。需特判:**收到 `save-vocab-result` 且 `reason === "limit_reached"` 时,不显示"✓ 已收藏",改弹升级提示**(§6)。其它失败仍保持乐观/静默(已进队列会自动补传)。

---

## 6. 各端 UI / 升级提示

### 6.1 整套权益文案(撞任一上限都列全,而非只说撞上的那条)

> **升级 whatsub 会员**
> • 个人语料库 **1000 条**(免费版 50)
> • 云端视频库 **50 个**,手机 App 随时看、跨设备同步(免费版 3)
> • 解锁**公共语料库**浏览
> • 桌面完整版(去试用限制)

### 6.2 购买通道(按端,苹果合规)

| 端 | 撞限提示 | 购买入口 |
|---|---------|---------|
| 插件 | 上述文案 | 跳支付宝 web 下单(license 落邮箱) |
| 桌面 | 上述文案 | 跳支付宝 web |
| iOS | 上述文案 | **仅 Apple IAP**,**无任何站外链接** |

别处买的会员,iOS 用同一邮箱登录即被认可(只"显示/点亮",不算站外引导)。

### 6.3 降级处理

会员到期 / 退款后,若已存超免费档(如语料库 300 条):**保留数据**,只在新增时返回 `limit_reached`,提示"已超免费上限,删至 50 以下或续费可继续新增"。Library 同理。

### 6.4 撞限触点
- 插件:`SelectionBubble.save()` 收到 `limit_reached` → 二级界面换成升级卡。
- 桌面:`SyncButton` / `library_sync_to_cloud` 收到 `limit_reached` → 升级提示。
- iOS:同步发起处拦 + IAP 升级页。

---

## 7. 服务端改动(`whatsub-license`)

1. `lib/auth.ts`:`hasCorpusAccess` 补 `iosSubActive`;**新增 `isMember`**(= license OR 买断 OR 订阅,**不含试用**)用于分档(§3.1)。
2. `lib/db.ts`:加 `countCorpusContributions(contributorId)`、`countSyncedLibrary(email)`。
3. `routes/corpus.ts` contribute:`cap = isMember ? 1000 : 50` → count → 超则 `403 limit_reached{quota:"corpus",cap,tier}`。curator(`whatsub-curator`)路径**豁免**(种子脚本不受限)。
4. `routes/library.ts`(sync 端点):同模式,`quota:"library"`。仅对**新增**计数(覆盖同 id 不算)。
5. config:4 个数字走 env(默认 `50/1000/3/50`)。
6. 测试:见 §10。

---

## 8. 客户端改动

### 8.1 插件(`whatsub-plugin`)
- `save-vocab` → `enqueueOrSend`(§5.2)。
- `SelectionBubble`:读 `save-vocab-result`,`limit_reached` → 升级卡(§6.1),带支付宝入口。
- `shared-types` `ClientReason` 加 `limit_reached`;`save-vocab-result` 透传 `quota/cap/tier`。

### 8.2 桌面(`Get_Video/client`)
- `library_sync_to_cloud` / `SyncButton`:处理 `limit_reached` → 升级提示(支付宝)。

### 8.3 iOS(独立仓,契约)
- 同步/保存撞 `limit_reached` → IAP 升级页(**无站外链接**)。
- 登录用与付费一致的邮箱,`hasCorpusAccess` 自动跨端点亮。

---

## 9. 错误处理与边界

- `limit_reached`:非静默(§0.4)、非重试(§0.5)。
- 其它 corpus 失败:静默 drop / 进队列重试(不变)。
- 降级超额:保留数据,禁新增(§6.3)。
- 重复购买(支付宝 + IAP 同邮箱):都只是把 `hasCorpusAccess` 置真,无害;产品上提示"已是会员"即可,不做强对账。
- curator 种子路径豁免配额。

---

## 10. 测试策略

- **后端**(pg-mem):语料库边界 49→50→51、Library 3→4;tier 切换(免费/会员 cap 不同);**`isMember` vs `hasCorpusAccess` 对试用的区别(试用 `isMember=false` 配额走免费档,但 `hasCorpusAccess=true` 仍可 browse)**;`iosSubActive` 两个判定都认;curator 豁免;config 覆盖默认。
- **插件**:`save-vocab` 走队列(成功/transient 入队/`limit_reached` 不入队);`SelectionBubble` 收到 `limit_reached` 显示升级卡而非"✓ 已收藏"。
- **桌面**:`library_sync` 撞 `limit_reached` 的 UI。

---

## 11. 落地顺序

1. **后端先行**(`whatsub-license`):`hasCorpusAccess` 补订阅 + 两个 count 拦截 + `limit_reached` + config + 测试 → 部署。这是真源,先稳。
2. **插件**:可靠队列 + `limit_reached` 升级卡。
3. **桌面**:Library 撞限提示。
4. **iOS**(那边):按 §8.3 契约 + 苹果 IAP 通道。
5. **文案**:官网/定价页加"个人语料库 1000 / 云端库 50"会员权益。
