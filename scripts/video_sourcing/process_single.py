"""Process a single YouTube video: download subtitle + prepare for analysis."""

import subprocess
import os
import sys
import json

from config import VIDEOS_DIR, CC_VIDEO_DIR, SUBTITLES_DIR, COOKIES_FILE, SCENE_NAMES

YTDLP = r"C:\Users\renjx\anaconda3\envs\ASR\Scripts\yt-dlp.exe"
_cookies_args = ["--cookies", str(COOKIES_FILE)] if COOKIES_FILE.exists() else []
_js_args = ["--js-runtimes", "node"]


def extract_video_id(url):
    """Extract video ID from various YouTube URL formats."""
    if "youtu.be/" in url:
        return url.split("youtu.be/")[1].split("?")[0]
    if "v=" in url:
        return url.split("v=")[1].split("&")[0]
    # Assume it's already a video ID
    return url.strip()


def get_video_info(video_id):
    """Get video title and description via yt-dlp."""
    try:
        result = subprocess.run(
            [YTDLP, *_js_args, *_cookies_args,
             "--print", "%(title)s|||%(duration)s|||%(view_count)s|||%(channel)s",
             "--no-warnings",
             f"https://www.youtube.com/watch?v={video_id}"],
            capture_output=True, timeout=60,
        )
        output = result.stdout.decode("utf-8", errors="replace").strip()
        parts = output.split("|||")
        if len(parts) >= 4:
            return {
                "title": parts[0],
                "duration": parts[1],
                "views": parts[2],
                "channel": parts[3],
            }
    except Exception as e:
        print(f"Warning: Could not get video info: {e}", flush=True)
    return {}


def download_subtitle(video_id, flat_dir=None):
    """Download English subtitle for a video. Returns path or None.

    If flat_dir is provided, write directly to that directory; otherwise use
    the SUBTITLES_DIR cache.
    """
    target_dir = flat_dir if flat_dir is not None else SUBTITLES_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    sub_path = target_dir / f"{video_id}.en.vtt"
    if sub_path.exists() and sub_path.stat().st_size > 0:
        print(f"Subtitle already exists: {sub_path}", flush=True)
        return str(sub_path)

    # Try manual subs first, then auto
    for sub_args in [
        ["--write-sub", "--sub-lang", "en"],
        ["--write-auto-sub", "--sub-lang", "en"],
    ]:
        try:
            subprocess.run(
                [YTDLP, *_js_args, *_cookies_args,
                 *sub_args, "--skip-download", "--no-warnings",
                 "-o", str(target_dir / f"{video_id}.%(ext)s"),
                 f"https://www.youtube.com/watch?v={video_id}"],
                capture_output=True, timeout=120,
            )
        except subprocess.TimeoutExpired:
            pass

        if sub_path.exists() and sub_path.stat().st_size > 0:
            print(f"Subtitle downloaded: {sub_path}", flush=True)
            return str(sub_path)

    print("Failed to download subtitle.", flush=True)
    return None


def download_thumbnail(video_id, scene, output_base=None, flat_dir=None):
    """Download video thumbnail.

    If flat_dir is provided, write directly to that directory.
    Otherwise write to {output_base}/{scene}/{video_id}/.
    """
    if flat_dir is not None:
        vid_dir = flat_dir
    else:
        if output_base is None:
            output_base = VIDEOS_DIR
        vid_dir = output_base / scene / video_id
    vid_dir.mkdir(parents=True, exist_ok=True)
    output_path = vid_dir / f"{video_id}.jpg"

    if output_path.exists() and output_path.stat().st_size > 0:
        print(f"Thumbnail already exists: {output_path}", flush=True)
        return str(output_path)

    try:
        # yt-dlp writes thumbnail as {video_id}.jpg/webp, we convert to jpg
        result = subprocess.run(
            [YTDLP, *_js_args, *_cookies_args,
             "--write-thumbnail", "--convert-thumbnails", "jpg",
             "--skip-download", "--no-warnings",
             "-o", str(vid_dir / f"{video_id}.%(ext)s"),
             f"https://www.youtube.com/watch?v={video_id}"],
            capture_output=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        print("Thumbnail download timed out.", flush=True)
        return None

    # yt-dlp may save as {video_id}.jpg directly
    if output_path.exists() and output_path.stat().st_size > 0:
        print(f"Thumbnail downloaded: {output_path}", flush=True)
        return str(output_path)

    # Check for other formats that might not have been converted
    for ext in ["webp", "png"]:
        alt = vid_dir / f"{video_id}.{ext}"
        if alt.exists():
            alt.rename(output_path)
            print(f"Thumbnail downloaded: {output_path}", flush=True)
            return str(output_path)

    print("Thumbnail download failed.", flush=True)
    stderr = result.stderr.decode("utf-8", errors="replace") if result.stderr else ""
    if stderr:
        print(f"  {stderr[:300]}", flush=True)
    return None


def download_video(video_id, scene, output_base=None, flat_dir=None):
    """Download video.

    If flat_dir is provided, write directly to that directory.
    Otherwise write to {output_base}/{scene}/{video_id}/.
    """
    if flat_dir is not None:
        vid_dir = flat_dir
    else:
        if output_base is None:
            output_base = VIDEOS_DIR
        vid_dir = output_base / scene / video_id
    vid_dir.mkdir(parents=True, exist_ok=True)
    output_path = str(vid_dir / f"{video_id}.mp4")

    # Skip if already downloaded
    if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
        size_mb = os.path.getsize(output_path) / (1024 * 1024)
        print(f"Video already exists: {output_path} ({size_mb:.1f} MB)", flush=True)
        return output_path

    try:
        result = subprocess.run(
            [YTDLP, *_js_args, *_cookies_args,
             "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
             "--merge-output-format", "mp4",
             "--no-warnings",
             "--output", output_path,
             f"https://www.youtube.com/watch?v={video_id}"],
            capture_output=True, timeout=600,
        )
    except subprocess.TimeoutExpired:
        print("Video download timed out.", flush=True)
        return None

    if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
        size_mb = os.path.getsize(output_path) / (1024 * 1024)
        print(f"Video downloaded: {output_path} ({size_mb:.1f} MB)", flush=True)
        return output_path
    else:
        print("Video download failed.", flush=True)
        stderr = result.stderr.decode("utf-8", errors="replace") if result.stderr else ""
        if stderr:
            print(f"  {stderr[:300]}", flush=True)
        return None


def main():
    import argparse
    from pathlib import Path

    parser = argparse.ArgumentParser(
        description="Download a single YouTube video (subtitle + thumbnail + optional mp4)",
    )
    parser.add_argument("url", help="YouTube URL or video_id")
    parser.add_argument("scene", help=f"One of: {', '.join(SCENE_NAMES.keys())}")
    parser.add_argument("country", nargs="?", default="UK",
                        help="Country code for analysis (UK/US/AU/CA, default UK)")
    parser.add_argument("--download-video", action="store_true",
                        help="Also download the video mp4 file")
    parser.add_argument("--cc", action="store_true",
                        help="Store in data/cc-video/ instead of data/videos/ (ignored if --output-dir set)")
    parser.add_argument("--output-dir", type=str,
                        help="Custom output directory. All files (mp4/vtt/jpg) go directly into this directory, "
                             "no scene/video_id subfolders")
    args = parser.parse_args()

    url = args.url
    scene = args.scene
    country = args.country
    do_download = args.download_video
    use_cc = args.cc
    flat_dir = Path(args.output_dir).resolve() if args.output_dir else None

    # Choose output directory
    output_base = CC_VIDEO_DIR if use_cc else VIDEOS_DIR

    if scene not in SCENE_NAMES:
        print(f"Error: Unknown scene '{scene}'. Choose from: {', '.join(SCENE_NAMES.keys())}", flush=True)
        sys.exit(1)

    video_id = extract_video_id(url)
    print(f"\n{'='*50}", flush=True)
    print(f"Video ID: {video_id}", flush=True)
    print(f"Scene: {scene} ({SCENE_NAMES[scene]})", flush=True)
    print(f"Country: {country}", flush=True)
    if flat_dir is not None:
        print(f"Output: {flat_dir} (flat, no subdirs)", flush=True)
    elif use_cc:
        print(f"Output: cc-video/ (Creative Commons)", flush=True)
    print(f"{'='*50}\n", flush=True)

    # Step 1: Get video info
    print("[1/4] Getting video info...", flush=True)
    info = get_video_info(video_id)
    if info:
        print(f"  Title: {info.get('title', 'N/A')}", flush=True)
        print(f"  Channel: {info.get('channel', 'N/A')}", flush=True)
        print(f"  Duration: {info.get('duration', 'N/A')}s", flush=True)
        print(f"  Views: {info.get('views', 'N/A')}", flush=True)

    # Step 2: Download subtitle
    print("\n[2/4] Downloading subtitle...", flush=True)
    sub_path = download_subtitle(video_id, flat_dir=flat_dir)
    if not sub_path:
        print("\nNo subtitle available. Cannot proceed with analysis.", flush=True)
        sys.exit(1)

    # Step 3: Download thumbnail
    print(f"\n[3/4] Downloading thumbnail...", flush=True)
    thumb_path = download_thumbnail(video_id, scene, output_base=output_base, flat_dir=flat_dir)

    # Step 4: Download video (optional)
    if do_download:
        print(f"\n[4/4] Downloading video...", flush=True)
        download_video(video_id, scene, output_base=output_base, flat_dir=flat_dir)
    else:
        vid_dir = flat_dir if flat_dir is not None else output_base / scene / video_id
        vid_dir.mkdir(parents=True, exist_ok=True)
        print(f"\n[4/4] Video download skipped (use --download-video to download)", flush=True)

    # Summary
    vid_dir = flat_dir if flat_dir is not None else output_base / scene / video_id
    analysis_path = vid_dir / f"{video_id}.analysis.json"
    print(f"\n{'='*50}", flush=True)
    print(f"Done! Subtitle ready at: {sub_path}", flush=True)
    if thumb_path:
        print(f"Thumbnail: {thumb_path}", flush=True)
    print(f"Analysis output dir: {vid_dir}/", flush=True)

    if analysis_path.exists():
        print(f"Analysis file already exists: {analysis_path}", flush=True)
    else:
        print(f"\nTo generate analysis, ask Claude Code:", flush=True)
        print(f'  "分析 {video_id} 的字幕，场景 {scene}，国家 {country}"', flush=True)
        print(f"\nOr use the skill directly:", flush=True)
        print(f"  /analyze-subtitles {sub_path} {SCENE_NAMES[scene]} {country}", flush=True)


if __name__ == "__main__":
    main()
