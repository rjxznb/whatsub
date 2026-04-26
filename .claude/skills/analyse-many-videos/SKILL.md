---
name: analyse-many-videos
description: Batch analyze all recommended videos (score >= 4) from the pipeline - generate subtitle analysis files, skip already analyzed ones. Usage - /analyse-many-videos [min_score]
user_invocable: true
---

# Batch Analyze Recommended Videos

Generate EngHub-importable `.analysis.json` files for all recommended videos from the pipeline analysis. Skips videos that already have analysis files.

## Arguments

`$ARGUMENTS` is optional:

- **min_score** (optional, default: 4): Minimum analysis score to process. Videos with `analysis.score >= min_score` in `analyzed_results.json` will be processed.

## Workflow

### Step 1: Identify videos needing analysis

Read `C:\Users\renjx\Desktop\Get_Video\data\videos\analyzed_results.json` and for each video with score >= min_score:
- Check if `data/videos/{scene}/{video_id}/{video_id}.analysis.json` already exists
- Check if `data/videos/subtitles/{video_id}.en.vtt` exists
- Build two lists: **skip** (already analyzed) and **need** (to be analyzed)

Report the counts to the user: how many to skip, how many to analyze.

### Step 2: Dispatch parallel agents

Read the analysis skill spec at `C:\Users\renjx\Desktop\Get_Video\.claude\skills\analyze-subtitles\SKILL.md` for the output JSON schema and all analysis rules.

Group the videos needing analysis into balanced batches (aim for 5-10 videos per agent, max 5 agents). For each batch, launch a **sonnet** agent in background with these instructions:

For each agent:
1. Tell it to read the SKILL.md spec first
2. For each video in its batch:
   - Read the VTT file from `data/videos/subtitles/{video_id}.en.vtt`
   - If VTT uses auto-generated rolling captions, deduplicate (keep final complete version of each cue)
   - Analyze according to SKILL.md rules
   - Determine country from video content: if clearly US-based use "US" and American accents, if UK-based use "UK" and British accents, otherwise default to "UK"
   - Create directory `data/videos/{scene}/{video_id}/` if needed
   - Write output to `data/videos/{scene}/{video_id}/{video_id}.analysis.json`
3. Report summary when done

### Step 3: Wait and verify

After all agents complete:

1. Count total `.analysis.json` files across all `data/videos/{scene}/{video_id}/` directories
2. Break down count by scene
3. Report final summary to user

## Key Rules

- **Never overwrite existing analysis files** — the skip check in Step 1 ensures this
- **Country/accent detection**: Check video content for clues (NHS/GP = UK, ER/911 = US, etc.). When ambiguous, default to UK
- **Agent sizing**: Keep each agent to ~7-12 videos max for reliability. If total is <= 5, use a single agent
- **VTT deduplication**: Auto-generated YouTube subtitles repeat each line with incremental word reveals. Only keep the final complete text for each timestamp range

## Output Structure

Each analysis file follows the schema defined in `analyze-subtitles/SKILL.md`:

```
data/videos/{scene}/{video_id}/{video_id}.analysis.json
```

Contains: subtitles with Chinese translations, keyPhrases, roleSetup (with Azure TTS voice mapping), goalChecklist, complications, commonErrors, culturalNotes.
