# whatsub 浏览器插件 · 设计 Spec

> 2026-05-17 · 与桌面端 [whatsub](../../../client/) 同源，作为免费引流工具发布到 Chrome Web Store / Edge Add-ons。

## 0. 定位与硬规则

**定位**：免费、不要授权码、不要账号。桌面端是付费产品，插件是它的引流入口；用户装了插件 → 用得开心 → 升级到桌面端享受本地转录 / 大库管理 / 跨平台。

**贯穿全设计的硬规则**：

1. **插件能独立运行。** 没装桌面端时，双语字幕、AI 标黄、词汇本、划词收藏都正常工作；只是收藏不同步而已。**永远不能因为桌面端缺席弹错。**
2. **BYOK（Bring Your Own Key）。** 所有 LLM 调用都用用户自己填的 API Key。我们零 token 成本。
3. **零账号、零登录。** 用户身份用 chrome.storage 里的匿名 `contributorId`（UUID）表达，全过程不需要邮箱 / 手机 / 密码。
4. **服务端只承接共享语料库一项**——见第 7 节。除此之外，插件不主动联我们任何服务器。LLM 调用、字幕拉取、桌面端同步都点对点，与我们的服务器无关。

## 1. 范围

**一期支持**：
- 浏览器：Chrome + Edge（同一份 Chromium MV3 codebase）
- 视频站点：YouTube only（`*.youtube.com/watch`）— 双语字幕、AI 标黄、视频内划词收藏
- 任意站点：通用页面划词收藏（任何 `http(s)://` 页面）
- 桌面端集成：通过 localhost 桥单向同步（插件 → 桌面）
- **共享语料库**：YouTube 划词默认匿名上传到 `whatsub.eversay.cc`；收藏短语时展示其他用户的语境；冷启动用桌面端 pipeline 已分析数据做「whatsub 精选」种子

**显式 out-of-scope（v1 不做）**：
- Netflix / Bilibili / 课程平台
- 沉浸式翻译（任意网页全量双语翻译）
- 桌面端 → 插件方向同步（用户主动「从桌面端拉一次」按钮以外不自动拉）
- 用户账号 / 邮箱 / 跨设备合并我的贡献
- 共享语料库的人工审核后台（v1 只做自动 blocklist + 举报队列）
- Firefox

## 2. 决策摘要

| 维度 | 决策 |
|---|---|
| 定位 | 免费引流工具 |
| LLM | BYOK（用户填 API Key） |
| AI 标黄触发 | 用户主动按按钮，缓存后不重复 |
| 双语字幕触发 | 跟随 YouTube CC 按钮 |
| 字幕显示 | 视频底部叠加 + 右侧侧栏字幕表（Option C） |
| 任意网页划词 | 轻气泡：「+ 收藏」/「✨ AI 查词」两按钮 |
| 同步机制 | localhost HTTP 桥 + 4 个分散候选端口 |
| 同步方向 | 单向：插件 → 桌面（v1） |
| 桌面端缺席 | 静默降级到「仅本机」模式，不弹错 |
| 共享语料库 | 匿名上传、YouTube 默认开 / 网页默认关、举报+blocklist 兜底 |
| 语料库冷启动 | scripts/video_sourcing 已分析数据种子，contributorId = `whatsub-curator` |
| 语料库后端 | 复用 `whatsub.eversay.cc`（同 license 后端），新 `/api/corpus/*` 路由 |
| UI 栈 | React + TS + Tailwind + zustand（与桌面端同源） |
| 构建 | Vite + `@crxjs/vite-plugin` |

## 3. 架构

### 3.1 三个执行环境（浏览器侧）

```
┌──────────────────────────────────────────────────────────┐
│                  Chrome / Edge MV3                       │
│                                                          │
│  ┌────────────────────┐   ┌────────────────────────┐    │
│  │ Content Script:    │   │ Content Script:        │    │
│  │ YouTube (/watch)   │   │ All http(s)://         │    │
│  │ - CC track 监听    │   │ - 划词气泡              │    │
│  │ - 注入 SidePanel   │   │ - 任意页面 source       │    │
│  └─────────┬──────────┘   └─────────┬──────────────┘    │
│            │                        │                    │
│            └────────┬───────────────┘                    │
│                     ↓ chrome.runtime.connect (Port)      │
│       ┌─────────────────────────────────┐                │
│       │ Service Worker (background)     │                │
│       │ - LLM streaming fetch owner     │                │
│       │ - chrome.storage 读写            │                │
│       │ - 同步队列 + 重试                │                │
│       │ - localhost 桥探活 + POST        │                │
│       └─────────────────────────────────┘                │
│                                                          │
│  ┌──────────────────┐  ┌──────────────────┐              │
│  │ chrome.storage   │  │ IndexedDB         │              │
│  │ - settings       │  │ - transcript 缓存 │              │
│  │ - vocab          │  │ - 翻译缓存        │              │
│  │ - syncQueue      │  │ - AI 标黄结果     │              │
│  └──────────────────┘  └──────────────────┘              │
└─────────────────────────┬────────────────────────────────┘
                          ↓ POST 127.0.0.1:<port>
┌──────────────────────────────────────────────────────────┐
│              whatsub.exe (桌面端 · 可选)                 │
│  ┌─────────────────────────────────────────────────┐     │
│  │ Local HTTP Server (Tauri 启停)                  │     │
│  │ - GET  /ping        探活 + banner               │     │
│  │ - POST /vocab       单条收藏                    │     │
│  │ - POST /vocab/batch 队列回放                    │     │
│  │ - POST /corpus      语料句                      │     │
│  │ - GET  /settings/llm 拉桌面端 LLM 配置          │     │
│  │ - GET  /vocab       用户主动「拉一次」          │     │
│  └─────────────────────────────────────────────────┘     │
│                          ↓                               │
│  vocabulary.json · corpus.json (新增)                    │
└──────────────────────────────────────────────────────────┘
```

### 3.2 关键架构选择

- **侧栏挂 Shadow DOM**：YouTube 的全局 CSS 不污染插件，反之亦然。Tailwind 通过 `@tailwindcss/postcss` 注入 Shadow root。
- **LLM 流式 fetch 由 SW 持有**：用户切标签页 / 视频时不会断流。SW 用 `chrome.alarms` 续命（MV3 30s 不活跃会被杀，alarm 周期 < 30s 可阻止）。
- **三种环境通信**：CS ↔ SW 用长连 `chrome.runtime.connect(name: "whatsub")` 端口（不用 sendMessage，因为流式响应需要持续推送）。
- **侧栏挂载点**：YouTube `#secondary-inner` 节点（推荐列表的上方）。检测不到（YT 改版）就降级浮在右边边缘。

### 3.3 桌面端侧改动

新增 Rust 模块 `client/src-tauri/src/bridge/`：
- `bridge/server.rs`：actix-web 4.x（已是 Tauri 生态常用方案）启 HTTP 服务
- `bridge/routes.rs`：路由 + 调用现有 vocab / library 模块
- `bridge/port.rs`：4 候选端口逐一 `bind()`，第一个成功的就用；全部失败则不启服务（不阻塞 Tauri 启动）
- Tauri lifecycle：`setup()` 中 spawn bridge task，`on_window_event(Destroyed)` 时优雅 shutdown

## 4. 数据模型

### 4.1 `VocabEntry`（共享 schema · 在桌面端 `client/src/types/vocab.ts` 上扩展）

```ts
interface VocabEntry {
  id: string;                  // expression.toLowerCase().trim() — 去重键
  expression: string;
  meaningZh: string;
  usage: string;
  videoId: string;
  videoTitle: string;
  addedAt: string;             // ISO timestamp
  cueTime?: number;
  cueText?: string;
  note?: string;
  noteUpdatedAt?: number;

  // ── 插件侧新增 4 个字段，桌面端持久化但 v1 不展示 ──
  source?: "desktop" | "youtube" | "web";
  pageUrl?: string;            // 任意网页收藏时填，YouTube 用 videoUrl
  videoUrl?: string;           // 完整 https://youtube.com/watch?v=X&t=46
  syncStatus?: "synced" | "pending";  // 仅插件侧使用，桌面端忽略
}
```

**桌面端兼容性**：

- 4 个新字段全可选（`source?` / `pageUrl?` / `videoUrl?` / `syncStatus?`），桌面端读老数据照常工作
- **桌面端写回时必须保留收到的未知字段**——即收到插件写入的条目后再编辑保存，不能把 `source` / `pageUrl` / `videoUrl` 丢掉。`vocab` store 的 upsert 改为 `{ ...existing, ...incoming }` 浅合并
- 插件读到桌面端老条目 `source` 缺失 → 默认填 `"desktop"`

### 4.2 `CorpusEntry`（新建 schema · 双端都有）

```ts
interface CorpusEntry {
  id: string;                  // sha256(videoId + cueTime) 前 12 位
  cueText: string;
  cueTr: string;               // 中文翻译
  videoId: string;
  videoUrl: string;            // 深链 https://youtube.com/watch?v=X&t=46
  videoTitle: string;
  cueTime: number;
  capturedAt: string;
  highlightWords?: string[];   // 当时的 AI 标黄结果
  highlightTranslations?: string[];
  keyNote?: string;            // 当时的 AI 重点说明
}
```

桌面端持久化为 `corpus.json`（与 `vocabulary.json` 并列）。一期桌面端只是入库 + 在 Library 视频卡片上显示「已收藏 N 条语料」徽章，不做语料库专页（v2 再说）。

### 4.3 `TranscriptCache`（IndexedDB · 仅插件）

```ts
interface TranscriptCache {
  videoId: string;             // 主键
  videoTitle: string;
  channelId: string;
  durationSec: number;
  langPair: "en->zh-CN";
  cues: Array<{
    idx: number;
    time: number;
    end: number;
    text: string;
    tr: string;                // 翻译；未翻译时为 ""
  }>;
  analysis?: Array<{
    idx: number;
    highlightWords: string[];
    highlightTranslations: string[];
    keyNotes: string;
  }>;
  fetchedAt: number;
  translatedAt?: number;
  analyzedAt?: number;
}
```

IndexedDB store：`transcripts`，主键 `videoId`。无 TTL 永久缓存；用户在设置可一键清空。

### 4.4 `SyncQueueItem`（`chrome.storage.local["syncQueue"]` · 数组）

```ts
interface SyncQueueItem {
  kind: "vocab" | "corpus";
  payload: VocabEntry | CorpusEntry;
  queuedAt: number;
  retries: number;
}
```

队列最大 1000 条，超出按 queuedAt 老的丢弃（极端情况，正常用户不会到）。

### 4.5 服务端：`corpus_phrases` + `corpus_contributions`（`whatsub.eversay.cc` PostgreSQL · 两张表）

**`corpus_phrases`** — 短语维度，**带分类标签**。每条短语只一行，被多个用户贡献时这一行不动，只增 contributions：

```ts
interface CorpusPhrase {
  phraseNormalized: string;         // 主键 — normalizeExpression() 后的值
  phraseRaw: string;                // 第一次见到的原文（参考）
  // ── 分类标签（首次贡献入库后异步 LLM 分类一次，永久缓存）──
  tags: {
    scene?:                         // 18 场景之一，复用桌面端 pipeline 分类
      | "immigration" | "housing" | "medical" | "campus" | "banking"
      | "shopping"    | "transport"| "social"  | "dining" | "emergency"
      | "job"         | "phone"    | "salon"   | "driving"| "travel"
      | "fitness"     | "mental_health" | "maintenance";
    partOfSpeech?:                  // 词性 / 表达类型
      | "noun_phrase" | "verb_phrase" | "phrasal_verb"
      | "idiom"       | "slang"      | "collocation";
    cefrLevel?: "A2" | "B1" | "B2" | "C1" | "C2";  // CEFR 难度
    classifiedAt?: number;          // 分类完成时间；null = 待分类
  };
  contributionCount: number;        // 累计贡献数（含 curator）
  firstSeenAt: number;
  lastSeenAt: number;
}
```

**`corpus_contributions`** — 贡献维度，每次保存一行：

```ts
interface CorpusContribution {
  id: string;                       // server UUID
  phraseNormalized: string;         // FK → corpus_phrases
  contextSentence: string;          // 上下文整句
  source: {
    kind: "youtube" | "web" | "curator";
    url: string;                    // canonicalize 过：去掉 ?utm_* / #fragment / 常见 token 参数
    title: string;
    timestampSec?: number;
  };
  contributorId: string;            // 匿名 UUID，"whatsub-curator" 为种子
  contributedAt: number;
  flagged: boolean;
  flagCount: number;
  hidden: boolean;                  // 举报手工 review 后置 true，前端不展示
}
```

**索引**：
- `corpus_phrases (tags->>'scene', cefrLevel)` — 浏览页按场景 / 难度过滤
- `corpus_contributions (phraseNormalized, hidden, contributedAt DESC)` — 短语查询主走这个
- `corpus_contributions (contributorId)` — 「删除我所有贡献」用

### 4.6 `Settings`（`chrome.storage.local["settings"]`）

```ts
interface PluginSettings {
  llmProvider: "openai-compatible" | "claude" | "gemini";
  openaiCompatible: { apiKey: string; baseUrl: string; model: string };
  claude: { apiKey: string; model: string };
  gemini: { apiKey: string; model: string };
  // ── 插件特有 ──
  autoTranslateOnCC: boolean;          // 默认 true
  showSidePanelByDefault: boolean;     // 默认 true，用户可折叠
  highlightStyleAmber: boolean;        // 默认 true，关掉就是普通双语
  importedFromDesktop?: boolean;       // 是否一键继承过桌面端 LLM 配置
}
```

**最大化复用**：`client/src/types/settings.ts` 的 LLM 相关字段直接重用类型；`client/src/llm/providers.ts` 的协议层（OpenAI-compat / Claude / Gemini 三协议）整体复制为 npm-workspace 共享包 `@whatsub/llm-core`，桌面端 + 插件都依赖它。

## 5. 三条核心数据流

### 5.1 双语字幕

```
[CS-YT] 监听 video.textTracks change
   ↓
   textTracks[i].mode === "showing"?
   ├─ 否 → 隐藏侧栏 + 叠加层，return
   └─ 是 → 提取 YT 当前 CC 轨的 baseUrl (从 ytInitialPlayerResponse 拉)
        ↓
[SW] postMessage("transcribe", { videoId, baseUrl, lang })
   ↓
[SW] IndexedDB transcripts.get(videoId)
   ├─ 命中 + translatedAt → return cached
   └─ miss → fetch(baseUrl + "&fmt=json3") → 解析 events[] 为 cues
        ↓
        IndexedDB.put({ ..., cues: [{ text, tr: "" }] }) — 先存英文
        ↓
        提交 LLM 批翻（复用桌面端 batchTranslate.ts）：
        - 每 30 cue 一批，JSON Lines 流式响应
        - 每收一行就 port.postMessage("cue-translated", { idx, tr })
        - IndexedDB 增量更新
   ↓
[CS-YT/UI] 收到流式 cue-translated:
   - 叠加层：cue.time <= currentTime <= cue.end 时显示英文 + 中文
   - 侧栏字幕表：逐条渲染，currentTime 高亮当前条 + 自动滚动
```

**关键点**：
- CC 轨的 baseUrl 在 `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[]`。CS 通过 `document.documentElement.innerHTML` 抓 + 正则提取，YT 自家变量不暴露给 isolated world。
- 翻译流可中断：用户切下一个视频 → 当前 port.disconnect → SW abort 当前流。已存的部分 cue 翻译保留。
- 视频底部叠加层位置：紧贴 `.ytp-caption-window-container` 上方，YT 原生英文字幕仍然显示（用户已经在看了，不打扰）；中文字幕单独一行在英文之上。

### 5.2 AI 标黄

```
[UI] 用户点 ✨ AI 标黄 按钮（侧栏顶部）
   ↓
[SW] 读 IndexedDB transcript：
   ├─ analyzedAt 已有 → 直接 emit 缓存的 analysis 数组 → return
   └─ 无 → 把整 transcript 提交 LLM
        ↓
        复用桌面端 analyze.ts 的两阶段协议：
        Phase 1 — 按批 30 cue 提交，每行回一个 { idx, highlightWords, highlightTranslations, keyNotes }
        Phase 2 — 全文总结一次（v1 暂不展示总结，只取 highlight）
        ↓
        IndexedDB 更新 analysis 数组 + analyzedAt
   ↓
[CS-YT/UI] 收到流式 analysis-cue:
   - 侧栏字幕表：highlightWords 加 <mark class="hl"> 包裹
   - 叠加层：当前 cue 的 highlightWords 也染色
```

**复用桌面端 LLM 协议 1:1**。`analyze.ts` 已经写得很成熟（处理 streaming、解析失败重试、phase 切换）。打包成 `@whatsub/llm-core` 后插件直接 import。

### 5.3 划词收藏

```
[CS-*] mouseup 监听（除了输入框 / contenteditable）
   ↓
   selection 非空 + 长度 1-200 字符 + 不在已有气泡内
   ↓
[CS-*] 弹气泡（Shadow DOM 内）：
   - 上方：高亮选中的 expression
   - 两按钮：[+ 收藏]  [✨ AI 查词]
   - YouTube 字幕里额外：[在桌面端打开] 深链
   ↓
   ├─ 用户点 [+ 收藏]：
   │   立即写 chrome.storage.local["vocab"] + 入队 syncQueue
   │   气泡变 ✓ 已收藏，1s 后淡出
   │
   └─ 用户点 [✨ AI 查词]：
       [SW] 复用桌面端 lookupExpression.ts：
            - 输入：expression + 上下文句（cueText 或 selection 周围 ±50 字符）
            - 输出：{ meaningZh, usage } 流式回
       气泡里实时显示，可手动编辑
       ↓
       [+ 收藏] 落地（写本机 + 入队）
```

**source 字段填法**：
- YouTube 字幕里划词 → `source: "youtube"`，带 `videoUrl + cueTime`
- 任意网页划词 → `source: "web"`，带 `pageUrl + pageTitle`

### 5.4 共享语料库 · 上传 + 查询

**上传时机**（保存动作的附带操作）：

```
[CS-*] 用户点 [+ 收藏]
   ↓
[SW] 同时启动两条并行：
   ├── A: 桌面端 localhost 同步（5.3 已述）
   │
   └── B: 共享语料库上传
        ↓
        判断是否上传：
        - source: "youtube"  → 默认上传（用户设置可关）
        - source: "web"      → 默认不上传（用户点「也分享到公共语料库」才传）
        ↓
        canonicalize URL（去 utm/token/fragment）+ 截 contextSentence 上下文 ±50 字
        ↓
        POST whatsub.eversay.cc/api/corpus/contribute
        body: { phraseRaw, contextSentence, source, contributorId }
        ↓
        服务端：
        1. 写 corpus_contributions
        2. UPSERT corpus_phrases — count++、lastSeenAt 更新
        3. 若 phrase.classifiedAt 为 null → 入异步分类队列（cheap LLM call，~80ms）
        ↓
        服务端不阻塞返回 201 { id }
```

**查询时机**（划词气泡打开时 + 词汇本卡片展开时）：

```
[CS-*] 划词气泡打开，气泡里出现「✨ 看看 N 个人怎么收藏的」入口
   ↓
[SW] GET whatsub.eversay.cc/api/corpus/lookup?phrase=<normalized>
   → 200 {
       phrase: { tags: { scene, partOfSpeech, cefrLevel }, contributionCount },
       contributions: [
         { contextSentence, source, contributedAt, isCurator },  // 最多 10 条
         ...
       ]
     }
   ↓
[UI] 气泡展开第二屏：
   - 顶部 chip：[scene: 求职职场] [phrasal_verb] [B2]
   - 列表：每条贡献一行
     · YouTube 类：缩略图 + 标题 + cueTime → 点击新标签页打开 https://youtu.be/<id>?t=<sec>
     · web 类：favicon + 标题 + 上下文片段 → 点击新标签页打开 URL
     · curator 类：「⭐ whatsub 精选」徽章
   - 末尾「🚩 举报这一条」入口
```

**离线 / 失败兜底**：上传失败入 syncQueue（与桌面端同步队列复用），查询失败 → 气泡直接隐藏「✨ 看看 N 个人怎么收藏的」入口，**绝不弹错**。

## 6. 同步协议（插件 → 桌面端）

### 6.1 端口发现

4 个候选端口，硬编码在双端 binary 里。**不顺延、不写文件、不做服务发现协议**。

```ts
// 双端共享常量（packages/shared-types/src/bridge.ts）
export const BRIDGE_PORTS = [51737, 53401, 59283, 62015];
```

4 个值**全部落在 IANA Dynamic/Private 范围**（49152-65535，IANA 不分配 + 不登记），分散排布、间距 > 1500，避开常见服务端口（Clash 7890、frp 7000、Vite 5173、proxy 8080、Tomcat 8443 等）。这 4 个数字本身**就是契约**——不从算法派生，不会重新计算；任何修改需要同步升级双端 binary。

**桌面端启动**：按顺序 `bind()`，第一个成功的就用；4 个都被占用则不起 bridge（不阻塞 Tauri）。

**插件探活**：SW `Promise.race` 并发探 4 个，看哪个 `GET /ping` 在 500ms 内回 banner `{ "service": "whatsub-bridge", "version": "..." }`。命中后缓存到 `chrome.storage.session`，60s 内不重探；失败也缓存「未连接」60s（避免每次 fetch 都 4 路同时探）。

### 6.2 路由

```
GET  /ping
  → 200 { service: "whatsub-bridge", version: "0.1.x", desktopVersion: "0.1.42" }

POST /vocab
  body: VocabEntry
  → 201 { ok: true, id }
  → 409 { ok: false, reason: "duplicate", existing: VocabEntry }  // 同 id 已有 + addedAt 更新
  → 4xx { ok: false, reason: string }

POST /vocab/batch
  body: { items: VocabEntry[] }
  → 200 { results: Array<{ ok: boolean, id, reason? }> }

POST /corpus
  body: CorpusEntry
  → 201 / 409 同上

GET /vocab
  → 200 { entries: VocabEntry[] }  // 用户主动「拉一次」用

GET  /settings/llm
  → 200 { provider, model, baseUrl }   // 元信息，不含 apiKey

POST /settings/llm/handoff
  body: { extensionId: string }
  → 桌面端弹原生确认框「插件请求继承翻译配置 · 同意 / 拒绝」
  → 同意 → 200 { provider, model, baseUrl, apiKey }（一次性，桌面端记录已 handoff）
  → 拒绝 / 超时 30s → 403 { ok: false, reason: "user_declined" }
```

**关键安全约定**：
- 仅 bind `127.0.0.1`，绝不监听 `0.0.0.0`
- 所有响应带 `Access-Control-Allow-Origin: chrome-extension://<known-id>` —— 上架 Chrome Web Store 后扩展 ID 固定下来，写入桌面端常量
- v1 不做 token 配对（Origin 校验 + 仅 loopback 足够防绝大多数攻击面）；v2 加 6 位 pairing code

### 6.3 队列回放

```
[SW] 每 60s（已连接态 5s）后台 alarms 触发 ping
   ↓
   ping 200 + 队列非空？
   ↓ 是
   syncQueue 切 100 条一批 POST /vocab/batch
   ↓
   收 200 → 删队列对应条目，写 syncStatus: "synced"
   收 4xx/5xx → 该条 retries++，超过 5 次进 deadLetter（用户设置页可看）
```

### 6.4 一键继承桌面端 LLM 配置

第一次安装插件时设置页提示「检测到桌面端，是否继承翻译配置？」用户点 → 插件 `POST /settings/llm/handoff { extensionId }` → 桌面端弹原生确认框「插件请求继承翻译配置 · 同意 / 拒绝」→ 同意则一次性返回 `{ provider, model, baseUrl, apiKey }` → 插件写入自己 settings → `importedFromDesktop: true` 后不再触发。拒绝或 30s 超时则提示用户手动配置。

## 7. 共享语料库

### 7.1 概念

UGC 短语语料库，目的：当一个用户保存某个短语时，看到**其他人也是在哪个场景 / 哪个视频 / 哪个网页**收藏了同一个短语，给学习上下文。零账号、匿名、自助删除。

### 7.2 服务端架构

复用现有 `whatsub.eversay.cc`（Aliyun ECS 47.93.87.206，已托管 license 后端）：

- **新表**：`corpus_phrases`、`corpus_contributions`（见 4.5）
- **新路由**（挂在现有 Hono app 下）：

```
POST   /api/corpus/contribute
       body: { phraseRaw, contextSentence, source, contributorId }
       → 201 { id, phrase: { tags } }  // 已分类则返 tags；待分类返 tags: { classifiedAt: null }
       → 429 { reason: "rate_limited" }   // contributorId 超阈
       → 400 { reason: "blocklist_match" } // phrase 命中 blocklist

GET    /api/corpus/lookup
       query: phrase=<normalized>
       → 200 { phrase: CorpusPhrase, contributions: CorpusContribution[10] }
       → 404 { reason: "no_data" }       // 该 phrase 还没有人贡献过

POST   /api/corpus/flag
       body: { contributionId, reason: "spam" | "abusive" | "irrelevant" | "other" }
       → 204

DELETE /api/corpus/mine
       body: { contributorId }
       → 200 { deletedCount }            // 一键删除该 contributorId 名下所有贡献

GET    /api/corpus/browse                 // 仅 web 词汇本页用
       query: scene=...&cefr=...&limit=20&offset=0
       → 200 { phrases: CorpusPhrase[], total }
```

### 7.3 分类（异步 LLM 标签）

- 触发：`corpus_phrases` 新记录或 `classifiedAt` 为 null 时入队（PostgreSQL `pg-boss` 或简单的 cron 表）
- LLM：用最便宜的（DeepSeek-chat 或 gpt-4o-mini，**用我们自己的 Key**——这是后端唯一会花钱的地方，估算 $0.0001/phrase × 预期 100k phrase/月 = $10/月）
- Prompt 输出 JSON：
  ```json
  { "scene": "campus", "partOfSpeech": "phrasal_verb", "cefrLevel": "B2" }
  ```
  失败 / 不确定 → 留空，下次重跑
- 跑完后 UPDATE corpus_phrases.tags + classifiedAt
- 没分类完就被查询：返回 phrase 但 tags 字段空，前端不显示 chip 行

### 7.4 反滥用 / 隐私

- **Rate limit**：每 `contributorId` 100 saves/day、5 saves/min（Redis 或 PostgreSQL `INSERT ... ON CONFLICT` 计数）
- **Blocklist**：脏话词表 + NSFW 关键词，命中直接 400 reject；blocklist 可后端热更新
- **URL canonicalize**：剥离 `utm_*` / `fbclid` / `gclid` / 已知 OAuth token / `#fragment`；超过 500 字符的 URL 直接拒（防贴 base64）
- **YouTube 链接归一化**：所有 youtube.com / m.youtube.com / youtu.be / youtube-nocookie 统一成 `https://youtu.be/<id>?t=<sec>` 一种格式（贡献去重）
- **举报**：`/api/corpus/flag` 把 `flagCount++`；超过 3 票阈值自动 `hidden=true`，进人工 review queue
- **自助删除**：插件设置页有「删除我的所有贡献」按钮 → `DELETE /api/corpus/mine`，弹一次二次确认
- **GDPR / 个保法**：contributorId 不绑定 PII；删除接口满足"被遗忘权"；URL 内可能含 PII 是用户行为，需在隐私声明中明确告知

### 7.5 冷启动 · 桌面端 pipeline 数据种子

scripts/video_sourcing 已有数据：
- 16k 视频已搜出、~1500 已过滤、几百已 AI 分析得 highlightWords + keyNotes + scene
- 数据形态：`data/videos/{scene}/{video_id}/{video_id}.analysis.json`

**一次性导入脚本**（`scripts/seed_corpus.py`）：
- 遍历 `data/videos/*/*/{video_id}.analysis.json`
- 每个 highlightWord 对应一条 contribution：
  - `phraseRaw` = highlightWord
  - `contextSentence` = 该 cue 的 text
  - `source.kind = "curator"`、`url = https://youtu.be/{id}?t={cueTime}`、`title = videoTitle`
  - `contributorId = "whatsub-curator"`
- corpus_phrases 的 `tags.scene` 直接从目录名（场景已分好）回填，跳过 LLM 分类
- partOfSpeech / cefrLevel 仍走 LLM 分类
- 预期：3-5 万条 phrase、10-20 万条 contribution，覆盖 18 场景每个 1-5k 条

### 7.6 浏览 / 发现 UI

- 划词气泡内：第二屏「✨ 看看 N 个人怎么收藏的」（5.4 已述）
- 词汇本 popup 顶部加一栏：「🌐 公共语料库 →」入口，打开新标签页 `https://whatsub.eversay.cc/corpus?scene=campus&cefr=B2`
- 公共语料库网页（不在插件内，在 whatsub-website 项目里加）：场景 / 词性 / 难度过滤；这块工程量大，**v1 只暴露入口链接，落地页放到 whatsub-website 项目独立排期**

## 8. 设置 / BYOK 流程

### 8.1 第一次安装

1. 用户装好插件 → 右上角图标小红点
2. 点开 → popup 显示 onboarding：
   - **路径 A · 检测到桌面端运行中**：「一键继承翻译配置」按钮 → 走 6.4 流程
   - **路径 B · 未检测到**：直接进配置页，选 provider + 填 Key → 保存
3. 配置成功后右上角红点消失

### 8.2 没配置 Key 时的降级

- YouTube 上开 CC → 侧栏出现「请先配置 API Key →」（带跳转按钮）
- 划词气泡：「+ 收藏」仍可用（不涉及 LLM），「✨ AI 查词」灰显
- 收藏数据照常写本机 + 入队

### 8.3 复用桌面端 LLM 协议层

`@whatsub/llm-core` workspace 包：
- `protocols/{openai-compat,claude,gemini}.ts` — 三协议 SSE 流式 fetch
- `providers.ts` — 10 个预设（DeepSeek / Kimi / 智谱 / Qwen / 硅基流动 ...）
- `batchTranslate.ts` — 批翻 cues
- `analyze.ts` — 两阶段分析
- `lookupExpression.ts` — 单词单次查询
- `normalizeExpression.ts` — selection 归一化
- `friendlyError.ts` — 错误文案

这些代码当前都在 `client/src/llm/`，迁出去后桌面端改 import 路径。**这是本次设计的一个前置条件**，实施计划里会作为第一阶段任务。

## 9. 错误处理与边界

| 触发 | 表现 | 不做 |
|---|---|---|
| 没填 API Key | CC 开关亮起 → toast「请先到设置填 API Key →」 | 不弹模态、不锁页 |
| 视频无 CC 轨 | 侧栏空状态「这个视频暂无字幕」 | 不做 ASR fallback |
| LLM 接口报错 / 余额不足 | 字幕翻一半停 → 错误条带「翻译失败：xxx · 重试」 | 不删已翻译部分 |
| 翻译流被打断（切视频/标签） | port.disconnect → SW abort fetch | 已翻译部分留下 |
| 桌面端未运行 | 指示器「仅插件」+ 队列堆积 | 不弹错、不催安装 |
| 桌面端版本太老（无 /ping） | 当作未连接 | 不催升级 |
| YouTube 改字幕 API | timedtext 拉取失败 → fallback `video.textTracks.activeCues` 实时抓 | 至少保证英文字幕看得见 |
| SW 被 chrome 杀掉（30s 闲置） | 用 `chrome.alarms` 每 25s 触发心跳 | 心跳里不做实质工作 |
| 队列爆 1000 条 | 按 queuedAt 老的开始丢，本地存最近 1000 条 | 不弹警告（极端情况） |
| 划词选了 contenteditable 内的文字 | 不弹气泡（避免和 Notion / Slack 输入框冲突） | — |
| 划词跨 iframe | v1 不支持，跨 iframe 时不弹气泡 | — |
| 用户隐身模式 | 默认禁用（chrome MV3 默认行为） | 不强制启用 |
| 语料库后端 5xx | 上传入队、查询「N 人收藏」入口隐藏 | 不弹错、不重试到爆 |
| 语料库 4xx (blocklist) | 仅控制台 warn，保存本机 + 桌面端同步照常 | 不告诉用户「你的短语被拒绝」（避免负反馈） |
| 语料库 429 限流 | 30s 后重试，重试 3 次后放弃 | — |
| 用户点举报 | flag 成功 → toast「已收到」；失败 → 静默重试 | — |

## 10. 测试策略

| 层级 | 工具 | 覆盖 |
|---|---|---|
| 单测 | Vitest | `normalizeExpression`, cue parser (json3), syncQueue retry, conflict merge, port discovery |
| 组件测 | Vitest + Testing Library | SidePanel cue rendering, SelectionBubble, SettingsPage |
| E2E | Playwright（带扩展加载）| 装插件 → 打开 YT 测试视频 → 开 CC → 验侧栏 → 划词收藏 → mock 桌面端响应 → 验队列清空 |
| 桌面端 bridge | Rust `#[tokio::test]` + actix-web `TestServer` | 路由签名、端口选择、CORS Origin 校验 |

**不测真实 LLM**：通过 dependency injection 注入 mock provider（已有桌面端模式）。

## 11. 构建 / 发布

### 11.1 构建栈

- **Vite + `@crxjs/vite-plugin`** — MV3 dev/build 链，HMR 在 popup / options / content scripts 都支持
- **pnpm workspace** — 新增三个工作区：
  ```
  whatsub/
  ├── client/                  # 桌面端（已有）
  ├── packages/llm-core/       # 抽出的 LLM 协议层（共享）
  ├── packages/shared-types/   # VocabEntry / CorpusEntry 等共享类型
  └── web-plugin/              # 浏览器插件（本次新增）
  ```
- **Tailwind v3** 走 `@tailwindcss/postcss` 注入 Shadow DOM

### 11.2 manifest.json 关键字段

```json
{
  "manifest_version": 3,
  "name": "whatsub · YouTube 双语字幕 + AI 标黄",
  "version": "0.1.0",
  "permissions": ["storage", "alarms", "scripting"],
  "host_permissions": ["*://*.youtube.com/*", "http://127.0.0.1/*"],
  "content_scripts": [
    { "matches": ["*://*.youtube.com/watch*"], "js": ["yt-cs.js"], "run_at": "document_idle" },
    { "matches": ["http://*/*", "https://*/*"], "js": ["web-cs.js"], "run_at": "document_idle", "all_frames": false }
  ],
  "background": { "service_worker": "sw.js", "type": "module" },
  "action": { "default_popup": "popup.html" },
  "options_ui": { "page": "options.html", "open_in_tab": true }
}
```

### 11.3 发布渠道

| 渠道 | 备注 |
|---|---|
| Chrome Web Store | 首次审核 1-2 周；店面截图 5 张 + 描述 + 隐私权声明（"零上传、BYOK"） |
| Edge Add-ons | 用 Chrome 提交的同一 zip；审核通常 1-3 天 |
| GitHub Releases | 同步发 .crx + manifest，供企业 / 高级用户侧载 |

**版本号独立于桌面端**：插件自己 semver（0.1.x），不和桌面端版本绑定。

### 11.4 隐私声明（写在店面 + popup 链接）

> whatsub 不要求注册、不要求登录、不要求授权码。所有视频字幕、AI 翻译、词汇本都在你的浏览器本地处理，AI 调用走你在设置里配置的 LLM 厂商（DeepSeek / OpenAI / Claude 等），数据不经过我们的服务器。
>
> **唯一的例外**：当你在 YouTube 视频字幕里收藏一个短语时，**默认会**把这个短语 + 上下文句子 + YouTube 链接匿名发送到 whatsub 共享语料库（`whatsub.eversay.cc`），帮助其他学英语的用户看到这个短语出现在什么场景。你的浏览器随机生成一个匿名 ID 标识你的贡献，**不绑定任何个人信息**。
>
> 你可以：
> - 在设置里关闭"分享到公共语料库"（关掉后只读、不上传）
> - 一键删除自己的所有贡献
> - 普通网页划词收藏**默认不会**上传，需要你主动点"也分享到公共语料库"
>
> 上传的内容：短语、上下文句子、URL（去除 utm/token 参数）、网页/视频标题、随机匿名 ID。
> 不上传的内容：你的 IP（服务端只记请求时间用于限流，不持久化）、你的 LLM Key、你的私密笔记、词汇本释义。

## 12. 实施阶段建议（粗）

实际任务拆分由 writing-plans 跟进，这里只给一个量级判断：

| 阶段 | 内容 | 难度 |
|---|---|---|
| 0  | 单独抽 `@whatsub/llm-core` + `@whatsub/shared-types` 包 | M |
| 1  | 插件骨架：Vite + crxjs + manifest + popup + options 页 | S |
| 2  | YouTube CS：CC 监听 + 字幕拉取 + IndexedDB + 翻译流 + 侧栏字幕表 | L |
| 3  | 视频底部叠加层 | M |
| 4  | AI 标黄按钮 + 渲染 | M |
| 5  | 划词气泡（YouTube + 任意网页）+ 词汇本 popup 视图 | M |
| 6  | 桌面端 bridge 服务器 + 路由 + 端口发现 | M |
| 7  | SW 同步队列 + 回放 + 状态指示器 | M |
| 8  | 一键继承桌面端 LLM 配置 | S |
| 9  | 共享语料库后端：扩 license 服务，新增 `/api/corpus/*` 路由 + 两张表 + rate limit + blocklist | M |
| 10 | 共享语料库分类 worker：异步 LLM 标签 job（scene / partOfSpeech / cefrLevel） | S |
| 11 | 共享语料库前端集成：上传时机 + 气泡第二屏「N 个人收藏过」+ 设置开关 + 一键删除 | M |
| 12 | 冷启动种子脚本 `scripts/seed_corpus.py`：从 video_sourcing 数据导入 curator 贡献 | S |
| 13 | E2E 测试 + 跨浏览器手测 + 发布准备 | M |

总量目测 6-8 周一人独立完成（比纯插件多 2 周，主要来自后端 + 种子脚本 + 分类 worker）。

## 13. 未决问题（建议 v2 处理）

- 桌面端 → 插件方向自动同步（避免删除回弹的灵异）
- 一份 token / pairing code 加强 bridge 鉴权
- Firefox MV3 适配
- Bilibili / Netflix 支持
- 「沉浸式翻译」模式（任意网页全量双语）
- 桌面端语料库专页（v1 只入库 + 链接出去）
- 共享语料库公共网页（whatsub-website 项目内的 `/corpus` 浏览页 + 场景过滤）
- 共享语料库人工审核后台（v1 只做自动 blocklist + 自动 hide on flagCount>=3）
- 用户邮箱可选绑定（跨设备合并我的贡献、看「我的贡献统计」）
- 语料库点赞 / 收藏机制（用户给别人的贡献点赞，影响排序）
