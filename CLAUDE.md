# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

> **Two distinct sub-projects.** This document covers the **Python data-collection pipeline** under `scripts/`. The Tauri desktop client (Eversay Studio) lives in [`client/`](./client/) — see [`client/CLAUDE.md`](./client/CLAUDE.md) for its architecture, build, and release flow. The two share no code or runtime; the only overlap is that the pipeline produces training/demo `.mp4`s that occasionally get imported into the client for QA.

## Project Overview

Automated YouTube video sourcing pipeline for **Eversay/EngHub** — an English survival training platform for Chinese international students. The pipeline searches, filters, transcribes, analyzes, and downloads YouTube videos across 18 real-life scenario categories.

Two parallel pipelines exist, both following the same 7-step flow (search → filter → transcribe → AI analyze → human review → download → subtitle analysis):
- **Standard pipeline** (`scripts/video_sourcing/`) — min 100K views, top 20/scene
- **CC pipeline** (`scripts/cc_sourcing/`) — Creative Commons licensed videos, no view minimum, top 30/scene

## Architecture

### Standard Pipeline (5 steps)

```
keywords.yaml → search.py → data/videos/raw_search_results.json
                 filter.py → data/videos/filtered_results.json
              transcribe.py → data/videos/transcribed_results.json
                analyze.py → data/videos/analyzed_results.json + review_report.md
               download.py → data/videos/{scene}/{video_id}/{video_id}.mp4
```

All standard pipeline data files live under `data/videos/`. Scripts in `scripts/video_sourcing/` share `config.py`.

### CC Pipeline (same 7-step flow)

```
keywords.yaml → search_cc.py     → cc_search_results.json       (Step 1)
                filter_cc.py     → cc_filtered_results.json      (Step 2)
                transcribe_cc.py → cc_transcribed_results.json   (Step 3)
                analyze_cc.py    → cc_analyzed_results.json      (Step 4)
                                 → cc_review_report.md
                download_cc.py   → cc-video/{scene}/{video_id}/  (Step 5b)
                (agents)         → {video_id}.analysis.json      (Step 6)
```

CC scripts live in `scripts/cc_sourcing/` and import shared config from `scripts/video_sourcing/config.py`.

Key differences from standard pipeline:
- CC search uses YouTube's native Creative Commons filter (`sp=EgIwAQ%3D%3D` URL parameter) — all results guaranteed CC-licensed
- Skips `min_views` filter (CC content is rare, small channels are fine)
- Keeps top 30 per scene (vs 20 for standard)
- `pipeline_cc.py` is the unified runner: `python pipeline_cc.py 1 2 3` or `--all`

## Commands

All scripts run in the **ASR conda environment** (Python 3.9, CUDA). Always set encoding flags on Windows:

```bash
# ── Standard Pipeline ──
cd scripts/video_sourcing

PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe search.py
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe filter.py
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe transcribe.py
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe download.py [min_score]

# Pipeline runner
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe pipeline.py --all

# Single video processing (--cc flag stores in data/cc-video/ instead)
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe process_single.py <url> <scene> [country] [--download-video] [--cc]

# Batch download thumbnails for all existing videos
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe download_thumbnails.py

# ── CC Pipeline ──
cd scripts/cc_sourcing

# Step-by-step
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe search_cc.py        # Step 1: Search
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe filter_cc.py        # Step 2: Filter
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe transcribe_cc.py    # Step 3: Transcribe
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe analyze_cc.py       # Step 4: AI Analysis
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe download_cc.py      # Step 5b: Download (score>=4)
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe download_cc.py 3    # Download score>=3

# Pipeline runner
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe pipeline_cc.py 1 2 3
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe pipeline_cc.py --all

# Download ALL from search (bypass analysis, for bulk download)
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe download_cc.py --all
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe download_cc.py --all --shard 0 3
```

## Key Technical Decisions

- **yt-dlp over YouTube Data API**: Avoids 10K daily quota limit. Search uses `ytsearch{N}:{query}` flat-playlist mode.
- **CC search via URL filter**: Uses `sp=EgIwAQ%3D%3D` parameter to get only Creative Commons videos directly from YouTube search, avoiding per-video license checks.
- **cookies.txt for YouTube auth**: Required to bypass bot detection. Export via "Get cookies.txt LOCALLY" Edge extension. File at `scripts/video_sourcing/cookies.txt`. Expires after ~100 requests; refresh and re-run (progress preserved).
- **yt-dlp binary at** `C:\Users\renjx\anaconda3\envs\ASR\Scripts\yt-dlp.exe` (v2026.03.17) — requires `--js-runtimes node` flag for full YouTube support.
- **faster-whisper GPU fallback**: Only used when yt-dlp can't get subtitles. Runs on RTX 4090 with float16.
- **裁剪视频必须用 Whisper 提取字幕**: 用户提供的裁剪视频（`cut_*.mp4`）不能从 YouTube 下载字幕（时间轴不匹配）。必须用 faster-whisper 本地转录，命令：`C:/Users/renjx/anaconda3/envs/ASR/python.exe` + `from faster_whisper import WhisperModel; model = WhisperModel("large-v3", device="cuda", compute_type="float16")`，然后用 `clean_vtt.py` 处理。
- **Checkpoint/resume**: `search.py`, `transcribe.py`, and CC download scripts all support interruption recovery. Already-downloaded files are automatically skipped.
- **No parallel sub-agents for subtitle analysis**: Do NOT spawn multiple sub-agents to analyze videos in parallel. Analyze one video at a time sequentially in the main conversation using the `/analyze-subtitles` skill. Sub-agents have write permission issues, consume tokens rapidly, and frequently get stuck mid-generation. Always process videos one by one.
- **Claude agent analysis over API**: Video analysis (Step 4) can be done via Claude Code reading skill specs, bypassing the need for ANTHROPIC_API_KEY.
- **Sub-agent write permissions**: Background sub-agents (launched via Agent tool) cannot receive interactive user approval for Write/Edit tools. **Do NOT delegate file-writing tasks to sub-agents.**
- **Video download via Claude**: Claude Code can directly call yt-dlp to download videos. Single video: `process_single.py <url> <scene> <country> --download-video`. Batch: `download.py [min_score]`.

## Windows-Specific Issues

- Always use `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` — Python defaults to GBK on Windows, breaking Chinese text in JSON.
- Use `-u` flag or `flush=True` on print statements for background tasks (output buffering causes empty output files).
- `conda run` has issues with multiline commands and encoding on Windows — use direct Python path instead.
- subprocess calls to yt-dlp.exe should use binary mode (`capture_output=True` without `text=True`) to avoid GBK decode errors, then decode stderr manually with `errors="replace"`.

## Data Flow

### Standard Pipeline

All standard pipeline data files live under `data/videos/`:

- `data/videos/raw_search_results.json` — ~1500 videos from YouTube search
- `data/videos/filtered_results.json` — top 20 per scene after filter rules
- `data/videos/transcribed_results.json` — videos with subtitle segments and full_text
- `data/videos/analyzed_results.json` — keyed by scene, each video has `analysis.score` (1-5)
- `data/videos/scene_{name}.json` — per-scene splits for agent analysis (full_text trimmed to 4000 chars)
- `data/videos/analyzed_{name}.json` — per-scene analysis results
- `data/videos/subtitles/` — VTT subtitle cache
- `data/videos/{scene}/{video_id}/` — per-video directory containing:
  - `{video_id}.mp4` — video file (with audio track)
  - `{video_id}.jpg` — video thumbnail
  - `{video_id}.analysis.json` — EngHub import-ready analysis (from `/analyze-subtitles` skill)

### CC Pipeline

- `data/cc-video/cc_search_results.json` — Step 1: CC video search results keyed by scene (~647 videos)
- `data/cc-video/cc_filtered_results.json` — Step 2: Filtered + scored, top 30/scene
- `data/cc-video/cc_transcribed_results.json` — Step 3: Videos with subtitle segments and full_text
- `data/cc-video/cc_analyzed_results.json` — Step 4: With AI analysis scores (1-5)
- `data/cc-video/cc_review_report.md` — Step 4: Human review report
- `data/cc-video/cc_transcribe_checkpoint.json` — Step 3: Checkpoint (deleted on completion)
- `data/cc-video/{scene}/{video_id}/` — per-video directory containing:
  - `{video_id}.mp4` — video file
  - `{video_id}.jpg` — thumbnail
  - `{video_id}.en.vtt` — English subtitle
  - `{video_id}.analysis.json` — EngHub import-ready analysis

## Agent & Skill System

- `.agents/video-analyzer.md` — Spec for video content analysis agents. Defines scoring rubric (1-5), key phrase extraction rules, role_setup design, and 10-scene reference table. Used when dispatching parallel sonnet agents for Step 4.
- `.claude/skills/analyze-subtitles/SKILL.md` — Low-level skill (`/analyze-subtitles <vtt-path> <scene> <country>`). Produces EngHub-compatible `.analysis.json` with Chinese translations, highlight words, key notes, role setup with Azure TTS voice mapping.
- `.claude/skills/analyse-one-video/SKILL.md` — Single video skill (`/analyse-one-video <url> <scene> [country]`). Downloads subtitle via yt-dlp, analyzes, and optionally downloads video.
- `.claude/skills/analyse-many-videos/SKILL.md` — Batch skill (`/analyse-many-videos [min_score]`). Generates analysis for all recommended videos, dispatches parallel sonnet agents.
- `.claude/skills/cc-pipeline/SKILL.md` — CC full pipeline skill (`/cc-pipeline [search|filter|transcribe|analyze|download|subtitle-analysis|all|status]`). Same 7-step flow as standard pipeline for Creative Commons videos.
- `scripts/video_sourcing/process_single.py` — CLI helper for single video processing. Supports `--cc` flag to output to `data/cc-video/` instead of `data/videos/`.

## Subtitle Analysis Common Mistakes (avoid repeating)

- **keyNotes 超长**: 初次生成几乎每条都超 120 字符。写完立即用验证脚本检查，不要等全写完再修。目标 40-120 字符。
- **highlightTranslations 含省略号**: `和……结合`、`以……闻名` 等不是 translation 的子串。ht 必须是 translation 字段的**精确子串**，先在 translation 中 ctrl+F 确认。
- **highlightWords 跨 cue 边界**: VTT 每条 cue 是独立的。如果一个短语跨越两条 cue（如 "bouncing" 在上一条，"off the walls" 在下一条），hw 只能用当前 cue 中实际出现的部分。
- **highlightWords 与原文 typo 不匹配**: 原文写了 "teddy beir"（typo），hw 不能用 "teddy bear"。hw 必须是 text 字段的精确子串，即使原文有拼写错误。
- **KP 比例过高**: 初次生成常达 50-78%。目标 30-50%，写完后用脚本计算并批量 demote 非关键条目。
- **每条字幕最多 2 个 highlightWords**: 不要超过 2 个。
- **写完立即跑验证脚本**: 不要跳过验证直接交付。验证项：时间戳顺序、hw 子串匹配、ht 子串匹配、keyNote 长度、KP 比例。

## 18 Scenes

| Key | Chinese | Typical Content |
|-----|---------|-----------------|
| immigration | 入境通关 | Border questions, passport checks |
| housing | 住房安家 | Flat viewing, landlord communication |
| medical | 医疗健康 | GP appointments, NHS 111, symptoms |
| campus | 校园学习 | Enrollment, seminars, office hours |
| banking | 银行财务 | Account opening, transfers |
| shopping | 日常购物 | Supermarket, self-checkout |
| transport | 交通出行 | Underground, Oyster card, taxis |
| social | 社交日常 | Small talk, pub culture |
| dining | 餐饮 | Ordering, pub food, cafes |
| emergency | 紧急情况 | 999 calls, A&E, lost passport |
| job | 求职职场 | Job interview, part-time work, internship |
| phone | 电话沟通 | Customer service calls, booking, complaints |
| salon | 美容美发 | Haircut, nail salon, describing hairstyle |
| driving | 驾照开车 | Driving test, DMV, road experience |
| travel | 旅游度假 | Hotel check-in, sightseeing, car rental |
| fitness | 运动健身 | Gym membership, group class, sports |
| mental_health | 心理健康 | Therapy, counselling, campus support |
| maintenance | 搬家维修 | Plumber, electrician, moving house |
