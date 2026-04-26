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
