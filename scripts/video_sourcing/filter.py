"""Step 2: Auto-filter candidates by duration, views, title keywords."""

import json
import isodate

from config import VIDEOS_DIR, FILTER_RULES, SCENE_NAMES


def parse_duration(iso_duration):
    """Convert ISO 8601 duration (PT5M30S) to seconds."""
    return int(isodate.parse_duration(iso_duration).total_seconds())


def filter_video(video):
    """Return (passed: bool, score: int, reason: str)."""
    title_lower = video["title"].lower()
    duration = parse_duration(video["duration"])

    # Hard exclusions
    if duration < FILTER_RULES["min_duration_seconds"]:
        return False, 0, "too_short"
    if duration > FILTER_RULES["max_duration_seconds"]:
        return False, 0, "too_long"
    if video["view_count"] < FILTER_RULES["min_views"]:
        return False, 0, "too_few_views"
    for kw in FILTER_RULES["exclude_title_keywords"]:
        if kw in title_lower:
            return False, 0, f"excluded_keyword: {kw}"

    # Scoring
    score = 0

    # Sweet-spot duration: 3-8 min
    if 180 <= duration <= 480:
        score += 3
    elif 120 <= duration <= 600:
        score += 1

    # Title preference keywords
    for kw in FILTER_RULES["prefer_title_keywords"]:
        if kw in title_lower:
            score += 2

    # View count: 观看量不重要，不作为评分因素
    # 文档原则："一个200播放量的视频如果拍到了真实对话，比50万播放的精致vlog更有价值"

    # Store parsed duration for later use
    video["duration_seconds"] = duration

    return True, score, "pass"


def filter_all():
    """Filter all raw search results."""
    input_path = VIDEOS_DIR / "raw_search_results.json"
    with open(input_path, "r", encoding="utf-8") as f:
        all_results = json.load(f)

    filtered = {}
    stats = {"total": 0, "passed": 0, "excluded": 0}

    for scene, videos in all_results.items():
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

        # Sort by score, keep top 20 per scene
        passed.sort(key=lambda x: x["filter_score"], reverse=True)
        filtered[scene] = passed[:20]
        print(f"[{SCENE_NAMES.get(scene, scene)}] {len(videos)} -> {len(filtered[scene])} after filter")

    output_path = VIDEOS_DIR / "filtered_results.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(filtered, f, indent=2, ensure_ascii=False)

    total_kept = sum(len(v) for v in filtered.values())
    print(f"\nTotal: {stats['total']} -> Passed: {stats['passed']} -> Kept (top 20/scene): {total_kept}")
    print(f"Excluded: {stats['excluded']}")
    return filtered


if __name__ == "__main__":
    filter_all()
