# Eversay 视频素材自动化采集

为 EngHub 平台的 18 个英语场景自动搜索、筛选、转写、分析、下载 YouTube 视频素材。

## 环境准备

```bash
# 1. 设置编码（Windows 每个终端都要执行一次）
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8

# 2. Python 路径
set PYTHON=C:\Users\renjx\anaconda3\envs\ASR\python.exe
```

cookies.txt 过期处理：YouTube 约 100 次请求后 cookie 过期，用 Edge 扩展 "Get cookies.txt LOCALLY" 重新导出到 `scripts/video_sourcing/cookies.txt`，重跑即可（已完成的自动跳过）。

---

## 下载视频（完整参考）

### Cookie 文件

唯一路径：`C:\Users\renjx\Desktop\Get_Video\scripts\video_sourcing\cookies.txt`

CC 脚本和非 CC 脚本**共用同一个** cookies 文件（`download_cc.py` 通过 `from config import COOKIES_FILE` 引用）。脚本启动时打印 `Cookies: YES/NO`，没读到就当作匿名访问，会被 YouTube 限流。

更新流程：
1. Edge / Chrome 装扩展 **Get cookies.txt LOCALLY**
2. 登录 youtube.com，扩展导出 `cookies.txt`
3. 覆盖到上面的路径
4. 约 100 次请求后过期，重导即可（连续 15 次失败时脚本自动停止）

### yt-dlp 路径与默认参数

二进制：`C:\Users\renjx\anaconda3\envs\ASR\Scripts\yt-dlp.exe`（v2026.03.17）

所有下载脚本内置以下 yt-dlp 参数（无需用户传）：
- `--js-runtimes node`（YouTube 完整支持必需）
- `-f "bv*[height<=1080]+ba/b[height<=1080]/b"` — 最高 1080p
- `--merge-output-format mp4`
- 超时：视频 600s，字幕 120s，封面 60s
- 下载间隔：CC 3 秒/视频，非 CC 5 秒/视频
- 连续 15 次失败自动停止（提示 cookies 可能过期）

### 输出目录

默认：

| 来源 | 路径 |
|------|------|
| 非 CC | `data/videos/{scene}/{video_id}/` |
| CC（含 `--cc`） | `data/cc-video/{scene}/{video_id}/` |

每个视频目录包含 `{video_id}.mp4` / `{video_id}.en.vtt` / `{video_id}.jpg` / `{video_id}.analysis.json`（Step 6 生成）。

### 自定义输出目录（`--output-dir`）

三个下载脚本都支持 `--output-dir <path>`，传入后**所有文件平铺**到该目录，不再生成 `{scene}/{video_id}/` 子目录：

```
<output-dir>/
├── {video_id_1}.mp4
├── {video_id_1}.en.vtt
├── {video_id_1}.jpg
├── {video_id_2}.mp4
└── ...
```

| 脚本 | 行为 |
|------|------|
| `process_single.py --output-dir <path>` | mp4 / vtt / jpg 全部写入该目录 |
| `download.py --output-dir <path>` | mp4 + `download_manifest.json` 写入该目录，不再清理 `subtitles/` 缓存 |
| `download_cc.py --output-dir <path>` | mp4 / vtt / jpg 全部写入该目录，跳过续传时检查的也是该目录 |

注意：
- `--output-dir` 优先级高于 `--cc`（`process_single.py` 中 `--cc` 被忽略）
- 多个视频会同时写入一个目录，按 `video_id` 区分文件名，**没有去重**（同名直接覆盖会被 yt-dlp 自身的「已存在则跳过」逻辑挡住）
- 续传判断也基于该目录里是否已有同名文件

---

### 方式 A：单个 YouTube 链接

`process_single.py` 是**唯一原生支持「直接传 URL」**的脚本。

```bash
cd C:\Users\renjx\Desktop\Get_Video\scripts\video_sourcing

# 仅下字幕+封面（不下 mp4）
%PYTHON% process_single.py <url> <scene> [country]

# 同时下 mp4
%PYTHON% process_single.py <url> <scene> [country] --download-video

# 输出到 cc-video/ 而非 videos/
%PYTHON% process_single.py <url> <scene> [country] --download-video --cc
```

参数：
| 参数 | 说明 | 默认 / 示例 |
|------|------|-----------|
| `<url>` | YouTube 链接或 video_id | `https://youtu.be/abc123` / `abc123` / `https://www.youtube.com/watch?v=abc123` |
| `<scene>` | 18 个场景之一 | `medical`、`dining`、`social`... |
| `[country]` | 国别，用于字幕分析 | `UK`（默认）/ `US` / `AU` / `CA` |
| `--download-video` | 同时下 mp4 | 不传则只下字幕+封面 |
| `--cc` | 输出到 `data/cc-video/` | 不传则到 `data/videos/` |
| `--output-dir <path>` | 自定义输出目录，平铺无子目录 | 优先级高于 `--cc` |

例子：
```bash
%PYTHON% process_single.py https://www.youtube.com/watch?v=dQw4w9WgXcQ dining UK --download-video
%PYTHON% process_single.py dQw4w9WgXcQ medical UK --download-video --cc

# 下到自定义路径
%PYTHON% process_single.py dQw4w9WgXcQ dining UK --download-video --output-dir D:\my_videos
```

---

### 方式 B：按 AI 分数批量下载（Step 4 之后）

读取 `analyzed_results.json` / `cc_analyzed_results.json`，下载分数达标视频。

```bash
# 非 CC
cd C:\Users\renjx\Desktop\Get_Video\scripts\video_sourcing
%PYTHON% download.py              # score >= 4（默认）
%PYTHON% download.py 3            # score >= 3

# CC
cd C:\Users\renjx\Desktop\Get_Video\scripts\cc_sourcing
%PYTHON% download_cc.py           # score >= 4（默认）
%PYTHON% download_cc.py 3         # score >= 3
```

通用参数：
| 参数 | 适用脚本 | 说明 |
|------|---------|------|
| `min_score`（位置参数） | 两个 | 默认 4，传整数即可 |
| `--scenes <s1> <s2> ...` | 仅 `download_cc.py` | 只下指定场景 |
| `--skip-video` | 两个 | 只下字幕+封面，不下 mp4 |
| `--output-dir <path>` | 两个 | 自定义输出目录，平铺无子目录 |

例：
```bash
%PYTHON% download_cc.py 4 --scenes medical dining
%PYTHON% download_cc.py --skip-video
%PYTHON% download_cc.py 4 --output-dir D:\my_videos      # 全部 4 分以上视频平铺到 D:\my_videos
%PYTHON% download.py 4 --output-dir D:\my_videos
```

---

### 方式 C：按人工审核结果批量下载

`review.html` 浏览器导出的 `approved_videos.json` 喂进下载脚本。

```bash
# 非 CC
%PYTHON% C:\Users\renjx\Desktop\Get_Video\scripts\video_sourcing\download.py --approved C:\path\to\approved_videos.json

# CC
%PYTHON% C:\Users\renjx\Desktop\Get_Video\scripts\cc_sourcing\download_cc.py --approved C:\path\to\approved_videos.json
```

`approved_videos.json` 格式（也可手写）：
```json
[
  {"video_id": "dQw4w9WgXcQ", "scene": "dining", "title": "可选"},
  {"video_id": "xyz789",       "scene": "medical", "title": "可选"}
]
```

> **用 `download_cc.py` 手动下单条链接的最简单办法**：手写一个只含一个对象的上述 JSON，用 `--approved` 喂进去。或者直接用方式 A 的 `process_single.py --cc`，更省事。

可叠加 `--skip-video` 来只下字幕+封面，或叠加 `--output-dir <path>` 把所有视频平铺到一个自定义目录：

```bash
%PYTHON% download_cc.py --approved approved_videos.json --output-dir D:\my_videos
```

---

### 方式 D：CC 全量下载（绕过分析）

`download_cc.py` 独有，从 `cc_search_results.json` 读全部视频，跳过 Step 4 评分过滤。

```bash
cd C:\Users\renjx\Desktop\Get_Video\scripts\cc_sourcing

%PYTHON% download_cc.py --all
%PYTHON% download_cc.py --all --scenes medical
%PYTHON% download_cc.py --all --skip-video

# 三终端并行（必须分别开三个终端）
%PYTHON% download_cc.py --all --shard 0 3
%PYTHON% download_cc.py --all --shard 1 3
%PYTHON% download_cc.py --all --shard 2 3
```

| 参数 | 说明 |
|------|------|
| `--all` | 从 `cc_search_results.json` 读全部，绕过 AI 评分 |
| `--shard INDEX TOTAL` | 分片：第 `INDEX` 片（从 0 起），共 `TOTAL` 片 |
| `--scenes <...>` / `--skip-video` / `--output-dir <path>` | 同方式 B |

---

### 方式 E：补下封面

```bash
cd C:\Users\renjx\Desktop\Get_Video\scripts\video_sourcing
%PYTHON% download_thumbnails.py
```

扫描 `data/videos/` 和 `data/cc-video/` 下所有视频目录，缺 `.jpg` 的批量补。

---

### 脚本能力对比

| 脚本 | 直接 URL | 按分数 | 按 approved JSON | 全量 | `--cc` | `--output-dir` | 默认输出 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|---|
| `process_single.py` | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | `data/videos/` |
| `download.py` | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | `data/videos/` |
| `download_cc.py` | ❌ | ✅ | ✅ | ✅ | ❌（固定 cc） | ✅ | `data/cc-video/` |
| `download_thumbnails.py` | ❌ | ❌ | ❌ | 仅封面 | 自动两个都扫 | ❌ | 两者 |

> `download_cc.py` 不接受 URL/video_id 直接输入；要单独下一个链接，用方式 A 或方式 C。

---

## 非CC视频（scripts/video_sourcing/）

```bash
cd C:\Users\renjx\Desktop\Get_Video\scripts\video_sourcing
```

### 完整管线

```bash
%PYTHON% pipeline.py --all          # 一键运行 Step 1-5
%PYTHON% pipeline.py 1 2 3          # 只跑 Step 1-3
```

### 逐步执行

| 步骤 | 命令 | 说明 | 输出文件 |
|------|------|------|---------|
| Step 1 搜索 | `%PYTHON% search.py` | yt-dlp 批量搜索 ~160 关键词 | data/videos/raw_search_results.json |
| Step 2 过滤 | `%PYTHON% filter.py` | 时长/关键词过滤，每场景 top 20 | data/videos/filtered_results.json |
| Step 3 字幕 | `%PYTHON% transcribe.py` | yt-dlp 下载字幕 + Whisper 兜底 | data/videos/transcribed_results.json |
| Step 4 AI分析 | `%PYTHON% analyze.py` | Claude API 评分 1-5 | data/videos/analyzed_results.json |
| Step 5 人工审核 | 打开 review.html | 导入 JSON，勾选视频，导出 approved_videos.json | approved_videos.json |
| Step 5b 下载 | `%PYTHON% download.py --approved approved_videos.json` | 下载人工审核通过的视频 | data/videos/{scene}/{vid}/ |
| Step 6 字幕分析 | Claude Code `/analyse-many-videos` | 生成 .analysis.json | {vid}.analysis.json |

### 单个视频

```bash
%PYTHON% process_single.py <url> <scene> [country] --download-video
# 例：
%PYTHON% process_single.py https://www.youtube.com/watch?v=xxx medical UK --download-video
```

### 裁剪视频（本地 Whisper 转录）

用户手动裁剪的视频（`cut_*.mp4`）无法从 YouTube 下载字幕（时间轴不匹配），必须用 faster-whisper 本地转录：

```bash
# 1. 用 Whisper 转录（ASR 环境，RTX 4090 + float16）
%PYTHON% -c "
from faster_whisper import WhisperModel
model = WhisperModel('large-v3', device='cuda', compute_type='float16')
segments, info = model.transcribe('path/to/cut_video.mp4', language='en', beam_size=5)
# 输出 VTT 文件
with open('output.en.vtt', 'w', encoding='utf-8') as f:
    f.write('WEBVTT\n\n')
    for seg in segments:
        ...  # 写入时间戳和文本
"

# 2. 清理 VTT
%PYTHON% scripts/video_sourcing/clean_vtt.py output.en.vtt

# 3. 用 Claude Code 分析字幕
# /analyze-subtitles output.en.clean.vtt <scene> <country>
```

### 人工审核（review.html）

1. 浏览器打开 `review.html`
2. 拖入 `data/videos/analyzed_results.json`（或 `data/cc-video/cc_analyzed_results.json`）
3. 页面按场景分组显示所有 4-5 分视频，可调整最低分筛选
4. 勾选/取消视频，点击「导出选中 JSON」下载 `approved_videos.json`
5. 用导出文件下载视频：

```bash
# 非CC视频
cd C:\Users\renjx\Desktop\Get_Video\scripts\video_sourcing
%PYTHON% download.py --approved C:\path\to\approved_videos.json

# CC视频
cd C:\Users\renjx\Desktop\Get_Video\scripts\cc_sourcing
%PYTHON% download_cc.py --approved C:\path\to\approved_videos.json
```

### 补充操作

```bash
%PYTHON% download_thumbnails.py      # 批量补下所有视频封面
```

---

## CC视频（scripts/cc_sourcing/）

CC 管线和标准管线使用完全相同的 7 步流程。区别：跳过播放量门槛、每场景保留 top 30。

```bash
cd C:\Users\renjx\Desktop\Get_Video\scripts\cc_sourcing
```

### 完整管线

```bash
%PYTHON% pipeline_cc.py --all       # 一键运行 Step 1-5
%PYTHON% pipeline_cc.py 1 2 3       # 只跑 Step 1-3（搜索+过滤+字幕）
```

### 逐步执行

| 步骤 | 命令 | 说明 | 输出文件 |
|------|------|------|---------|
| Step 1 搜索 | `%PYTHON% search_cc.py` | YouTube CC 过滤器搜索 | data/cc-video/cc_search_results.json |
| Step 2 过滤 | `%PYTHON% filter_cc.py` | 时长/关键词过滤，每场景 top 30 | data/cc-video/cc_filtered_results.json |
| Step 3 字幕 | `%PYTHON% transcribe_cc.py` | 并发下载字幕 + Whisper 兜底 | data/cc-video/cc_transcribed_results.json |
| Step 4 AI分析 | `%PYTHON% analyze_cc.py` | Claude API 评分 1-5 | data/cc-video/cc_analyzed_results.json |
| Step 5 人工审核 | 打开 review.html | 导入 JSON，勾选视频，导出 approved_videos.json | approved_videos.json |
| Step 5b 下载 | `%PYTHON% download_cc.py --approved approved_videos.json` | 下载人工审核通过的视频 | data/cc-video/{scene}/{vid}/ |
| Step 6 字幕分析 | Claude Code `/cc-pipeline subtitle-analysis` | 生成 .analysis.json | {vid}.analysis.json |

### CC 下载选项

```bash
%PYTHON% download_cc.py              # 默认：下载 score >= 4
%PYTHON% download_cc.py 3            # 下载 score >= 3
%PYTHON% download_cc.py --approved approved_videos.json  # 下载审核通过的视频
%PYTHON% download_cc.py --scenes medical dining   # 只下某些场景
%PYTHON% download_cc.py --skip-video  # 只下字幕+封面，不下视频

# 绕过分析，直接下载全部搜索结果
%PYTHON% download_cc.py --all

# 并行下载（开 3 个终端分别跑）
%PYTHON% download_cc.py --all --shard 0 3
%PYTHON% download_cc.py --all --shard 1 3
%PYTHON% download_cc.py --all --shard 2 3
```

### 搜索选项

```bash
%PYTHON% search_cc.py --scenes medical dining     # 只搜某些场景
%PYTHON% search_cc.py --max-results 20            # 每个关键词更多结果
%PYTHON% search_cc.py --all-keywords              # 包含纪实/影视关键词
```

---

## 18 个场景

| Key | 中文 | 典型内容 |
|-----|------|---------|
| immigration | 入境通关 | 边检问答、护照检查 |
| housing | 住房安家 | 看房、和房东沟通 |
| medical | 医疗健康 | GP 问诊、药房、NHS 111 |
| campus | 校园学习 | 注册、研讨课、office hours |
| banking | 银行财务 | 开户、转账 |
| shopping | 日常购物 | 超市、自助结账 |
| transport | 交通出行 | 地铁、公交、出租车 |
| social | 社交日常 | 闲聊、酒吧文化 |
| dining | 餐饮 | 点餐、pub food、咖啡厅 |
| emergency | 紧急情况 | 999/911、急诊、护照丢失 |
| job | 求职职场 | 面试、兼职、实习、职场沟通 |
| phone | 电话沟通 | 打客服、电话预约、投诉 |
| salon | 美容美发 | 剪发、美甲、描述发型 |
| driving | 驾照开车 | 路考、DMV、驾校、上路 |
| travel | 旅游度假 | 酒店入住、景点、租车 |
| fitness | 运动健身 | 办gym卡、团课、球队 |
| mental_health | 心理健康 | 心理咨询、校园支持服务 |
| maintenance | 搬家维修 | 叫plumber、electrician、搬家 |
