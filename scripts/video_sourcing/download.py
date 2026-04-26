"""Step 5: Download approved videos + clean up non-recommended cache."""

import json
import subprocess
import os
import glob as glob_mod
import time

from config import VIDEOS_DIR, SUBTITLES_DIR, SCENE_NAMES, COOKIES_FILE

YTDLP = r"C:\Users\renjx\anaconda3\envs\ASR\Scripts\yt-dlp.exe"
_cookies_args = ["--cookies", str(COOKIES_FILE)] if COOKIES_FILE.exists() else []
_js_args = ["--js-runtimes", "node"]

DOWNLOAD_DELAY = 5  # seconds between downloads to avoid rate limiting


def download_video(video_id, output_dir=None):
    """Download a YouTube video (best quality up to 1080p) using yt-dlp with cookies."""
    if output_dir is None:
        output_dir = VIDEOS_DIR

    output_path = os.path.join(str(output_dir), f"{video_id}.mp4")

    # Skip if already downloaded (any video format)
    existing = glob_mod.glob(os.path.join(str(output_dir), f"{video_id}.*"))
    existing = [f for f in existing if not f.endswith((".part", ".ytdl"))]
    if existing and any(os.path.getsize(f) > 0 for f in existing):
        print(f"  -> Already downloaded: {existing[0]}", flush=True)
        return existing[0]

    # Clean up leftover partial files
    for f in glob_mod.glob(os.path.join(str(output_dir), f"{video_id}.*")):
        if f.endswith((".part", ".ytdl")) or os.path.getsize(f) == 0:
            os.remove(f)

    try:
        result = subprocess.run(
            [
                YTDLP, *_js_args, *_cookies_args,
                "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
                "--merge-output-format", "mp4",
                "--no-warnings",
                "--output", output_path,
                f"https://www.youtube.com/watch?v={video_id}",
            ],
            capture_output=True,
            timeout=600,
        )
    except subprocess.TimeoutExpired:
        print(f"  -> TIMEOUT downloading {video_id}", flush=True)
        return None

    if os.path.exists(output_path):
        size_mb = os.path.getsize(output_path) / (1024 * 1024)
        print(f"  -> Downloaded: {size_mb:.1f} MB", flush=True)
        return output_path
    else:
        print(f"  -> FAILED to download {video_id}", flush=True)
        stderr = result.stderr.decode("utf-8", errors="replace") if result.stderr else ""
        if stderr:
            print(f"     {stderr[:200]}", flush=True)
        return None



def download_approved(min_score=4):
    """Download all videos with analysis score >= min_score."""
    analyzed_path = VIDEOS_DIR / "analyzed_results.json"
    transcribed_path = VIDEOS_DIR / "transcribed_results.json"

    if not analyzed_path.exists():
        print("No analyzed_results.json found. Run analysis first.", flush=True)
        return

    with open(analyzed_path, "r", encoding="utf-8") as f:
        analyzed = json.load(f)

    # Load metadata from transcribed results
    meta = {}
    if transcribed_path.exists():
        with open(transcribed_path, "r", encoding="utf-8") as f:
            transcribed = json.load(f)
        for scene, videos in transcribed.items():
            for v in videos:
                meta[v["video_id"]] = v

    # Collect recommended video IDs
    recommended_ids = set()
    download_list = []

    for scene in SCENE_NAMES:
        videos = analyzed.get(scene, [])
        for v in videos:
            a = v.get("analysis", {})
            score = a.get("score", 0)
            vid = v["video_id"]
            if score >= min_score:
                recommended_ids.add(vid)
                m = meta.get(vid, {})
                download_list.append({
                    "video_id": vid,
                    "scene": scene,
                    "title": m.get("title", vid),
                    "url": m.get("url", f"https://www.youtube.com/watch?v={vid}"),
                    "score": score,
                })

    print(f"Cookies: {'YES' if _cookies_args else 'NO'}", flush=True)
    print(f"Total recommended: {len(download_list)} videos (score >= {min_score})", flush=True)

    # ── Phase 1: Download videos ──
    downloaded = []
    failed = []

    for scene in SCENE_NAMES:
        scene_videos = [v for v in download_list if v["scene"] == scene]
        if not scene_videos:
            continue

        scene_dir = VIDEOS_DIR / scene
        scene_dir.mkdir(parents=True, exist_ok=True)

        print(f"\n[{SCENE_NAMES[scene]}] {len(scene_videos)} videos...", flush=True)

        for v in scene_videos:
            vid = v["video_id"]
            title = v["title"][:50]
            print(f"  [{v['score']}] {title}...", flush=True)

            # Each video gets its own subdirectory: videos/{scene}/{video_id}/
            vid_dir = scene_dir / vid
            vid_dir.mkdir(parents=True, exist_ok=True)

            path = download_video(vid, output_dir=vid_dir)
            if path:
                v["local_path"] = path
                downloaded.append(v)
            else:
                failed.append(v)

            time.sleep(DOWNLOAD_DELAY)

    # ── Phase 3: Clean up non-recommended cache ──
    print(f"\n--- Cleaning up non-recommended cache ---", flush=True)
    cleanup_count = 0

    # Clean subtitles
    for f in glob_mod.glob(str(SUBTITLES_DIR / "*.vtt")):
        vid = os.path.basename(f).split(".")[0]
        if vid not in recommended_ids:
            os.remove(f)
            cleanup_count += 1

    print(f"Cleaned up {cleanup_count} non-recommended cache files.", flush=True)

    # ── Save manifest ──
    manifest = {
        "recommended_ids": sorted(recommended_ids),
        "downloaded": [
            {
                "video_id": v["video_id"],
                "title": v["title"],
                "scene": v["scene"],
                "score": v["score"],
                "local_path": v.get("local_path", ""),
                "url": v["url"],
            }
            for v in downloaded
        ],
        "failed": [
            {"video_id": v["video_id"], "title": v["title"], "url": v["url"]}
            for v in failed
        ],
    }

    manifest_path = VIDEOS_DIR / "download_manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    print(f"\n=== Done ===", flush=True)
    print(f"Downloaded: {len(downloaded)}, Failed: {len(failed)}", flush=True)
    print(f"Cache cleaned: {cleanup_count} files removed", flush=True)
    print(f"Manifest: {manifest_path}", flush=True)


def download_from_approved_file(approved_path, skip_video=False):
    """Download videos listed in an approved_videos.json file (exported from review.html)."""
    with open(approved_path, "r", encoding="utf-8") as f:
        approved = json.load(f)

    print(f"Cookies: {'YES' if _cookies_args else 'NO'}", flush=True)
    print(f"Approved videos: {len(approved)} (from {approved_path})", flush=True)

    downloaded = []
    failed = []

    for scene in SCENE_NAMES:
        scene_videos = [v for v in approved if v.get("scene") == scene]
        if not scene_videos:
            continue

        scene_dir = VIDEOS_DIR / scene
        scene_dir.mkdir(parents=True, exist_ok=True)

        print(f"\n[{SCENE_NAMES[scene]}] {len(scene_videos)} videos...", flush=True)

        for v in scene_videos:
            vid = v["video_id"]
            title = v.get("title", "")[:50]
            print(f"  [{v.get('score', '?')}] {title}...", flush=True)

            vid_dir = scene_dir / vid
            vid_dir.mkdir(parents=True, exist_ok=True)

            if skip_video:
                downloaded.append(v)
                continue

            path = download_video(vid, output_dir=vid_dir)
            if path:
                v["local_path"] = path
                downloaded.append(v)
            else:
                failed.append(v)

            time.sleep(DOWNLOAD_DELAY)

    print(f"\n=== Done ===", flush=True)
    print(f"Downloaded: {len(downloaded)}, Failed: {len(failed)}", flush=True)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Download approved videos")
    parser.add_argument("min_score", nargs="?", type=int, default=4,
                        help="Minimum analysis score to download (default: 4)")
    parser.add_argument("--approved", type=str,
                        help="Path to approved_videos.json (exported from review.html)")
    parser.add_argument("--skip-video", action="store_true",
                        help="Skip video download (only create directories)")
    args = parser.parse_args()

    if args.approved:
        download_from_approved_file(args.approved, skip_video=args.skip_video)
    else:
        download_approved(min_score=args.min_score)
