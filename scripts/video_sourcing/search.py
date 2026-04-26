"""Step 1: YouTube search using yt-dlp (no API quota needed)."""

import json
import subprocess
import time
import yaml

from config import KEYWORDS_FILE, VIDEOS_DIR, SCENE_NAMES


def load_keywords():
    """Load search keywords from YAML, flatten all groups into a single list per scene."""
    with open(KEYWORDS_FILE, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    keywords = {}
    for scene, groups in raw.items():
        flat = []
        for group_name in ("vlog", "documentary", "film_tv"):
            items = groups.get(group_name, [])
            if items:
                flat.extend(items)
        keywords[scene] = flat
    return keywords


def search_videos_ytdlp(query, max_results=10):
    """Search YouTube via yt-dlp and return metadata list."""
    search_url = f"ytsearch{max_results}:{query}"

    result = subprocess.run(
        [
            "yt-dlp",
            "--flat-playlist",
            "--dump-json",
            "--no-warnings",
            search_url,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )

    if result.returncode != 0:
        print(f"    yt-dlp error: {result.stderr[:200]}")
        return []

    results = []
    for line in result.stdout.strip().split("\n"):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue

        video_id = item.get("id", "")
        if not video_id:
            continue

        # yt-dlp flat-playlist gives basic info; duration may be None for some
        duration_secs = item.get("duration")
        # Convert to ISO 8601 for compatibility with filter.py
        iso_duration = _seconds_to_iso(duration_secs) if duration_secs else "PT0S"

        results.append({
            "video_id": video_id,
            "title": item.get("title", ""),
            "channel": item.get("uploader", item.get("channel", "")),
            "channel_id": item.get("channel_id", ""),
            "description": (item.get("description") or "")[:500],
            "duration": iso_duration,
            "duration_seconds": duration_secs or 0,
            "view_count": item.get("view_count") or 0,
            "like_count": item.get("like_count") or 0,
            "published_at": item.get("upload_date", ""),
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "thumbnail": item.get("thumbnail") or item.get("thumbnails", [{}])[0].get("url", "") if item.get("thumbnails") else "",
        })

    return results


def _seconds_to_iso(seconds):
    """Convert seconds to ISO 8601 duration (PT5M30S)."""
    if not seconds:
        return "PT0S"
    h = int(seconds) // 3600
    m = (int(seconds) % 3600) // 60
    s = int(seconds) % 60
    parts = "PT"
    if h:
        parts += f"{h}H"
    if m:
        parts += f"{m}M"
    parts += f"{s}S"
    return parts


def search_all_scenes():
    """Run search for every scene + keyword combination with checkpointing."""
    keywords = load_keywords()

    # Load checkpoint if exists (resume from last run)
    checkpoint_path = VIDEOS_DIR / "search_checkpoint.json"
    if checkpoint_path.exists():
        with open(checkpoint_path, "r", encoding="utf-8") as f:
            all_results = json.load(f)
        print(f"Resuming from checkpoint ({len(all_results)} scenes already done)")
    else:
        all_results = {}

    for scene, kws in keywords.items():
        if scene in all_results and len(all_results[scene]) > 0:
            print(f"[{SCENE_NAMES.get(scene, scene)}] Already done ({len(all_results[scene])} videos), skipping")
            continue

        scene_results = []
        seen_ids = set()

        for kw in kws:
            try:
                results = search_videos_ytdlp(kw, max_results=10)
            except subprocess.TimeoutExpired:
                print(f"    Timeout for '{kw}', skipping")
                continue

            new_count = 0
            for r in results:
                if r["video_id"] not in seen_ids:
                    r["scene"] = scene
                    r["search_query"] = kw
                    scene_results.append(r)
                    seen_ids.add(r["video_id"])
                    new_count += 1

            print(f"  [{SCENE_NAMES.get(scene, scene)}] '{kw}' -> {len(results)} results, {new_count} new")
            time.sleep(1)  # Be polite to YouTube

        all_results[scene] = scene_results
        print(f"[{SCENE_NAMES.get(scene, scene)}] Total unique: {len(scene_results)}\n")

        # Save checkpoint after each scene
        with open(checkpoint_path, "w", encoding="utf-8") as f:
            json.dump(all_results, f, indent=2, ensure_ascii=False)

    # Save final output
    output_path = VIDEOS_DIR / "raw_search_results.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(all_results, f, indent=2, ensure_ascii=False)

    total = sum(len(v) for v in all_results.values())
    print(f"Done. {total} total videos saved to {output_path}")

    # Clean up checkpoint
    if checkpoint_path.exists():
        checkpoint_path.unlink()

    return all_results


if __name__ == "__main__":
    search_all_scenes()
