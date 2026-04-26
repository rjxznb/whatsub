# 视频字幕分析桌面客户端 — 设计文档

**日期**：2026-04-26
**状态**：设计已确认，待生成实施计划

## 1. 项目定位与范围

### 1.1 产品定位

一个 Tauri 桌面客户端，让用户传入视频（本地文件或 URL），全程在本地完成「音频转录 → AI 翻译与重点短语标注 → 双栏播放学习」的流程。用户自带 LLM API key，整个 pipeline 不依赖任何后端服务器。

### 1.2 目标用户

英语学习者（与现有 EngHub 平台目标群体一致），具备基本的「会去 OpenAI / DeepSeek / 智谱拿一个 API key」的能力。

### 1.3 MVP 必须有的功能

1. **导入视频**：本地文件 / 粘贴 URL（yt-dlp 下载，支持 YouTube、Bilibili 等所有 yt-dlp 站点）
2. **自动 pipeline**：抽音频 → whisper.cpp 本地转录 → LLM 分析（输出兼容现有 EngHub `.analysis.json` 的结构）
3. **播放页**：左视频 + 右 Tab（字幕 / 重点短语 / 角色信息），当前字幕高亮，点击字幕跳转
4. **Library**：自动缓存所有解析过的视频，历史列表展示
5. **设置**：配置 LLM provider（OpenAI 兼容 / Claude 原生 / Gemini 原生）+ key + base_url + model；配置 Whisper 模型大小

### 1.4 MVP 明确不做（v2 再说）

- 多任务并行队列（同时只处理一个视频）
- 字幕导出 / `.analysis.json` 导出按钮
- 标签 / 分类管理
- 字幕编辑（先信任 AI 输出）
- 跨设备同步

## 2. 总体架构

### 2.1 架构图

```
┌───────────────────────────────────────────────────────────────┐
│  Tauri App (单一可执行文件)                                    │
│                                                                │
│  ┌─────────────────────┐         ┌───────────────────────┐    │
│  │ Frontend (React+TS) │ ◄─────► │ Backend (Rust)        │    │
│  │                     │ invoke/ │                       │    │
│  │ • UI 渲染            │ events  │ • subprocess 编排      │    │
│  │ • LLM HTTP 调用      │         │ • 文件 IO + library    │    │
│  │ • 状态管理 (zustand) │         │ • IPC 进度推送          │    │
│  └─────────────────────┘         └───────────┬───────────┘    │
└──────────────────────────────────────────────┼────────────────┘
                                               │ spawn
                ┌──────────────────────────────┼─────────────────┐
                ▼                              ▼                 ▼
        yt-dlp.exe                  ffmpeg.exe          whisper-cli.exe
        (URL 下载)                   (抽音频 wav 16k)    (转录 → SRT)
```

### 2.2 关键分工

| 工作 | 在哪做 | 理由 |
|---|---|---|
| URL 下载视频 | Rust spawn `yt-dlp` | 子进程操作 + 进度解析 Rust 最稳 |
| 视频抽音频 | Rust spawn `ffmpeg` | 同上 |
| Whisper 转录 | Rust spawn `whisper-cli` 二进制 | 同上，且 whisper.cpp 输出 SRT 直接读 |
| LLM 分析（生成 analysis.json） | TS 前端 | 官方 SDK 一等公民、流式输出友好、prompt 模板从 Python 平移过来即可 |
| 播放器 + 字幕渲染 | TS 前端（HTML `<video>`） | 浏览器原生最强 |
| Library 索引读写 | Rust（`library.json` 文件） | 单点写入、避免前端竞态 |

### 2.3 通信

- 前端调 Rust：`@tauri-apps/api` 的 `invoke('command_name', args)`
- Rust 推事件给前端：`Window::emit('event_name', payload)`，前端用 `listen('event_name', handler)` 订阅

### 2.4 LLM key 安全性

Key 存在 Rust 这边的 `settings.json`（`%APPDATA%/Get_Video/`），调用时通过 `invoke('get_settings')` 读取后在前端发请求。本地 app 用户自己的 key，无远程攻击面。

## 3. 数据模型

### 3.1 目录结构（用户机器上 `%APPDATA%/Get_Video/`）

```
Get_Video/
├── settings.json           # LLM provider 配置
├── library.json            # 索引：所有解析过的视频元信息
├── models/                 # Whisper 模型（按需下载）
│   └── ggml-small.bin
└── library/
    └── {video_id}/         # video_id = sha256(file)前12位 或 yt video id
        ├── source.mp4
        ├── audio.wav       # 16kHz mono，转录用
        ├── transcript.srt  # whisper.cpp 原始输出
        ├── thumb.jpg       # library 缩略图
        └── analysis.json   # 最终分析结果（与 EngHub 同 schema）
```

打包二进制（yt-dlp、ffmpeg、whisper-cli）随安装包分发，运行时由 Tauri sidecar 机制定位。Whisper 模型不打包，首次启动按用户选定的尺寸下载到 `models/`。

### 3.2 `settings.json`

```json
{
  "llmProvider": "openai-compatible",
  "openaiCompatible": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-xxx",
    "model": "deepseek-chat"
  },
  "claude": { "apiKey": "sk-ant-xxx", "model": "claude-sonnet-4-6" },
  "gemini": { "apiKey": "AIza-xxx", "model": "gemini-2.5-pro" },
  "whisperModel": "small",
  "defaultScene": "social",
  "defaultCountry": "US"
}
```

`llmProvider` 取值：`openai-compatible` | `claude` | `gemini`
`whisperModel` 取值：`tiny` | `base` | `small` | `medium` | `large-v3`

### 3.3 `library.json`

```json
{
  "videos": [
    {
      "id": "jaY6G5XFnig",
      "title": "Border Officer Conversation",
      "source": { "type": "url", "url": "https://youtube.com/..." },
      "scene": "immigration",
      "country": "US",
      "durationSec": 134.2,
      "thumbnailPath": "library/jaY6G5XFnig/thumb.jpg",
      "createdAt": "2026-04-26T10:30:00Z",
      "status": "ready",
      "lastError": null
    }
  ]
}
```

`source.type` 取值：`local` | `url`
`status` 取值：`analyzing` | `ready` | `failed`

### 3.4 `{video_id}/analysis.json`

完全沿用现有 EngHub schema（已有 60+ 样本和 `analyze-subtitles` skill 的 prompt 规范）。字段：

- `sceneContext`: string
- `subtitles[]`: { time, endTime, text, translation, isKeyPoint, highlightWords[], keyNotes{}, highlightTranslations{} }
- `keyPhrases[]`: { expression, meaningZh, usage, register, speakerRole, minDifficulty }
- `roleSetup`: { name, identity, personality, accent }
- `complications`: { medium[], hard[] }
- `maxRounds`: { easy, medium, hard }
- `commonErrors[]`
- `culturalNotes`
- `country`

未来如需导出给 EngHub 平台上传零改动。

## 4. 核心流程

### 4.1 流程 1：导入并解析视频

```
[Import 弹窗]
  ├─ 拖拽/选择本地文件 ─┐
  └─ 粘贴 URL ──────────┤  → 用户选 scene + country → 点击「开始解析」
                        │
                        ▼
            ┌─────────────────────────────────────┐
            │  Pipeline (Rust 编排，事件推进度)     │
            ├─────────────────────────────────────┤
            │ 1. 准备阶段                          │
            │    URL: spawn yt-dlp → source.mp4   │
            │         + 抽 thumb.jpg               │
            │    本地: 复制到 library 目录          │
            │         + ffmpeg 抽第 1 帧当 thumb    │
            │    → emit("progress", 10%)          │
            │                                     │
            │ 2. 抽音频                            │
            │    ffmpeg → audio.wav (16kHz mono)  │
            │    → emit("progress", 20%)          │
            │                                     │
            │ 3. 转录                              │
            │    whisper-cli -m models/ggml-small │
            │      -f audio.wav -osrt             │
            │    → transcript.srt                 │
            │    → emit("progress", 60%)          │
            │                                     │
            │ 4. 通知前端「转录完成，准备分析」      │
            │    emit("transcribed", srtPath)     │
            └─────────────────────────────────────┘
                        │
                        ▼
            ┌─────────────────────────────────────┐
            │  TS 前端：调 LLM                      │
            ├─────────────────────────────────────┤
            │ • 读 settings 拿 provider+key        │
            │ • 读 transcript.srt → parse 成 cues  │
            │ • 调 providers/{provider}.ts         │
            │   ↳ 用 analyze-subtitles 的 prompt   │
            │   ↳ 流式接收 JSON                    │
            │ • 边收边渲染（subtitles 数组逐行追加）│
            │ • 完成 → invoke('save_analysis', …) │
            │ • Rust 写入 analysis.json + 更新     │
            │   library.json status="ready"       │
            └─────────────────────────────────────┘
                        │
                        ▼
                  自动跳转到播放页
```

**实现要点**：

- LLM 调用走流式，前端边收边渲染，用户进入播放页后立刻看到字幕一行行涌现
- 任何一步失败 → `library.json` 该条目 status="failed" + 记录 `lastError`，library 页用户能看到红色标记并点击「重试」从失败步骤继续
- LLM 调用按 cue 数量分批（每批 ~50 行字幕），避免单次响应过长被截断
- 同样 `video_id` 已存在 → 跳过解析直接进播放页
- video_id 生成规则：URL 来源用 yt-dlp 解析出的视频 ID；本地文件用文件 sha256 前 12 位

### 4.2 流程 2：播放与学习

- 进入播放页 → `invoke('load_video', id)` 拿到 `analysis.json` + 视频路径
- `<video>` 元素源 = `convertFileSrc('library/{id}/source.mp4')`（Tauri 的 file 协议）
- 用 `requestVideoFrameCallback` 监听播放时间 → 高亮当前字幕行 + 自动滚动到当前行
- 点击字幕行 → 设置 `video.currentTime` 跳转
- 高亮词点击/悬停 → 弹出 keyNote 中文释义
- Tab 切换：
  - **字幕**：单列字幕流，纯文本+黄色高亮，当前行蓝色边框
  - **重点短语**：keyPhrases 卡片列表（expression / meaningZh / usage / register / difficulty）
  - **角色信息**：roleSetup（name / identity / personality / accent）

### 4.3 流程 3：首次启动检测依赖

App 第一次跑：

1. 检测打包的 `yt-dlp` / `ffmpeg` / `whisper-cli` 二进制 sidecar 是否就位（应该总是就位）
2. 检测 `models/ggml-{size}.bin`：
   - 缺失 → 进入「首次启动设置」流程，引导用户选 LLM provider + key + Whisper 模型大小
   - 选定后下载 Whisper 模型（默认 small ≈ 466MB）
3. 设置完成才解锁 import 入口

## 5. UI 结构

### 5.1 顶层路由

```
App
├── /library          ← 启动默认页
│   ├── 顶部栏: [+ Import] [⚙ Settings]  搜索框
│   ├── 视频卡片网格 (thumbnail + title + scene tag + duration + status badge)
│   └── 空状态: 引导第一次导入
│
├── /player/:videoId  ← 点 library 卡片进入
│   ├── 顶部栏: ◀ Back   {video title}    {scene tag}
│   ├── 左侧 (58%): <video> + 自定义控件 (play/pause, seek, speed)
│   └── 右侧 (42%): Tab 切换
│       ├── 字幕     (默认 tab，自动滚动到当前行)
│       ├── 重点短语  (keyPhrases 卡片列表)
│       └── 角色信息  (roleSetup name/identity/personality/accent)
│
├── /settings         ← 顶部栏齿轮进入
│   ├── LLM Provider 下拉 (OpenAI 兼容 / Claude / Gemini)
│   ├── 对应 provider 的字段 (key/baseUrl/model)
│   ├── 测试连接按钮 (发个 1-token 请求验活)
│   ├── Whisper 模型 (下拉 + 已下载状态 + 下载按钮)
│   ├── 默认 scene / country
│   └── 数据目录路径 (只读 + 打开按钮)
│
└── ImportModal       ← /library 顶部 [+ Import] 触发
    ├── 来源切换: [本地文件] | [URL]
    ├── 文件选择 / URL 输入
    ├── Scene 下拉 (18 场景)
    ├── Country 下拉 (US/UK/AU/CA)
    └── [开始解析] → 自动跳转到 /player/:videoId 显示进度
```

### 5.2 进度展示

导入后直接进入 `/player/:videoId`，而不是单独的进度页。播放页顶部显示 ProgressBanner 显示「下载视频… / 抽音频… / 转录中… / 分析字幕（38/120）…」。字幕流式生成，用户进入后能看到字幕一行行涌现，转录完成后视频立即可播放（即使 LLM 还在分析后续字幕，已分析部分能正常学）。

## 6. 代码模块划分

```
get-video/
├── src-tauri/                          ← Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── binaries/                       ← 打包的二进制（platform-specific）
│   │   ├── yt-dlp-x86_64-pc-windows-msvc.exe
│   │   ├── ffmpeg-x86_64-pc-windows-msvc.exe
│   │   └── whisper-cli-x86_64-pc-windows-msvc.exe
│   └── src/
│       ├── main.rs                     ← Tauri 启动 + 命令注册
│       ├── commands/
│       │   ├── mod.rs
│       │   ├── library.rs              ← list/get/delete/update_status
│       │   ├── import.rs               ← import_local / import_url 编排
│       │   ├── pipeline.rs             ← yt-dlp / ffmpeg / whisper 子进程
│       │   ├── analysis.rs             ← save_analysis (写 JSON)
│       │   ├── settings.rs             ← read/write settings.json
│       │   └── models.rs               ← Whisper 模型下载/检测
│       ├── core/
│       │   ├── paths.rs                ← AppData 目录解析
│       │   ├── ids.rs                  ← video_id 生成
│       │   ├── srt.rs                  ← SRT 解析（whisper.cpp 输出）
│       │   └── progress.rs             ← 进度事件类型 + emit 辅助
│       └── error.rs                    ← 统一错误类型
│
├── src/                                ← React 前端
│   ├── main.tsx
│   ├── App.tsx                         ← Router
│   ├── pages/
│   │   ├── Library.tsx
│   │   ├── Player.tsx
│   │   └── Settings.tsx
│   ├── components/
│   │   ├── ImportModal.tsx
│   │   ├── VideoPlayer.tsx             ← <video> + 控件
│   │   ├── SubtitleList.tsx            ← 字幕 tab 内容
│   │   ├── KeyPhraseList.tsx           ← 重点短语 tab
│   │   ├── RoleSetupCard.tsx           ← 角色信息 tab
│   │   ├── HighlightWord.tsx           ← 黄色高亮 + 悬停弹释义
│   │   └── ProgressBanner.tsx          ← 顶部分析进度条
│   ├── hooks/
│   │   ├── useTauriCommand.ts
│   │   ├── useTauriEvent.ts            ← 订阅 progress / transcribed / error
│   │   └── useVideoSync.ts             ← 视频时间↔字幕高亮
│   ├── llm/
│   │   ├── types.ts                    ← AnalysisResult / Subtitle 等
│   │   ├── prompts.ts                  ← 从 analyze-subtitles SKILL 平移
│   │   ├── parseSrt.ts
│   │   ├── batchSubtitles.ts           ← 拆批（每批 ~50 cue）
│   │   ├── streamingJson.ts            ← 流式 JSON 解析（按行追加）
│   │   └── providers/
│   │       ├── openaiCompatible.ts
│   │       ├── claude.ts
│   │       └── gemini.ts
│   ├── store/
│   │   ├── settings.ts                 ← zustand
│   │   ├── library.ts
│   │   └── analysis.ts                 ← 当前播放视频的 analysis 状态
│   └── utils/
│       └── time.ts                     ← 秒↔mm:ss 格式化
│
├── package.json
├── vite.config.ts
└── README.md
```

### 6.1 关键模块边界

- `commands/*` 是 Rust ↔ TS 的 IPC 表面，每个文件对应一组功能命令
- `llm/providers/*` 三个 provider 实现同一接口 `streamAnalysis(srtCues, scene, country) → AsyncIterable<Subtitle>`，UI 不感知具体 provider
- `llm/prompts.ts` 平移自 `.claude/skills/analyze-subtitles/SKILL.md`，把所有踩过的坑规则（hw 必须是 text 子串、ht 必须是 translation 子串、keyNote 长度 40-120 字符、KP 比例 30-50%、每行最多 2 个 hw 等）显式写在 prompt 里

## 7. 错误处理

### 7.1 失败处理

- 每条 pipeline 步骤失败 → `library.json` 该条目 status="failed" + 记录 `lastError` 字段
- Library 卡片显示红色感叹号，点击进入 player 页显示错误详情 + 重试按钮（从失败步骤继续）
- LLM 流式中断（网络/限流） → 已分析的字幕保留，用户可点「继续」从中断 cue 续传
- 二进制缺失 → 启动时检测，缺失阻塞所有功能，提示重新安装
- Whisper 模型缺失 → 第一次解析时检测，弹下载弹窗

### 7.2 输出验证

LLM 返回的 analysis.json 在保存前做基础校验（沿用 `analyze-subtitles` skill 的常见错误清单）：
- 时间戳严格递增
- highlightWords 必须是对应 text 字段的子串
- highlightTranslations 必须是对应 translation 字段的子串
- keyNote 长度 40-120 字符（超长截断或重新生成）

校验失败的 cue 标记 `validation: "warning"`，不阻塞展示，但在播放页用小图标提示。

## 8. 测试策略

MVP 务实版：

- **Rust 端**：commands 用 `#[cfg(test)]` 单测（SRT 解析、video_id 生成、paths 解析）；pipeline subprocess 用集成测试，准备一个 5 秒测试视频走完整流程
- **TS 前端**：`llm/parseSrt.ts` `llm/batchSubtitles.ts` `llm/streamingJson.ts` 这三个纯函数模块用 Vitest 单测；UI 组件不做单测，靠手动验收
- **不写 E2E**——Tauri E2E 工具链（WebDriver）成本远超 MVP 收益

## 9. 关键技术决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 输入形式 | 仅视频文件 + URL（不接受外部 SRT） | 简化 UI，让客户端"看一眼视频就出分析"是核心卖点 |
| 转录引擎 | 本地 whisper.cpp | 不依赖第二个 API key、保护隐私、长期免费 |
| LLM provider 范围 | OpenAI 兼容 + Claude 原生 + Gemini 原生 | 覆盖中国/海外主流厂商，原生 SDK 拿到 prompt caching 等高级能力 |
| 桌面框架 | Tauri | 安装包小、Rust 子进程性能好、WebView UI 开发体验好 |
| 前端框架 | React + TypeScript | 用户偏好，生态成熟 |
| 架构模式 | Rust 子进程 + JS 调 LLM | Rust 做系统侧脏活，JS 用一等公民 LLM SDK，分工最干净 |
| Library 形态 | 自动缓存 + 历史列表（无 tag/分类） | 学习者最关心"昨天看的那个视频在哪"，复杂分类 v2 再说 |
| 播放页右侧 | Tab（字幕 / 重点短语 / 角色信息） | 字幕流干净、keyPhrases 有专属复习位 |
| 二进制分发 | 打包进安装包 | 用户开箱即用，体积换体验 |
| Whisper 模型 | 按需下载（默认 small） | 模型最大 3GB，打包不现实，下载粒度让用户选 |
| LLM 调用模式 | 流式 + 拆批（每批 ~50 cue） | 体感快、避免长输出截断 |
| 并发 | MVP 单视频处理 | 复杂度收敛，多任务队列 v2 再说 |

## 10. 不在 MVP 范围

明确推到 v2 或更后的功能：

- 多任务并行处理队列
- analysis.json 导出按钮（用于上传到 EngHub）
- 视频标签 / 自定义分类
- 字幕手动编辑
- 跨设备同步
- 复习模式（间隔重复 keyPhrases）
- 字幕样式自定义（字体、颜色）
- 多语言 UI（先中文一种）
