"""Step 2: Filter CC search results by duration, title keywords, and score.

CC videos skip min_views (CC content is rare, small channels are fine).
Keeps top 30 per scene (more generous than standard pipeline's 20).

Usage:
    python filter_cc.py
    python filter_cc.py --top 20           # Keep top 20 per scene instead of 30
    python filter_cc.py --scenes medical   # Filter specific scenes only
"""

import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "video_sourcing"))
from config import CC_VIDEO_DIR, FILTER_RULES, SCENE_NAMES

RESULTS_FILE = CC_VIDEO_DIR / "cc_search_results.json"
OUTPUT_FILE = CC_VIDEO_DIR / "cc_filtered_results.json"

TOP_PER_SCENE = 30  # More generous than standard (20) since CC is rarer


def filter_video(video):
    """Return (passed: bool, score: int, reason: str).

    Skips min_views check — CC content is rare.
    """
    title_lower = video.get("title", "").lower()
    duration = video.get("duration") or 0

    # Hard exclusions: duration
    if duration > 0:
        if duration < FILTER_RULES["min_duration_seconds"]:
            return False, 0, "too_short"
        if duration > FILTER_RULES["max_duration_seconds"]:
            return False, 0, "too_long"

    # Hard exclusions: title keywords
    for kw in FILTER_RULES["exclude_title_keywords"]:
        if kw in title_lower:
            return False, 0, f"excluded_keyword: {kw}"

    # Scoring
    score = 0

    # Sweet-spot duration: 3-8 min
    if duration > 0:
        if 180 <= duration <= 480:
            score += 3
        elif 120 <= duration <= 600:
            score += 1

    # Title preference keywords
    for kw in FILTER_RULES["prefer_title_keywords"]:
        if kw in title_lower:
            score += 2

    return True, score, "pass"


def filter_all(scenes=None, top_n=TOP_PER_SCENE):
    """Filter all CC search results."""
    with open(RESULTS_FILE, "r", encoding="utf-8") as f:
        all_results = json.load(f)

    filtered = {}
    stats = {"total": 0, "passed": 0, "excluded": 0}

    for scene, videos in all_results.items():
        if scenes and scene not in scenes:
            continue

        passed = []
        for v in videos:
            ok, score, reason = filter_video(v)
            stats["total"] += 1
            if ok:
                v["filter_score"] = score
                passed.append(v)
                stats["passed"] += 1
            else:
                stats["excluded"] += 1

        # Sort by score, keep top N per scene
        passed.sort(key=lambda x: x["filter_score"], reverse=True)
        filtered[scene] = passed[:top_n]
        print(f"[{SCENE_NAMES.get(scene, scene)}] {len(videos)} -> {len(filtered[scene])} "
              f"after filter (top {top_n})", flush=True)

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(filtered, f, indent=2, ensure_ascii=False)

    total_kept = sum(len(v) for v in filtered.values())
    print(f"\nTotal: {stats['total']} -> Passed: {stats['passed']} "
          f"-> Kept (top {top_n}/scene): {total_kept}", flush=True)
    print(f"Excluded: {stats['excluded']}", flush=True)
    print(f"Output: {OUTPUT_FILE}", flush=True)
    return filtered


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Filter CC search results")
    parser.add_argument("--scenes", nargs="+", help="Specific scenes only")
    parser.add_argument("--top", type=int, default=TOP_PER_SCENE,
                        help=f"Top N per scene (default: {TOP_PER_SCENE})")
    args = parser.parse_args()
    filter_all(scenes=args.scenes, top_n=args.top)
