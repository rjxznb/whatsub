---
name: analyse-one-video
description: Process a single YouTube video - download subtitle, analyze it, and optionally download the video. Usage - /analyse-one-video <youtube_url> <scene> [country]
user_invocable: true
---

# Process Single YouTube Video

Process a single YouTube video through the full pipeline: download subtitle, generate EngHub analysis JSON, and optionally download the video file.

## Arguments

`$ARGUMENTS` should contain: `<youtube_url> <scene> [country]`

- **youtube_url** (required): YouTube URL or video ID
- **scene** (required): One of `immigration`, `housing`, `medical`, `campus`, `banking`, `shopping`, `transport`, `social`, `dining`, `emergency`
- **country** (optional, default: UK): Country code — US / UK / AU / CA

## Workflow

### Step 1: Download subtitle

Run the process_single.py script to download the subtitle and get video metadata:

```bash
cd C:/Users/renjx/Desktop/Get_Video/scripts/video_sourcing
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe process_single.py "<youtube_url>" <scene> <country>
```

If the script fails or subtitle is unavailable, inform the user and stop.

### Step 2: Analyze subtitle

Read the skill spec at `C:\Users\renjx\Desktop\Get_Video\.claude\skills\analyze-subtitles\SKILL.md` for the full analysis rules and output JSON schema.

1. Read the downloaded VTT file from `data/subtitles/{video_id}.en.vtt`
2. If the VTT uses auto-generated rolling captions (has `<c>` tags), run the dedup script first:
   ```bash
   PYTHONUTF8=1 C:/Users/renjx/anaconda3/envs/ASR/python.exe C:/Users/renjx/Desktop/Get_Video/scripts/video_sourcing/clean_vtt.py "<vtt_path>" -o "<clean_vtt_path>"
   ```
   Then use the `.clean.vtt` file for analysis.
3. Analyze the dialogue content following all rules in the analyze-subtitles SKILL.md
4. Set `country` based on the argument (US/UK/AU/CA) and choose matching accent for `roleSetup`
5. Write the output JSON to `data/videos/{scene}/{video_id}/{video_id}.analysis.json`

### Step 3: Download video (optional)

Ask the user if they also want to download the video file. If yes:

```bash
cd C:/Users/renjx/Desktop/Get_Video/scripts/video_sourcing
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 C:/Users/renjx/anaconda3/envs/ASR/python.exe process_single.py "<youtube_url>" <scene> <country> --download-video
```

The video will be saved to `data/videos/{scene}/{video_id}/{video_id}.mp4`.

### Step 4: Report

Tell the user what was produced:
- Subtitle path
- Analysis file path (and brief content summary)
- Video file path (if downloaded)

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
