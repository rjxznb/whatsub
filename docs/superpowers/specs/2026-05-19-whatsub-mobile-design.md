# whatsub 移动端设计方案

**写于:** 2026-05-19
**作者:** 跟 Claude(opus-4.7)的对话记录,经过整理
**适用范围:** whatsub 生态(桌面 + 浏览器插件)向移动端的延伸

---

## 0. 背景

现状(2026-05-19):
- **桌面端** (`client/`):Tauri 2 + React,完成视频导入 / yt-dlp / whisper / LLM 翻译 / 双语 Player / 词汇本
- **浏览器插件** (`whatsub-plugin/`,独立 repo):通过 127.0.0.1 桥接跟桌面同步词汇本 / LLM 设置
- **服务器** (Hono on Aliyun ECS,`whatsub-license` repo):目前只有 license + trial 表
- **客户端授权**:fingerprint 绑定 3 设备,永久离线

用户希望延伸出**手机端 App**,但接受了一个核心约束:**手机端不下载视频**(App Store / Play Store 政策 + 沙箱限制 + 版权风险)。

---

## 1. 设计原则

1. **桌面端是「生产侧」,手机是「消费 / 复习侧」** —— 不重复实现重型 pipeline (yt-dlp / whisper),手机调用桌面已生成的 analysis.json
2. **YouTube 视频播放走官方 IFrame Player** —— 合法、跨平台、不替代 YouTube
3. **离线包不含视频文件** —— 只含字幕 + 翻译 + TTS 音频,~3 MB 一个 5 分钟视频
4. **fingerprint 复用 license 那套**,不做独立账号系统
5. **手机端发挥**:碎片时间 SR 闪卡 / 跟读评分 / 摄像头查词 等桌面不擅长的场景

---

## 2. 三个先决问题的回答

### Q1:服务器要不要加表?

**要,加 4 张。** localhost 桥接到此为止,跨设备同步必须上云。

```sql
-- analysis_cache: 桌面端跑过的 LLM 翻译同步给手机
CREATE TABLE analysis_cache (
  id BIGSERIAL PRIMARY KEY,
  user_fingerprint TEXT NOT NULL,
  video_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  video_title TEXT,
  video_duration_sec INTEGER,
  analysis_json JSONB NOT NULL,
  llm_provider TEXT,
  llm_model TEXT,
  processed_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  UNIQUE(user_fingerprint, video_id)
);
CREATE INDEX idx_analysis_user ON analysis_cache(user_fingerprint, processed_at DESC);

-- vocab: 跨设备词汇本 + SR 状态
CREATE TABLE vocab (
  id BIGSERIAL PRIMARY KEY,
  user_fingerprint TEXT NOT NULL,
  expression TEXT NOT NULL,
  meaning_zh TEXT NOT NULL,
  usage TEXT,
  video_id TEXT,
  cue_time_sec REAL,
  note_md TEXT,
  highlight_color TEXT,
  added_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  -- SR 闪卡专用字段(SM-2 算法)
  sr_state TEXT,
  sr_due_at TIMESTAMPTZ,
  sr_interval_days INTEGER,
  sr_ease REAL DEFAULT 2.5,
  UNIQUE(user_fingerprint, expression, video_id)
);
CREATE INDEX idx_vocab_user ON vocab(user_fingerprint, updated_at DESC);
CREATE INDEX idx_vocab_due ON vocab(user_fingerprint, sr_due_at) WHERE deleted_at IS NULL;

-- playback_progress: 跨设备续看
CREATE TABLE playback_progress (
  user_fingerprint TEXT NOT NULL,
  video_id TEXT NOT NULL,
  position_sec REAL NOT NULL,
  last_device TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_fingerprint, video_id)
);

-- offline_packs: 离线包元数据(实际文件在 OSS)
CREATE TABLE offline_packs (
  id BIGSERIAL PRIMARY KEY,
  user_fingerprint TEXT NOT NULL,
  video_id TEXT NOT NULL,
  storage_url TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  has_tts BOOLEAN DEFAULT FALSE,
  has_video BOOLEAN DEFAULT FALSE,
  generated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  UNIQUE(user_fingerprint, video_id)
);
```

**fingerprint 复用 license 那套** —— 1 个 license = 3 个设备共享同一份云数据,跟现有授权天然绑定。

### Q2:视频要不要缓存?

**默认不缓存。** 移动端**所有**视频播放靠 YouTube/B 站官方 IFrame,零我方缓存。

| 选项 | 我方判断 |
|---|---|
| 缓存视频文件到云 | ❌ 版权 + 流量 + 政策都炸 |
| P2P 桌面 → 手机 | ❌ Tauri Mobile 难做,审核风险 |
| **只缓存字幕 + 翻译 + TTS 音频 + 缩略图**(无视频) | ✅ **就做这个**,见 Q3 |
| 视频?让用户用 YouTube App 看 / 在线 IFrame 看 | ✅ |

**核心理念:移动端不存视频,只存「学习产物」。**

### Q3:TTS 离线包结构

```
<video_id>.whatsub-pack    # 实际是 zip 或自定义二进制格式
├── meta.json                  # 标题 / 时长 / 来源 URL / 生成时间
├── analysis.json              # 字幕 + 翻译 + 重点短语 + IPA
├── thumbnail.jpg              # 缩略图,~20 KB
├── tts/
│   ├── 0001.mp3               # 第 1 个 cue 的英文 TTS,~30 KB
│   ├── 0002.mp3
│   └── ...
└── vocab_snapshot.json        # 这个视频被收藏的短语快照
```

**生成时机:** 桌面端**用户点「生成离线包」按钮**触发(不自动,因为耗钱)。

**大小测算:**
- 5 分钟 1080p YouTube 视频 → ~50 cue → **2.5 MB**
- 16 分钟 → ~150 cue → **~8 MB**
- 1 小时 TED talk → ~500 cue → **~25 MB**

**对比视频文件:** 1080p 5 分钟约 200 MB,离线包**比视频小 80 倍**,流量友好 + 版权干净。

**离线场景:** 手机无网 → 字幕 + TTS 音频复习 + 词汇本闪卡。**没有视频画面**(画面是 IFrame 在线拉)。

---

## 3. 6 个 Phase 完整计划

| Phase | 主题 | 预估 | 关键 deliverable |
|---|---|---|---|
| 0 | 服务器 + 同步基础设施 | 2-3 周 | 4 张表 + 10+ API + OSS bucket + 桌面同步开关 |
| 1 | 移动端核心 — 字幕查看器 | 3 周 | Share intent → YouTube IFrame + 双语字幕 |
| 2 | 词汇本闪卡 + SR 复习 | 2 周 | Vocab 增量同步 + SM-2 + 每日推送 |
| 3 | 发音跟读 + AI 评分 | 3 周 | 录音 + Azure 评分服务 |
| 4 | 离线包 | 3 周 | 桌面 TTS 批量生成 + 上传 + 手机下载 + 离线播放 |
| 5 | 跨设备续看 | 1 周 | 进度同步 + 二维码接力 |
| 6 | 进阶 + 长尾(机会主义)| 不定 | PiP / 扫词 / 直播字幕 / UGC 共享 |

**总周期:4-6 个月**(1-2 人全职估算)。

### Phase 0:服务器 + 同步基础设施(2-3 周)

后端工作量在这一阶段,后面 5 个 Phase 都靠它。

**Task 0.1 — DB Schema 迁移**
- 4 张表上线到 Aliyun PostgreSQL
- 迁移脚本走 `whatsub-license/migrations/`(套用现有 trial 表迁移机制)

**Task 0.2 — Hono 后端新加 endpoint**

```
GET    /api/v1/analysis                # 列我所有的 analysis_cache,分页
GET    /api/v1/analysis/:video_id      # 拿单个 analysis.json
POST   /api/v1/analysis                # 桌面端上传新解析(去重 by video_id)
DELETE /api/v1/analysis/:video_id

GET    /api/v1/vocab                   # since=<timestamp> 增量拉
POST   /api/v1/vocab/batch             # 批量上传(桌面 vocab.json 推上)
PATCH  /api/v1/vocab/:id               # 单条更新(SR 状态 / 笔记编辑)
DELETE /api/v1/vocab/:id

GET    /api/v1/progress/:video_id      # 拉某视频的播放进度
PUT    /api/v1/progress/:video_id      # 当前设备汇报进度

GET    /api/v1/offline-packs           # 我所有的离线包列表
GET    /api/v1/offline-packs/:video_id/download  # 拿 presigned URL 下载
POST   /api/v1/offline-packs           # 桌面端上传(multipart)
DELETE /api/v1/offline-packs/:video_id
```

鉴权:请求头 `X-Whatsub-Fingerprint` + HMAC 签名。

**Task 0.3 — 阿里云 OSS bucket**
- 开 `whatsub-offline-packs` bucket
- presigned URL 上传 / 下载(15 分钟有效)
- 单用户配额:默认 500 MB,用完老的自动 LRU 淘汰
- CDN 加速国内下载

**Task 0.4 — 桌面端「上传到云」开关**
- Settings 加「云端同步」开关,**默认关**(隐私优先)
- 开启后:analysis 完成 + vocab 改动自动后台同步,UI 显示「已同步 / 同步中」
- 关闭后:纯本地

### Phase 1:移动端核心 — 字幕查看器(3 周)

**Task 1.1 — Tauri 2 Mobile 项目骨架**
- 复用桌面端 `client/src/`(React 大头)+ 新建 `mobile/src-tauri/`
- iOS Simulator + Android Emulator 跑通 hello world
- 复用桌面端 `analysis.json` schema、IPA 字典、词汇本组件

**Task 1.2 — 系统分享接收**
- iOS:Share Extension Target,接收 URL 类型
- Android:`AndroidManifest.xml` 加 `<intent-filter>` 接 `text/plain`
- 收到 URL 后传给 React 端

**Task 1.3 — Innertube API 字幕拉取(Rust 端)**

```rust
// mobile/src-tauri/src/commands/youtube_captions.rs
// 调用 YouTube 公开 Innertube API(yt-dlp 同款)
pub async fn fetch_youtube_captions(video_id: &str) -> Result<Vec<Cue>, String>
pub async fn fetch_bilibili_captions(bvid: &str) -> Result<Vec<Cue>, String>
```

**Task 1.4 — 翻译复用桌面端 pipeline**
- LLM 翻译那套从 `client/src/llm/` 抽成共享包 `whatsub-llm-core`
- 移动端 import,用户在桌面端配的 LLM key 同步过来用

**Task 1.5 — Player 组件(YouTube IFrame Player)**
- React 组件包 YouTube IFrame
- 暴露 `currentTime / play / pause / seek`
- 字幕条:`requestAnimationFrame` 二分查找当前 cue,高亮 + 滚到可视区
- tap 短语 → toast「已加入词汇本」+ POST 上云
- B 站 fallback:B 站官方 player embed

**Task 1.6 — 「云端拿现成」优先**
- 收到 URL → 先 `GET /api/v1/analysis/<video_id>`
- 有 → 秒开,免 LLM 钱
- 没有 → 拉字幕 + LLM → 完成后 POST 上云(可选,看用户云开关)

### Phase 2:词汇本闪卡 + SR 复习(2 周)

**Task 2.1 — Vocab 增量同步**
- 启动 `GET /api/v1/vocab?since=<last_sync>`
- 本地改动队列 → 批量 POST,网络恢复 retry
- 冲突:`updated_at` last-write-wins

**Task 2.2 — SR 算法(SM-2)**
- 卡片正面:`expression` + IPA + TTS 按钮
- 背面:`meaning_zh` + 原句 `usage` + 跳回视频按钮
- 4 个评分:不会 / 一般 / 知道 / 简单
- 写回 `sr_interval_days / sr_due_at / sr_ease`

**Task 2.3 — 每日推送**
- 后端 cron 每天 8:00 查 `sr_due_at <= now` 的 vocab
- > 10 张触发 APNs / FCM push
- 点击 → 打开 App 复习 due 卡

### Phase 3:发音跟读 + AI 评分(3 周)

**Task 3.1 — 录音 + AI 评分**
- 选字幕 → 「跟读」按钮 → MediaRecorder API on Tauri WebView
- 录音 + 原英文 POST 到云端打分服务
- 评分服务(后端):Azure Pronunciation Assessment API 或 Whisper 评分
- 返回:`accuracy_pct / fluency_pct / 错音单词列表`
- 移动端:总分 + 红色标出错音单词

**Task 3.2 — 录音存档(可选)**
- 用户选「保留」→ 存 OSS,日后回听对比

### Phase 4:离线包(3 周)

**Task 4.1 — 桌面端 TTS 批量生成**
- 复用 Settings 现有 TTS 配置(Azure / OpenAI / 阿里云)
- 库页面视频卡片右键 → 「生成离线包」
- 进度条:`<cue index>/<total>`,显示当前批次费用估算
- 缓存到本地 `library/<video_id>/tts/<cue_index>.mp3`

**Task 4.2 — 打包 + 上传**
- 把 `analysis.json` + 所有 mp3 + 缩略图 zip
- multipart 上传到 OSS via Hono 后端
- DB 写 `offline_packs` 记录

**Task 4.3 — 移动端下载 + 解压 + 离线播放器**
- 「我的离线包」列表(`GET /api/v1/offline-packs`)
- 点下载 → 拉到 App 沙箱目录 → 解压
- 离线播放器:Player 组件加 `mode: 'online' | 'offline'`
- offline 模式:播 TTS mp3,跳过 YouTube IFrame

**Task 4.4 — 容量管理**
- 「已用 X GB / 上限 Y GB」(默认 1 GB)
- LRU 自动淘汰
- 手动「全部清理」按钮

### Phase 5:跨设备续看(1 周)

**Task 5.1 — 进度同步**
- 桌面 Player 每 5 秒上传 `playback_progress`
- 移动端打开同 video_id 拉服务器进度,弹「从 12:34 继续看?」
- 反向同款

**Task 5.2 — 二维码接力**
- 桌面 Player 工具栏「📱 在手机上看」→ 二维码(含 video_id + 当前时间戳)
- 手机扫码 → 直接跳到那时间点

### Phase 6:进阶 + 长尾(机会主义)

**Task 6.1 — 画中画**(iOS 16+ / Android 12+)
- IFrame Player 缩到小窗,底部留字幕条

**Task 6.2 — 摄像头扫单词**
- Vision API / Apple Live Text 提取英文文本 → 加进词汇本

**Task 6.3 — 直播字幕(实验性)**
- whisper.cpp 跑在手机本地(small model,~75 MB)
- YouTube Live / Twitch URL → 拉流 → 转录 → 翻译 → 浮窗
- 费电、发热、Android 8 GB RAM 起步

**Task 6.4 — UGC 语料库**
- 用户**主动**勾选「公开我的分析」
- `analysis_cache.is_public BOOLEAN`
- 别的用户碰到同 video_id 优先用别人翻好的
- 跟 memory 里 UGC corpus spec 对接

---

## 4. 完整数据流图

```
                    ┌──────────────────┐
                    │  Aliyun ECS      │
                    │  PostgreSQL +    │
                    │  Hono API +      │
                    │  OSS bucket      │
                    └─────────┬────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
  ┌──────────┐         ┌──────────┐         ┌──────────┐
  │ 桌面端    │         │ 浏览器   │         │ 手机端   │
  │          │         │ 插件     │         │          │
  ├──────────┤         ├──────────┤         ├──────────┤
  │ yt-dlp   │         │ 网页上   │         │ YouTube  │
  │ ↓        │         │ 注入双   │         │ IFrame   │
  │ whisper  │         │ 语字幕   │         │ + TTS    │
  │ ↓        │         │          │         │ 离线模式 │
  │ LLM 翻译 │         │          │         │          │
  │ ↓        │         │ vocab    │         │ vocab    │
  │ analysis │ ───────→│ 同步     │←────────│ SR 闪卡  │
  │ + vocab  │         │          │         │ 跟读评分 │
  │ ↓        │         │          │         │ 续看     │
  │ TTS 离线 │ ───────→ 云存储 ←────────────│ 下载离线│
  │ 包生成   │                              │ 包       │
  └──────────┘                              └──────────┘
       │                                          │
       └──────── 桌面端是「生产」侧 ─────────────┘
       └──────── 手机是「消费 / 复习」侧 ──────────┘
```

---

## 5. 技术栈建议

| 栈 | 优势 | 劣势 |
|---|---|---|
| **Tauri 2 Mobile** ✅ | 复用 React 代码 + 自家 Rust pipeline(包括 whisper.cpp 跑本地)| 还在 beta,iOS App Store 审核风险较高;打包流程不如 Flutter 成熟 |
| React Native | React 生态成熟,审核稳 | Rust 字幕处理要全部重写成 TS |
| Flutter | 性能最好,UI 一致性强 | 全新代码,组件库要重学 |

**推荐:Tauri 2 Mobile。** 桌面 + 移动共享 Rust pipeline 是最大杠杆。

---

## 6. 风险 + 故意不做的事

### 风险

| 风险 | 应对 |
|---|---|
| YouTube 改 Innertube API 破坏字幕拉取 | Rust Innertube client 独立成 crate,版本可动态拉(同 yt-dlp 运行时更新策略) |
| B 站没字幕的视频占 50%+ | 文案明确「这视频没字幕,请用桌面端处理」+ 引导分享给桌面端跑 |
| iOS Share Extension 沙箱内存只 120 MB | 拉字幕 + LLM 丢给主 App,Extension 只做 URL 转发 |
| 翻译费用累积 | analysis_cache 做 UGC 共享(Phase 6.4)— 别人翻过的我直接用 |
| 服务器 OSS 流量费 | 国内 CDN,海外限速 + 引导桌面端处理 |

### 故意不做(扛得住团队压力的列表)

- ❌ 下载 YouTube 视频到手机(任何形式)
- ❌ 替代 YouTube 原生 App(我们是字幕辅助,不是播放器替代)
- ❌ 视频文件存到云(版权 + 流量 + 政策)
- ❌ 移动端独立账号系统(复用 license fingerprint)
- ❌ 实时聊天 / 社交 / 评论(不是学习软件该有的)
- ❌ AI 跟你对话练口语(等市场成熟再说)

---

## 7. 下一步

如果决定推进:

1. **先做 Phase 0** (后端) —— 没有同步基础设施,后面 5 个 Phase 全卡住
2. 同时桌面端加「云端同步」开关 + analysis/vocab 上传逻辑
3. 用桌面 + 浏览器插件 dogfood Phase 0,验证同步 RTT、冲突解决、配额 OK
4. 再开 Phase 1 移动端骨架

**先验证商业模型再开工**:Phase 0 完成时(2-3 周),可以做一次用户调研问「如果手机能看双语字幕 + 跨设备 SR 复习,愿意付多少钱」。如果验证不了价值,不开 Phase 1-6。

---

## Appendix:已搁置的话题

- **方案 B(Android 悬浮字幕)** —— 跟 YouTube 原生 App 同步时间戳几乎不可能(Media Session API 不给 currentTime),pass
- **方案 C(纯字幕速览 MVP)** —— 比这份方案的 Phase 1 更轻,但价值上限低,跳过直接做 Phase 1
- **本地 whisper.cpp 在手机上跑** —— Phase 6.3 实验性,不是 MVP 主线
- **登录系统升级**(从 fingerprint 升到 email + OAuth)—— 等到用户跨多个 license 切换或者想做社交时再说
