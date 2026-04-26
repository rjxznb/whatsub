# 视频素材采集与自动化处理流程

## 目标

为 Eversay 的 18 个场景自动化地找到、筛选、转写、标注优质视频素材。整个流程除了最终的人工审核和版权联系外，全部自动化。

---

## 素材来源策略

### 优先级排序

```
选择标准（按重要性排序）：
  1. 内容有趣，让人看得下去（不是对着镜头念台词的教学视频）
  2. 有真实的对话发生（不是旁白讲解）
  3. 场景和我们的教学目标匹配
  4. 能从中提取地道表达

频道粉丝数和观看量不重要。一个 200 播放量的视频如果拍到了
一段真实的 GP 问诊对话，比 50 万播放的精致 vlog 更有价值。

素材地区：不限于 UK，覆盖所有英语国家（UK/US/AU/CA），只要是英语对话即可。

素材类型：
  留学生/移民 Vlog — 第一人称视角、真实场景、和用户身份一致
    在哪找：YouTube，搜"experience""first time""vlog"
    授权难度：低（博主通常愿意合作，给曝光和免费账号即可）

  生活纪实/真人秀 — 对话 100% 真实、有口音变化、有意外情况
    在哪找：YouTube 上 Channel 5 / BBC / PBS 官方上传的片段
    典型节目：GP Behind Closed Doors, Nothing to Declare, Border Security Australia
    授权难度：高（需联系制作公司，MVP 阶段先标注来源和链接）

  影视剧片段 — 画质好、对话密度高、有故事性
    在哪找：YouTube 上的电影/剧集 clip 频道
    授权难度：最高（不直接使用片段，只提取语言模式写进教学配置）
```

---

## 搜索关键词库

每个场景的搜索关键词，分三组（Vlog / 纪实 / 影视），覆盖 UK、US、Australia、Canada 等英语国家。

完整关键词定义在 `scripts/video_sourcing/keywords.yaml`（约 290 条），以下为各场景摘要：

| 场景 | 关键词数 | 覆盖地区 | 示例关键词 |
|------|---------|---------|-----------|
| immigration | 15 | UK/US/CA/AU | "UK border control experience vlog", "US customs experience", "Border Security Australia" |
| housing | 16 | UK/US/AU | "flat viewing London vlog", "apartment hunting New York vlog", "signing lease first time" |
| medical | 17 | UK/US | "GP appointment UK experience", "urgent care visit experience", "dentist appointment English" |
| campus | 17 | UK/US | "freshers week experience vlog", "first day of college vlog USA", "talking to professor office hours" |
| banking | 13 | UK/US | "opening bank account UK student", "Chase Bank Wells Fargo account", "depositing money bank first time" |
| shopping | 15 | UK/US/AU | "first time at Tesco Sainsbury", "first time at Walmart Target", "Costco Trader Joes first time" |
| transport | 15 | UK/US | "London underground first time", "New York subway first time", "uber lyft first time experience" |
| social | 15 | UK/US | "British small talk experience", "American small talk experience", "culture shock English speaking country" |
| dining | 14 | UK/US | "UK pub food ordering experience", "coffee shop ordering experience", "tipping at restaurant experience" |
| emergency | 16 | UK/US | "calling 999 UK experience", "calling 911 experience", "lost passport what to do abroad" |
| job | 18 | UK/US | "job interview experience UK vlog", "part time job international student", "internship interview experience" |
| phone | 16 | UK/US | "calling customer service in English", "booking appointment over phone", "complaining by phone English" |
| salon | 13 | UK/US | "haircut in UK experience", "barber shop conversation English", "describing hairstyle in English" |
| driving | 17 | UK/US/AU/CA | "UK driving test experience", "DMV experience first time", "driving lesson UK first time" |
| travel | 16 | UK/US | "hotel check in experience English", "Airbnb check in experience", "car rental experience first time" |
| fitness | 14 | UK/US | "joining gym first time experience", "group fitness class experience", "personal trainer first session" |
| mental_health | 15 | UK/US | "therapy session experience English", "university counselling service", "seeing a therapist first time" |
| maintenance | 15 | UK/US | "calling plumber experience UK", "moving house experience UK", "landlord repair request experience" |

---

## 自动化流程

### 整体架构

```
Step 1: 搜索采集    → yt-dlp ytsearch 批量搜索（无 API 配额限制），收集候选视频元数据
Step 2: 初筛过滤    → 按时长(60-1200s)、标题关键词排除教学类视频，按内容偏好评分，每场景保留 Top 20
Step 3: 字幕获取    → yt-dlp + cookies 下载已有字幕（并发4线程），Whisper GPU 兜底转写
Step 4: AI 分析     → Claude 并行 Agent 评估对话真实度+场景匹配度+可教学性（评分 1-5）
Step 5: 人工审核    → 只审核 AI 评分 ≥4 的视频（约 26%），生成 review_report.md
Step 5b: 视频下载   → yt-dlp + cookies 下载推荐视频（1080p MP4），按 videos/{scene}/{video_id}/ 存储
Step 6: 字幕分析    → 使用 /analyze-subtitles skill 生成 .analysis.json，存入对应视频子目录
Step 7: 内容入库    → 写入数据库，生成 Video 记录和 keyPhrases（待实现）
```

### 运行环境

**前置依赖：**
- Conda 环境 `ASR`（Python 3.9, torch 2.6+cu124, faster-whisper, yt-dlp, ffmpeg）
- Node.js（yt-dlp 新版需要 JS 运行时解析 YouTube）
- cookies.txt（通过 Edge 扩展 "Get cookies.txt LOCALLY" 导出 YouTube 登录态）
- RTX 4090 GPU（仅 Whisper 转写需要，大部分视频可直接获取字幕）

**yt-dlp 版本：** `C:\Users\renjx\anaconda3\envs\ASR\Scripts\yt-dlp.exe`（v2026.03.17），需要 `--js-runtimes node` 参数。

### 运行命令

```bash
cd C:\Users\renjx\Desktop\Get_Video\scripts\video_sourcing

# Windows 必须设置 UTF-8 编码（否则中文 JSON 会乱码）
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8

# 使用 ASR conda 环境的 Python
set PYTHON=C:\Users\renjx\anaconda3\envs\ASR\python.exe

# 逐步运行
%PYTHON% search.py          # Step 1: 搜索 → data/videos/raw_search_results.json
%PYTHON% filter.py          # Step 2: 过滤 → data/videos/filtered_results.json
%PYTHON% transcribe.py      # Step 3: 转写 → data/videos/transcribed_results.json
%PYTHON% download.py 4      # Step 5b: 下载 score>=4 的视频 → data/videos/{scene}/{video_id}/

# 或使用 pipeline 一键运行（Step 1-3）
%PYTHON% pipeline.py 1 2 3

# 导出 cookies（需先关闭 Edge 浏览器）
%PYTHON% export_cookies.py
```

**Step 4（AI 分析）** 不通过脚本运行，而是在 Claude Code 中启动并行 Agent：
- 将 `transcribed_results.json` 按场景拆分为 `scene_{name}.json`
- 派发 5 个 sonnet agent，每个处理 2 个场景
- Agent 参照 `.agents/video-analyzer.md` 规范逐视频分析
- 输出 `analyzed_{scene}.json`，合并为 `analyzed_results.json`

**Step 5b（视频下载）** Claude Code 可直接调用 yt-dlp 下载视频：
- 批量下载：`%PYTHON% download.py 4`（下载 score>=4 的视频）
- 单个下载：`%PYTHON% process_single.py <url> <scene> <country> --download-video`
- 视频存储在 `data/videos/{scene}/{video_id}/{video_id}.mp4`（含音轨，无需单独下载音频）

**Step 6（字幕分析）** 在 Claude Code 中使用 skill：
```
# 单个视频：下载字幕 + 分析 + 可选下载视频
/analyse-one-video <youtube_url> <scene> [country]

# 批量分析：处理所有推荐视频（跳过已分析的）
/analyse-many-videos [min_score]

# 仅分析已有字幕文件
/analyze-subtitles <vtt-path> <scene> <country>
```

### 目录结构

```
Get_Video/
├── CLAUDE.md                          # Claude Code 上下文指南
├── VIDEO_SOURCING_PIPELINE.md         # 本文档
│
├── .agents/
│   └── video-analyzer.md             # 视频分析 Agent 规范（评分标准、输出格式）
│
├── .claude/
│   ├── settings.local.json            # Claude Code 权限配置
│   └── skills/
│       ├── analyze-subtitles/
│       │   └── SKILL.md               # 字幕分析 Skill（/analyze-subtitles）
│       ├── analyse-one-video/
│       │   └── SKILL.md               # 单视频处理（/analyse-one-video）
│       └── analyse-many-videos/
│           └── SKILL.md               # 批量字幕分析（/analyse-many-videos）
│
├── scripts/
│   └── video_sourcing/
│       ├── config.py                  # 共享配置：路径、API Key、过滤规则、场景映射
│       ├── keywords.yaml              # 18 场景 × 3 类型的搜索关键词（~296 条）
│       ├── cookies.txt                # YouTube 登录态（Netscape 格式，需定期刷新）
│       ├── export_cookies.py          # 从 Edge/Chrome 导出 cookies
│       ├── search.py                  # Step 1: yt-dlp 搜索（支持断点续传）
│       ├── filter.py                  # Step 2: 时长/观看量/关键词过滤 + 评分排序
│       ├── transcribe.py              # Step 3: 字幕下载（并发）+ Whisper GPU 兜底
│       ├── analyze.py                 # Step 4: Anthropic API 分析（备用，主要用 Agent）
│       ├── download.py                # Step 5b: 批量视频下载 + 缓存清理
│       ├── process_single.py          # 单视频处理：下载字幕/视频 + 准备分析
│       └── pipeline.py                # 统一运行器: python pipeline.py [1-5] 或 --all
│
├── data/
│   ├── videos/                                # 标准 Pipeline 所有数据
│   │   ├── raw_search_results.json            # Step 1 输出：~900 条候选视频
│   │   ├── filtered_results.json              # Step 2 输出：每场景 Top 20（共 200 条）
│   │   ├── transcribed_results.json           # Step 3 输出：含字幕分段和全文（11MB）
│   │   ├── transcribe_checkpoint.json         # Step 3 断点文件（完成后自动删除）
│   │   ├── search_checkpoint.json             # Step 1 断点文件（完成后自动删除）
│   │   ├── scene_{scene_name}.json            # Step 4 输入：按场景拆分（10 个文件）
│   │   ├── analyzed_{scene_name}.json         # Step 4 输出：按场景分析结果（10 个文件）
│   │   ├── analyzed_results.json              # Step 4 合并：全部分析结果
│   │   ├── review_report.md                   # Step 5 人工审核报告（按分数排序）
│   │   ├── download_manifest.json             # Step 5b 下载清单
│   │   ├── subtitles/                         # VTT 字幕缓存
│   │   └── {scene}/{video_id}/                # 每个视频独立子目录
│   │       ├── {video_id}.mp4                 # 视频文件（含音轨）
│   │       ├── {video_id}.jpg                 # 视频封面
│   │       └── {video_id}.analysis.json       # EngHub 导入用分析文件
│   │
│   └── cc-video/                              # CC Pipeline 所有数据
│       ├── cc_search_results.json
│       ├── cc_filtered_results.json
│       ├── cc_transcribed_results.json
│       ├── cc_analyzed_results.json
│       ├── cc_review_report.md
│       └── {scene}/{video_id}/
│           ├── {video_id}.mp4
│           ├── {video_id}.jpg
│           ├── {video_id}.en.vtt
│           └── {video_id}.analysis.json
```

### 关键技术说明

**为什么用 yt-dlp 搜索而非 YouTube Data API：**
YouTube Data API v3 每次搜索消耗 100 单位配额，每日上限 10,000 单位。93 个关键词 × 10 结果 = 仅搜索就耗尽配额。yt-dlp 使用 `ytsearch{N}:{query}` 模式，完全无配额限制。

**cookies.txt 的必要性：**
YouTube 对无登录态的 yt-dlp 请求会触发 "Sign in to confirm you're not a bot" 拦截。通过浏览器扩展导出 Netscape 格式 cookies 后，yt-dlp 可正常下载字幕和视频。cookies 会过期，需定期从 Edge 隐私窗口重新导出。

**断点续传机制：**
`search.py` 每完成一个场景保存 checkpoint，`transcribe.py` 每处理 50 个视频保存一次。中断后重新运行会跳过已完成的部分。

**并行 Agent 分析（替代 Anthropic API）：**
不需要 ANTHROPIC_API_KEY。在 Claude Code 中直接启动多个 sonnet agent，每个 agent 读取 `.agents/video-analyzer.md` 规范，处理 2 个场景的视频分析。5 个 agent 并行可在 10 分钟内完成全部 183 个视频的分析。

### 当前数据统计（第三轮，min_views=100K，排除印度关键词，多国关键词）

```
关键词：~296 条（18 场景 × 3 类型，覆盖 UK/US/AU/CA）
搜索：~1500+ 条候选视频
过滤：174 条通过（min_views=100K，排除教学类+印度相关）
转写：155 条有字幕（19 条无法获取）
分析：155 条已评分
推荐：43 条 score >= 4（占 27.7%）
满分：14 条 score = 5（占 9.0%）
字幕分析：80 条已生成 .analysis.json（含历史轮次累积）
```