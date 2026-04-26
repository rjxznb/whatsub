"""Batch download thumbnails for all existing videos in data/videos/."""

import os
import sys
import time
from pathlib import Path

from config import VIDEOS_DIR
from process_single import download_thumbnail

def main():
    """Scan all video directories and download missing thumbnails."""
    total = 0
    skipped = 0
    downloaded = 0
    failed = 0

    # Walk through all scene/video_id directories
    for scene_dir in sorted(VIDEOS_DIR.iterdir()):
        if not scene_dir.is_dir():
            continue
        scene = scene_dir.name
        for vid_dir in sorted(scene_dir.iterdir()):
            if not vid_dir.is_dir():
                continue
            video_id = vid_dir.name
            total += 1
            thumb_path = vid_dir / f"{video_id}.jpg"

            if thumb_path.exists() and thumb_path.stat().st_size > 0:
                skipped += 1
                continue

            print(f"\n[{total}] {scene}/{video_id}", flush=True)
            result = download_thumbnail(video_id, scene)
            if result:
                downloaded += 1
            else:
                failed += 1
            # Small delay to avoid rate limiting
            time.sleep(0.5)

    print(f"\n{'='*50}", flush=True)
    print(f"Total videos: {total}", flush=True)
    print(f"Already had thumbnail: {skipped}", flush=True)
    print(f"Downloaded: {downloaded}", flush=True)
    print(f"Failed: {failed}", flush=True)


if __name__ == "__main__":
    main()
