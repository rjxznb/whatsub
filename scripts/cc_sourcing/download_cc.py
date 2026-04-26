"""Step 5b: Download approved CC videos (score >= min_score).

Reads cc_analyzed_results.json, downloads video + subtitle + thumbnail
for videos with analysis score >= min_score.

Usage:
    python download_cc.py                    # Download score >= 4
    python download_cc.py 3                  # Download score >= 3
    python download_cc.py --all              # Download ALL from cc_search_results.json (skip analysis)
    python download_cc.py --shard 0 3        # Shard 0 of 3 (for --all mode parallel)
    python download_cc.py --scenes medical   # Specific scenes only
    python download_cc.py --skip-video       # Only subtitle+thumbnail, no video file
"""

import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "video_sourcing"))
from config import CC_VIDEO_DIR, COOKIES_FILE, SCENE_NAMES

YTDLP = r"C:\Users\renjx\anaconda3\envs\ASR\Scripts\yt-dlp.exe"
_cookies_args = ["--cookies", str(COOKIES_FILE)] if COOKIES_FILE.exists() else []
_js_args = ["--js-runtimes", "node"]

ANALYZED_FILE = CC_VIDEO_DIR / "cc_analyzed_results.json"
SEARCH_FILE = CC_VIDEO_DIR / "cc_search_results.json"
DOWNLOAD_DELAY = 3


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


def download_approved(min_score=4, scenes=None, skip_video=False):
    """Download CC videos with analysis score >= min_score."""
    if not ANALYZED_FILE.exists():
        print("No cc_analyzed_results.json found. Run analysis first.", flush=True)
        print("Or use --all to download from search results directly.", flush=True)
        return

    with open(ANALYZED_FILE, "r", encoding="utf-8") as f:
        analyzed = json.load(f)

    download_list = []
    for scene, videos in analyzed.items():
        if scenes and scene not in scenes:
            continue
        for v in videos:
            a = v.get("analysis", {})
            score = a.get("score", 0)
            if score >= min_score:
                v["scene"] = scene
                download_list.append(v)

    print(f"Cookies: {'YES' if _cookies_args else 'NO'}", flush=True)
    print(f"Total approved: {len(download_list)} CC videos (score >= {min_score})", flush=True)

    _do_download(download_list, skip_video)


def download_all_from_search(scenes=None, skip_video=False, shard=None):
    """Download ALL CC videos from search results (bypass analysis)."""
    with open(SEARCH_FILE, "r", encoding="utf-8") as f:
        all_results = json.load(f)

    videos = []
    for scene, vids in all_results.items():
        if scenes and scene not in scenes:
            continue
        for v in vids:
            v["scene"] = scene
            videos.append(v)

    if shard:
        idx, total = shard
        videos = [v for i, v in enumerate(videos) if i % total == idx]
        print(f"Shard {idx}/{total}: {len(videos)} videos", flush=True)
    else:
        print(f"Total: {len(videos)} videos", flush=True)

    _do_download(videos, skip_video)


def _do_download(videos, skip_video=False):
    """Core download loop."""
    ok = 0
    fail = 0
    skip = 0
    consecutive_fails = 0

    for i, v in enumerate(videos, 1):
        vid = v["video_id"]
        scene = v["scene"]
        title = v.get("title", "")[:40]

        # Skip already fully downloaded
        vid_dir = CC_VIDEO_DIR / scene / vid
        has_thumb = (vid_dir / f"{vid}.jpg").exists()
        has_sub = (vid_dir / f"{vid}.en.vtt").exists()
        has_video = (vid_dir / f"{vid}.mp4").exists()

        if has_thumb and has_sub and (has_video or skip_video):
            skip += 1
            continue

        print(f"  [{i}/{len(videos)}] [{scene}] {vid} {title}", flush=True)

        sub = download_subtitle(vid, scene)
        thumb = download_thumbnail(vid, scene)

        if not skip_video:
            video_path = download_video(vid, scene)
        else:
            video_path = True

        if sub or thumb or video_path:
            ok += 1
            consecutive_fails = 0
        else:
            fail += 1
            consecutive_fails += 1

        if consecutive_fails >= 15:
            print(f"\n  15 consecutive failures. Cookies may need refresh.", flush=True)
            break

        time.sleep(DOWNLOAD_DELAY)

    print(f"\n{'='*50}", flush=True)
    print(f"Downloaded: {ok}, Failed: {fail}, Skipped (already done): {skip}", flush=True)


def download_from_approved_file(approved_path, skip_video=False):
    """Download CC videos listed in an approved_videos.json file (exported from review.html)."""
    with open(approved_path, "r", encoding="utf-8") as f:
        approved = json.load(f)

    print(f"Cookies: {'YES' if _cookies_args else 'NO'}", flush=True)
    print(f"Approved videos: {len(approved)} (from {approved_path})", flush=True)

    videos = [{"video_id": v["video_id"], "scene": v["scene"],
               "title": v.get("title", "")} for v in approved]
    _do_download(videos, skip_video)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Download CC videos")
    parser.add_argument("min_score", nargs="?", type=int, default=4,
                        help="Minimum analysis score to download (default: 4)")
    parser.add_argument("--all", action="store_true",
                        help="Download ALL from search results (skip analysis filter)")
    parser.add_argument("--approved", type=str,
                        help="Path to approved_videos.json (exported from review.html)")
    parser.add_argument("--shard", nargs=2, type=int, metavar=("INDEX", "TOTAL"),
                        help="Shard index and total (for --all mode parallel)")
    parser.add_argument("--scenes", nargs="+", help="Specific scenes only")
    parser.add_argument("--skip-video", action="store_true",
                        help="Only download subtitle+thumbnail, skip video")
    args = parser.parse_args()

    if args.approved:
        download_from_approved_file(args.approved, skip_video=args.skip_video)
    elif args.all:
        download_all_from_search(scenes=args.scenes, skip_video=args.skip_video,
                                 shard=args.shard)
    else:
        download_approved(min_score=args.min_score, scenes=args.scenes,
                          skip_video=args.skip_video)


if __name__ == "__main__":
    main()
