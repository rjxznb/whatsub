---
name: cc-pipeline
description: Full pipeline for Creative Commons videos - search, filter, transcribe, AI analyze, download, and batch analyze subtitles. Same 7-step flow as standard pipeline. Usage - /cc-pipeline [action] [options]
user_invocable: true
---

# CC Video Full Pipeline

Search, filter, transcribe, analyze, and download Creative Commons licensed YouTube videos. Follows the same 7-step flow as the standard pipeline defined in `VIDEO_SOURCING_PIPELINE.md`. All results go to `data/cc-video/`.

## Arguments

`$ARGUMENTS` controls which stage to run:

- **search** — Step 1: Search YouTube for CC videos across all 18 scenes
- **filter** — Step 2: Filter by duration/keywords, score, keep top 30/scene
- **transcribe** — Step 3: Download subtitles (concurrent yt-dlp + Whisper fallback)
- **analyze** — Step 4: AI analysis via Claude API or parallel agents (score 1-5)
- **download** — Step 5b: Download video + subtitle + thumbnail for approved videos (score >= 4)
- **subtitle-analysis** — Step 6: Batch generate `.analysis.json` via parallel agents
- **all** (default if empty) — Run steps 1-3 (search + filter + transcribe)
- **full** — Run all steps 1-5b
- **status** — Report current CC pipeline status (counts per scene)

Options (append after action):
- `--scenes medical dining` — specific scenes only
- `--min-score 3` — lower the score threshold for download (default: 4)

## Paths

```
Python:     C:/Users/renjx/anaconda3/envs/ASR/python.exe
CC scripts: C:/Users/renjx/Desktop/Get_Video/scripts/cc_sourcing/
Config:     C:/Users/renjx/Desktop/Get_Video/scripts/video_sourcing/config.py
Data:       C:/Users/renjx/Desktop/Get_Video/data/cc-video/
```

## Workflow

### Step 1: Search (`search`)

Search YouTube for CC videos using the native CC filter (`sp=EgIwAQ%3D%3D`). Each keyword returns only CC-licensed videos.

```bash
cd C:/Users/renjx/Desktop/Get_Video/scripts/cc_sourcing
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe search_cc.py
```

Options:
- `--scenes medical dining` — specific scenes only
- `--max-results 20` — more results per keyword (default: 10)
- `--all-keywords` — include documentary/film_tv keywords (default: vlog only)

Output: `data/cc-video/cc_search_results.json`

### Step 2: Filter (`filter`)

Filter CC search results by duration (60-1200s) and title keywords. **Skip min_views** (CC content is rare). Score by preference keywords, keep top 30 per scene.

```bash
cd C:/Users/renjx/Desktop/Get_Video/scripts/cc_sourcing
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe filter_cc.py
```

Options:
- `--scenes medical dining` — specific scenes only
- `--top 20` — keep top 20 per scene instead of 30

Input: `data/cc-video/cc_search_results.json`
Output: `data/cc-video/cc_filtered_results.json`

### Step 3: Transcribe (`transcribe`)

Download subtitles for filtered CC videos via yt-dlp (concurrent 4 workers) + Whisper GPU fallback. Subtitles saved to `data/cc-video/{scene}/{video_id}/{video_id}.en.vtt`. Checkpoint/resume support.

```bash
cd C:/Users/renjx/Desktop/Get_Video/scripts/cc_sourcing
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe transcribe_cc.py
```

Options:
- `--scenes medical dining` — specific scenes only

Input: `data/cc-video/cc_filtered_results.json`
Output: `data/cc-video/cc_transcribed_results.json`

### Step 4: AI Analysis (`analyze`)

AI analysis of transcribed CC videos. Same scoring rubric as standard pipeline (1-5). Generates review report.

**Option A: Claude API** (if ANTHROPIC_API_KEY is set):
```bash
cd C:/Users/renjx/Desktop/Get_Video/scripts/cc_sourcing
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe analyze_cc.py
```

**Option B: Claude Code parallel agents** (no API key needed):
1. Read `cc_transcribed_results.json`, split by scene into `cc_scene_{name}.json`
2. Dispatch 5 parallel **sonnet** agents, each handling 2 scenes
3. Each agent reads `.agents/video-analyzer.md` spec and analyzes videos
4. Merge results into `cc_analyzed_results.json`
5. Generate `cc_review_report.md`

Input: `data/cc-video/cc_transcribed_results.json`
Output: `data/cc-video/cc_analyzed_results.json` + `data/cc-video/cc_review_report.md`

### Step 5: Human Review

Review `cc_review_report.md`. Only videos with score >= 4 proceed to download.

### Step 5b: Download (`download`)

Download video + subtitle + thumbnail for approved CC videos (score >= min_score).

```bash
cd C:/Users/renjx/Desktop/Get_Video/scripts/cc_sourcing
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe download_cc.py
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe download_cc.py 3   # score >= 3
```

Options:
- `--scenes medical` — specific scenes
- `--skip-video` — only subtitle + thumbnail, no video file
- `--all` — download ALL from search results (bypass analysis filter)
- `--all --shard 0 3` — parallel download in --all mode

If cookies expire mid-download, the user must refresh `cookies.txt` and re-run. Already-downloaded files are skipped automatically.

Input: `data/cc-video/cc_analyzed_results.json` (or `cc_search_results.json` with `--all`)
Output: `data/cc-video/{scene}/{video_id}/{video_id}.mp4` + `.jpg` + `.en.vtt`

### Step 6: Subtitle Analysis (`subtitle-analysis`)

Generate EngHub-importable `.analysis.json` files for downloaded CC videos that have subtitles but no analysis yet.

1. Scan `data/cc-video/{scene}/{video_id}/` directories
2. Find videos with `.en.vtt` but no `.analysis.json`
3. Read the analysis skill spec at `C:\Users\renjx\Desktop\Get_Video\.claude\skills\analyze-subtitles\SKILL.md`
4. Dispatch parallel **sonnet** agents (5-10 videos per agent, max 5 agents)
5. Each agent:
   - Reads the SKILL.md spec
   - For each video: read VTT, deduplicate auto-captions, analyze, write `.analysis.json`
   - Output path: `data/cc-video/{scene}/{video_id}/{video_id}.analysis.json`
   - Country/accent detection: NHS/GP = UK, ER/911 = US, when ambiguous default to UK
6. Wait for all agents, verify output, report summary

### Step 7: Content Import (pending)

Write to database, generate Video records and keyPhrases. (Not yet implemented)

### Pipeline Runner

Run multiple steps at once:
```bash
cd C:/Users/renjx/Desktop/Get_Video/scripts/cc_sourcing
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe pipeline_cc.py 1 2 3
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe pipeline_cc.py --all   # steps 1-5
```

### Status (`status`)

Count and report:
- Total CC videos in `cc_search_results.json` per scene
- Filtered: count in `cc_filtered_results.json` per scene
- Transcribed: count in `cc_transcribed_results.json` per scene
- Analyzed: count in `cc_analyzed_results.json` per scene (+ score distribution)
- Downloaded: count `.mp4` files per scene
- Subtitles: count `.vtt` files per scene
- Subtitle analysis: count `.analysis.json` files per scene
- Thumbnails: count `.jpg` files per scene

## Data Flow

```
keywords.yaml → search_cc.py  → cc_search_results.json       (Step 1)
              → filter_cc.py  → cc_filtered_results.json      (Step 2)
              → transcribe_cc.py → cc_transcribed_results.json (Step 3)
              → analyze_cc.py → cc_analyzed_results.json       (Step 4)
                              → cc_review_report.md
              → download_cc.py → cc-video/{scene}/{vid}/       (Step 5b)
              → agents        → {vid}.analysis.json            (Step 6)
```

## Output Directory Structure

```
data/cc-video/
├── cc_search_results.json          # Step 1: All CC search results by scene
├── cc_filtered_results.json        # Step 2: Filtered + scored, top 30/scene
├── cc_transcribed_results.json     # Step 3: With subtitle segments + full_text
├── cc_analyzed_results.json        # Step 4: With AI analysis scores
├── cc_review_report.md             # Step 4: Human review report
├── cc_transcribe_checkpoint.json   # Step 3: Checkpoint (deleted on completion)
└── {scene}/{video_id}/
    ├── {video_id}.mp4              # Video file (Step 5b)
    ├── {video_id}.jpg              # Thumbnail (Step 5b)
    ├── {video_id}.en.vtt           # English subtitle (Step 3/5b)
    └── {video_id}.analysis.json    # EngHub analysis (Step 6)
```

## Key Rules

- **Never overwrite existing files** — skip check on every download and analysis
- **CC videos skip min_views filter** — CC content is rare, small channels are fine
- **Cookie expiry**: Downloads may fail after ~100 requests. User must refresh `cookies.txt` and re-run. Progress is preserved.
- **VTT deduplication**: Auto-generated YouTube subtitles have rolling word reveals. Keep only the final complete text per timestamp range.
- **Agent sizing**: Max 5 agents, 5-12 videos each. If total <= 5, use a single agent.

## Scene Reference

| Key | Chinese | Typical Content |
|-----|---------|-----------------|
| immigration | 入境通关 | Border questions, passport checks |
| housing | 住房安家 | Flat viewing, landlord communication |
| medical | 医疗健康 | GP/doctor appointments, pharmacy |
| campus | 校园学习 | Enrollment, seminars, office hours |
| banking | 银行财务 | Account opening, transfers |
| shopping | 日常购物 | Supermarket, self-checkout |
| transport | 交通出行 | Underground, buses, taxis |
| social | 社交日常 | Small talk, pub culture |
| dining | 餐饮 | Ordering, pub food, cafes |
| emergency | 紧急情况 | 999/911 calls, A&E, lost passport |
| job | 求职职场 | Job interview, part-time work, internship |
| phone | 电话沟通 | Customer service calls, booking, complaints |
| salon | 美容美发 | Haircut, nail salon, describing hairstyle |
| driving | 驾照开车 | Driving test, DMV, road experience |
| travel | 旅游度假 | Hotel check-in, sightseeing, car rental |
| fitness | 运动健身 | Gym membership, group class, sports |
| mental_health | 心理健康 | Therapy, counselling, campus support |
| maintenance | 搬家维修 | Plumber, electrician, moving house |
