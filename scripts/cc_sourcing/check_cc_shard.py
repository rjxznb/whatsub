"""Check CC license for a shard of videos from raw_search_results.json.

Usage:
    python check_cc_shard.py SHARD_INDEX TOTAL_SHARDS

Example (5 parallel shards):
    python check_cc_shard.py 0 5
    python check_cc_shard.py 1 5
    python check_cc_shard.py 2 5
    python check_cc_shard.py 3 5
    python check_cc_shard.py 4 5

Output: data/cc-video/cc_shard_{index}.json
Merge with: python check_cc_shard.py --merge 5
"""

import json
import os
import subprocess
import sys
import time

# Import shared config from video_sourcing
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "video_sourcing"))
from config import CC_VIDEO_DIR, COOKIES_FILE, VIDEOS_DIR

YTDLP = r"C:\Users\renjx\anaconda3\envs\ASR\Scripts\yt-dlp.exe"
_cookies_args = ["--cookies", str(COOKIES_FILE)] if COOKIES_FILE.exists() else []
_js_args = ["--js-runtimes", "node"]

CC_LICENSE_KEYWORD = "creative commons"


def check_license(video_id):
    """Extract license field via yt-dlp."""
    try:
        result = subprocess.run(
            [YTDLP, *_js_args, *_cookies_args,
             "--dump-json", "--skip-download", "--no-warnings",
             f"https://www.youtube.com/watch?v={video_id}"],
            capture_output=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return None, "timeout"

    if result.returncode != 0:
        err = result.stderr.decode("utf-8", errors="replace")[:80]
        return None, f"error"

    try:
        data = json.loads(result.stdout.decode("utf-8", errors="replace"))
        lic = data.get("license") or ""
        return lic, "ok"
    except json.JSONDecodeError:
        return None, "json_error"


def run_shard(shard_idx, total_shards):
    """Check license for one shard of videos."""
    raw_file = VIDEOS_DIR / "raw_search_results.json"
    with open(raw_file, "r", encoding="utf-8") as f:
        raw = json.load(f)

    # Flatten all videos with scene info
    all_videos = []
    for scene, videos in raw.items():
        for v in videos:
            v["scene"] = scene
            all_videos.append(v)

    # Deduplicate by video_id
    seen = set()
    unique = []
    for v in all_videos:
        if v["video_id"] not in seen:
            seen.add(v["video_id"])
            unique.append(v)
    all_videos = unique

    # Take this shard's slice
    shard = [v for i, v in enumerate(all_videos) if i % total_shards == shard_idx]

    shard_file = CC_VIDEO_DIR / f"cc_shard_{shard_idx}.json"

    # Load existing progress for this shard
    existing = {}
    if shard_file.exists():
        with open(shard_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            for vid_id, info in data.get("checked", {}).items():
                existing[vid_id] = info

    print(f"Shard {shard_idx}/{total_shards}: {len(shard)} videos "
          f"({len(existing)} already checked)", flush=True)

    checked = dict(existing)
    cc_found = []
    errors = 0
    max_consecutive_errors = 20

    for i, v in enumerate(shard, 1):
        vid = v["video_id"]

        # Skip already checked
        if vid in checked:
            if checked[vid].get("is_cc"):
                cc_found.append(checked[vid])
            continue

        title = v.get("title", "")[:35]
        scene = v["scene"]
        print(f"  [{i}/{len(shard)}] {vid} {title}...", end="", flush=True)

        lic, status = check_license(vid)

        if status != "ok":
            errors += 1
            checked[vid] = {"is_cc": False, "status": status}
            print(f" SKIP ({status})", flush=True)
            if errors >= max_consecutive_errors:
                print(f"\n  {max_consecutive_errors} consecutive errors. Saving & stopping.", flush=True)
                break
            time.sleep(1)
            continue
        else:
            errors = 0

        is_cc = CC_LICENSE_KEYWORD in (lic or "").lower()
        entry = {
            "video_id": vid,
            "title": v.get("title", ""),
            "scene": scene,
            "channel": v.get("channel", ""),
            "view_count": v.get("view_count", 0),
            "duration": v.get("duration", 0),
            "license": lic,
            "is_cc": is_cc,
        }
        checked[vid] = entry

        if is_cc:
            cc_found.append(entry)
            print(f" CC! ({lic})", flush=True)
        else:
            print(f" standard", flush=True)

        # Save every 10 videos
        if i % 10 == 0:
            with open(shard_file, "w", encoding="utf-8") as f:
                json.dump({"checked": checked, "cc_videos": cc_found}, f,
                          ensure_ascii=False, indent=2)

        time.sleep(1.5)

    # Final save
    with open(shard_file, "w", encoding="utf-8") as f:
        json.dump({"checked": checked, "cc_videos": cc_found}, f,
                  ensure_ascii=False, indent=2)

    print(f"\nShard {shard_idx} done: checked {len(checked)}, "
          f"CC found: {len(cc_found)}", flush=True)
    print(f"Saved to: {shard_file}", flush=True)


def merge_shards(total_shards):
    """Merge all shard results into cc_search_results.json."""
    all_cc = {}
    total_checked = 0
    total_cc = 0

    for i in range(total_shards):
        shard_file = CC_VIDEO_DIR / f"cc_shard_{i}.json"
        if not shard_file.exists():
            print(f"Warning: shard {i} not found", flush=True)
            continue
        with open(shard_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        total_checked += len(data.get("checked", {}))
        for v in data.get("cc_videos", []):
            scene = v.get("scene", "unknown")
            if scene not in all_cc:
                all_cc[scene] = []
            all_cc[scene].append(v)
            total_cc += 1

    results_file = CC_VIDEO_DIR / "cc_search_results.json"
    with open(results_file, "w", encoding="utf-8") as f:
        json.dump(all_cc, f, ensure_ascii=False, indent=2)

    print(f"Merged {total_shards} shards:", flush=True)
    print(f"  Total checked: {total_checked}", flush=True)
    print(f"  Total CC videos: {total_cc}", flush=True)
    for scene, vids in sorted(all_cc.items()):
        print(f"    {scene}: {len(vids)}", flush=True)
    print(f"  Saved to: {results_file}", flush=True)


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--merge":
        merge_shards(int(sys.argv[2]))
        return

    if len(sys.argv) < 3:
        print("Usage:", flush=True)
        print("  python check_cc_shard.py SHARD_INDEX TOTAL_SHARDS", flush=True)
        print("  python check_cc_shard.py --merge TOTAL_SHARDS", flush=True)
        sys.exit(1)

    shard_idx = int(sys.argv[1])
    total_shards = int(sys.argv[2])
    run_shard(shard_idx, total_shards)


if __name__ == "__main__":
    main()
