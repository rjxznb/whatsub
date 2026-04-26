"""Search and download Creative Commons videos from YouTube using yt-dlp.

Uses YouTube's native CC filter (sp=EgIwAQ%3D%3D) in search URLs,
so all results are guaranteed CC-licensed. No need to check each video individually.

Usage:
    python search_cc.py                              # Search all scenes
    python search_cc.py --scenes medical dining       # Search specific scenes
    python search_cc.py --download                    # Also download video+subtitle+thumbnail
    python search_cc.py --max-results 20              # More results per keyword (default: 10)

Output: data/cc-video/cc_search_results.json
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse

import yaml

# Import shared config from video_sourcing
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "video_sourcing"))
from config import (
    CC_VIDEO_DIR, COOKIES_FILE, FILTER_RULES,
    KEYWORDS_FILE, SCENE_NAMES,
)

YTDLP = r"C:\Users\renjx\anaconda3\envs\ASR\Scripts\yt-dlp.exe"
_cookies_args = ["--cookies", str(COOKIES_FILE)] if COOKIES_FILE.exists() else []
_js_args = ["--js-runtimes", "node"]

RESULTS_FILE = CC_VIDEO_DIR / "cc_search_results.json"

# YouTube search parameter for Creative Commons filter
CC_SP = "EgIwAQ%3D%3D"


# ── Search ──

def search_cc_videos(query, max_results=10):
    """Search YouTube for CC videos using the CC filter parameter."""
    encoded_query = urllib.parse.quote(query)
    search_url = f"https://www.youtube.com/results?search_query={encoded_query}&sp={CC_SP}"

    try:
        result = subprocess.run(
            [YTDLP, *_js_args, *_cookies_args,
             "--flat-playlist", "--dump-json", "--no-warnings",
             "--playlist-end", str(max_results),
             search_url],
            capture_output=True, timeout=120,
        )
    except subprocess.TimeoutExpired:
        return [], "timeout"

    if result.returncode != 0:
        err = result.stderr.decode("utf-8", errors="replace")[:100]
        if "Sign in" in err or "bot" in err:
            return [], "bot_blocked"
        return [], f"error"

    videos = []
    for line in result.stdout.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
            videos.append({
                "video_id": d.get("id") or d.get("url", ""),
                "title": d.get("title", ""),
                "channel": d.get("channel", d.get("uploader", "")),
                "duration": d.get("duration", 0),
                "view_count": d.get("view_count", 0),
                "description": d.get("description", ""),
            })
        except json.JSONDecodeError:
            continue
    return videos, "ok"


# ── Filter ──

def passes_filter(video):
    """Check title exclusion and duration. Skip min_views for CC (rare content)."""
    title_lower = video.get("title", "").lower()
    for kw in FILTER_RULES["exclude_title_keywords"]:
        if kw in title_lower:
            return False
    dur = video.get("duration") or 0
    if dur > 0:
        if dur < FILTER_RULES["min_duration_seconds"] or dur > FILTER_RULES["max_duration_seconds"]:
            return False
    return True


# ── Download helpers ──

def download_subtitle(video_id, scene):
    vid_dir = CC_VIDEO_DIR / scene / video_id
    vid_dir.mkdir(parents=True, exist_ok=True)
    sub_path = vid_dir / f"{video_id}.en.vtt"
    if sub_path.exists() and sub_path.stat().st_size > 0:
        return str(sub_path)
    for sub_args in [
        ["--write-sub", "--sub-lang", "en"],
        ["--write-auto-sub", "--sub-lang", "en"],
    ]:
        try:
            subprocess.run(
                [YTDLP, *_js_args, *_cookies_args,
                 *sub_args, "--skip-download", "--no-warnings",
                 "-o", str(vid_dir / f"{video_id}.%(ext)s"),
                 f"https://www.youtube.com/watch?v={video_id}"],
                capture_output=True, timeout=120,
            )
        except subprocess.TimeoutExpired:
            pass
        if sub_path.exists() and sub_path.stat().st_size > 0:
            return str(sub_path)
    return None


def download_thumbnail(video_id, scene):
    vid_dir = CC_VIDEO_DIR / scene / video_id
    vid_dir.mkdir(parents=True, exist_ok=True)
    out = vid_dir / f"{video_id}.jpg"
    if out.exists() and out.stat().st_size > 0:
        return str(out)
    try:
        subprocess.run(
            [YTDLP, *_js_args, *_cookies_args,
             "--write-thumbnail", "--convert-thumbnails", "jpg",
             "--skip-download", "--no-warnings",
             "-o", str(vid_dir / f"{video_id}.%(ext)s"),
             f"https://www.youtube.com/watch?v={video_id}"],
            capture_output=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        pass
    if out.exists() and out.stat().st_size > 0:
        return str(out)
    for ext in ["webp", "png"]:
        alt = vid_dir / f"{video_id}.{ext}"
        if alt.exists():
            alt.rename(out)
            return str(out)
    return None


def download_video(video_id, scene):
    vid_dir = CC_VIDEO_DIR / scene / video_id
    vid_dir.mkdir(parents=True, exist_ok=True)
    out = str(vid_dir / f"{video_id}.mp4")
    if os.path.exists(out) and os.path.getsize(out) > 0:
        return out
    try:
        subprocess.run(
            [YTDLP, *_js_args, *_cookies_args,
             "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
             "--merge-output-format", "mp4",
             "--no-warnings", "--output", out,
             f"https://www.youtube.com/watch?v={video_id}"],
            capture_output=True, timeout=600,
        )
    except subprocess.TimeoutExpired:
        return None
    if os.path.exists(out) and os.path.getsize(out) > 0:
        return out
    return None


# ── Main ──

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Search YouTube CC videos via yt-dlp")
    parser.add_argument("--scenes", nargs="+", help="Specific scenes to search")
    parser.add_argument("--max-results", type=int, default=10,
                        help="Max results per keyword (default: 10)")
    parser.add_argument("--all-keywords", action="store_true",
                        help="Use all keyword types (default: vlog only)")
    parser.add_argument("--download", action="store_true",
                        help="Download video+subtitle+thumbnail for CC videos found")
    args = parser.parse_args()

    with open(KEYWORDS_FILE, "r", encoding="utf-8") as f:
        keywords = yaml.safe_load(f)

    scenes = args.scenes or list(keywords.keys())
    kw_types = ["vlog", "documentary", "film_tv"] if args.all_keywords else ["vlog"]

    CC_VIDEO_DIR.mkdir(parents=True, exist_ok=True)

    all_results = {}
    total_found = 0
    total_searches = 0
    consecutive_blocks = 0

    for scene in scenes:
        if scene not in keywords:
            print(f"Warning: Unknown scene '{scene}'", flush=True)
            continue

        print(f"\n{'='*50}", flush=True)
        print(f"Scene: {scene} ({SCENE_NAMES.get(scene, '')})", flush=True)
        print(f"{'='*50}", flush=True)

        seen_ids = set()
        scene_results = []

        for kw_type in kw_types:
            kw_list = keywords[scene].get(kw_type, [])
            for query in kw_list:
                total_searches += 1
                print(f"  [{total_searches}] \"{query}\"", end="", flush=True)

                videos, status = search_cc_videos(query, args.max_results)

                if status == "bot_blocked":
                    consecutive_blocks += 1
                    print(f" BLOCKED", flush=True)
                    if consecutive_blocks >= 5:
                        print(f"\n  Too many blocks. Saving and stopping.", flush=True)
                        all_results[scene] = scene_results
                        _save_and_exit(all_results, total_searches, total_found)
                        return
                    time.sleep(3)
                    continue
                elif status != "ok":
                    print(f" ({status})", flush=True)
                    time.sleep(1)
                    continue
                else:
                    consecutive_blocks = 0

                new = 0
                for v in videos:
                    if v["video_id"] not in seen_ids and passes_filter(v):
                        seen_ids.add(v["video_id"])
                        v["scene"] = scene
                        v["search_query"] = query
                        v["license"] = "Creative Commons Attribution license (reuse allowed)"
                        scene_results.append(v)
                        new += 1
                print(f" → {len(videos)} results ({new} new after filter)", flush=True)
                time.sleep(1)

        all_results[scene] = scene_results
        total_found += len(scene_results)
        print(f"\n  {scene}: {len(scene_results)} CC videos", flush=True)

    # Save results
    with open(RESULTS_FILE, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)

    # Summary
    print(f"\n{'='*50}", flush=True)
    print(f"CC Video Search Complete", flush=True)
    print(f"{'='*50}", flush=True)
    print(f"Total searches: {total_searches}", flush=True)
    print(f"Total CC videos found: {total_found}", flush=True)
    for scene in scenes:
        cnt = len(all_results.get(scene, []))
        if cnt:
            print(f"  {scene}: {cnt}", flush=True)
    print(f"Results: {RESULTS_FILE}", flush=True)

    # Download phase
    if args.download and total_found > 0:
        _download_all(all_results)
    elif total_found > 0:
        print(f"\nTo download, run again with --download", flush=True)


def _save_and_exit(results, searches, found):
    with open(RESULTS_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    total = sum(len(v) for v in results.values())
    print(f"\nPartial save: {searches} searches, {total} CC videos found", flush=True)
    print(f"Results: {RESULTS_FILE}", flush=True)


def _download_all(cc_videos):
    total = sum(len(v) for v in cc_videos.values())
    print(f"\nDownloading {total} CC videos...", flush=True)
    ok = 0

    for scene, videos in cc_videos.items():
        for v in videos:
            vid = v["video_id"]
            title = v.get("title", "")[:45]
            print(f"\n  [{scene}] {vid} {title}", flush=True)

            sub = download_subtitle(vid, scene)
            print(f"    subtitle: {'OK' if sub else 'FAIL'}", flush=True)

            thumb = download_thumbnail(vid, scene)
            print(f"    thumbnail: {'OK' if thumb else 'FAIL'}", flush=True)

            video_path = download_video(vid, scene)
            print(f"    video: {'OK' if video_path else 'FAIL'}", flush=True)

            if video_path:
                ok += 1
            time.sleep(2)

    print(f"\n{'='*50}", flush=True)
    print(f"Downloaded {ok}/{total} CC videos to {CC_VIDEO_DIR}", flush=True)


if __name__ == "__main__":
    main()
