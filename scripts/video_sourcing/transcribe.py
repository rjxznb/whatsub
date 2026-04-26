"""Step 3: Subtitle retrieval (yt-dlp + cookies) + Whisper GPU fallback.

Strategy:
1. yt-dlp with cookies.txt to download YouTube auto/manual subs (concurrent)
2. faster-whisper GPU for the few without any YouTube transcript
3. Full checkpoint/resume support
"""

import json
import subprocess
import os
import time
import glob as glob_mod
from concurrent.futures import ThreadPoolExecutor, as_completed

from config import VIDEOS_DIR, SUBTITLES_DIR, AUDIO_DIR, SCENE_NAMES, COOKIES_FILE
from config import WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE

SUBTITLE_WORKERS = 4
AUDIO_DELAY = 5
CHECKPOINT_PATH = VIDEOS_DIR / "transcribe_checkpoint.json"

_cookies_args = ["--cookies", str(COOKIES_FILE)] if COOKIES_FILE.exists() else []


# ── yt-dlp subtitle download ──

def get_youtube_subtitles(video_id):
    """Download YouTube subs via yt-dlp with cookies. Return (segments, source) or (None, None)."""
    # Check cached
    pattern = str(SUBTITLES_DIR / f"{video_id}*.vtt")
    existing = glob_mod.glob(pattern)
    if existing:
        segments = parse_vtt(existing[0])
        if segments:
            return segments, "cached"

    output_template = str(SUBTITLES_DIR / video_id)

    try:
        subprocess.run(
            [
                "yt-dlp", *_cookies_args,
                "--write-sub", "--write-auto-sub",
                "--sub-lang", "en",
                "--sub-format", "vtt",
                "--skip-download",
                "--no-overwrites",
                "--no-warnings",
                "--output", output_template,
                f"https://www.youtube.com/watch?v={video_id}",
            ],
            capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return None, None

    vtt_files = sorted(glob_mod.glob(pattern))
    if not vtt_files:
        return None, None

    segments = parse_vtt(vtt_files[0])
    if segments:
        # Detect manual vs auto
        source = "manual" if any(f.endswith(f"{video_id}.en.vtt") for f in vtt_files) else "auto"
        return segments, source
    return None, None


def parse_vtt(vtt_path):
    """Parse VTT into segments list."""
    import webvtt
    try:
        segments = []
        for caption in webvtt.read(vtt_path):
            text = caption.text.strip()
            if not text:
                continue
            segments.append({
                "start": _ts_to_seconds(caption.start),
                "end": _ts_to_seconds(caption.end),
                "text": text,
            })
    except Exception:
        return []

    # Deduplicate consecutive identical text (common in auto-subs)
    deduped = []
    for seg in segments:
        if deduped and seg["text"] == deduped[-1]["text"]:
            deduped[-1]["end"] = seg["end"]
        else:
            deduped.append(seg)
    return deduped


def _ts_to_seconds(ts):
    parts = ts.split(":")
    h, m = int(parts[0]), int(parts[1])
    s = float(parts[2])
    return round(h * 3600 + m * 60 + s, 2)


# ── Concurrent subtitle worker ──

def _sub_worker(video_id):
    return video_id, *get_youtube_subtitles(video_id)


# ── Audio download + Whisper ──

def download_audio(video_id):
    output_path = str(AUDIO_DIR / f"{video_id}.mp3")
    if os.path.exists(output_path):
        return output_path

    output_template = str(AUDIO_DIR / f"{video_id}.%(ext)s")
    try:
        subprocess.run(
            [
                "yt-dlp", *_cookies_args,
                "--extract-audio",
                "--audio-format", "mp3",
                "--audio-quality", "5",
                "--no-warnings",
                "--output", output_template,
                f"https://www.youtube.com/watch?v={video_id}",
            ],
            capture_output=True, text=True, timeout=180,
        )
    except subprocess.TimeoutExpired:
        return None

    return output_path if os.path.exists(output_path) else None


_whisper_model = None

def _get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        print(f"Loading faster-whisper '{WHISPER_MODEL}' on {WHISPER_DEVICE}...", flush=True)
        _whisper_model = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)
    return _whisper_model


def transcribe_with_whisper(audio_path):
    model = _get_whisper_model()
    segs, _ = model.transcribe(audio_path, language="en", beam_size=5)
    return [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segs]


# ── Checkpoint ──

def load_checkpoint():
    if CHECKPOINT_PATH.exists():
        with open(CHECKPOINT_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_checkpoint(data):
    with open(CHECKPOINT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


# ── Main ──

def transcribe_all():
    with open(VIDEOS_DIR / "filtered_results.json", "r", encoding="utf-8") as f:
        filtered = json.load(f)

    completed = load_checkpoint()
    print(f"Cookies: {'YES' if _cookies_args else 'NO'}", flush=True)
    print(f"Checkpoint: {len(completed)} videos already done", flush=True)

    all_videos = []
    for scene, videos in filtered.items():
        for v in videos:
            v["_scene"] = scene
            all_videos.append(v)

    todo = [v for v in all_videos if v["video_id"] not in completed]
    print(f"Total: {len(all_videos)}, Todo: {len(todo)}\n", flush=True)

    if not todo:
        print("All done!", flush=True)
    else:
        # ── Phase 1: yt-dlp subtitles with cookies (concurrent) ──
        print(f"--- Phase 1: yt-dlp subtitles ({len(todo)} videos, {SUBTITLE_WORKERS} workers) ---", flush=True)
        need_whisper = []

        with ThreadPoolExecutor(max_workers=SUBTITLE_WORKERS) as executor:
            futures = {executor.submit(_sub_worker, v["video_id"]): v for v in todo}
            done_count = 0

            for future in as_completed(futures):
                v = futures[future]
                vid = v["video_id"]
                done_count += 1

                try:
                    _, segments, source = future.result()
                except Exception:
                    segments, source = None, None

                if segments:
                    completed[vid] = {
                        "subtitles": segments,
                        "subtitle_source": source,
                        "full_text": " ".join(s["text"] for s in segments),
                    }
                else:
                    need_whisper.append(v)

                if done_count % 20 == 0 or done_count == len(futures):
                    got = done_count - len(need_whisper)
                    print(f"  [{done_count}/{len(futures)}] Subs: {got} | Need Whisper: {len(need_whisper)}", flush=True)

                if done_count % 50 == 0:
                    save_checkpoint(completed)

        save_checkpoint(completed)
        got_subs = len(todo) - len(need_whisper)
        print(f"\nPhase 1 done. Got subs: {got_subs}, Need Whisper: {len(need_whisper)}", flush=True)

        # ── Phase 2: Whisper for remaining ──
        if need_whisper:
            print(f"\n--- Phase 2: Whisper ({len(need_whisper)} videos, {AUDIO_DELAY}s delay) ---", flush=True)

            for i, v in enumerate(need_whisper):
                vid = v["video_id"]
                print(f"  [{i+1}/{len(need_whisper)}] {vid}: {v['title'][:50]}...", flush=True)

                audio = download_audio(vid)
                if audio:
                    try:
                        segments = transcribe_with_whisper(audio)
                        completed[vid] = {
                            "subtitles": segments,
                            "subtitle_source": "whisper",
                            "full_text": " ".join(s["text"] for s in segments),
                        }
                        print(f"    -> Whisper OK ({len(segments)} segs)", flush=True)
                    except Exception as e:
                        print(f"    -> Whisper error: {e}", flush=True)
                else:
                    print(f"    -> Audio failed (skip)", flush=True)

                if (i + 1) % 5 == 0:
                    save_checkpoint(completed)
                time.sleep(AUDIO_DELAY)

            save_checkpoint(completed)

    # ── Assemble final results ──
    results = {}
    stats = {"cached": 0, "manual": 0, "auto": 0, "whisper": 0, "failed": 0}

    for v in all_videos:
        vid = v["video_id"]
        scene = v.pop("_scene", v.get("scene", "unknown"))
        sub_data = completed.get(vid)

        if not sub_data or not sub_data.get("subtitles"):
            stats["failed"] += 1
            continue

        src = sub_data["subtitle_source"]
        stats[src] = stats.get(src, 0) + 1

        v["subtitles"] = sub_data["subtitles"]
        v["subtitle_source"] = sub_data["subtitle_source"]
        v["full_text"] = sub_data["full_text"]

        results.setdefault(scene, []).append(v)

    output_path = VIDEOS_DIR / "transcribed_results.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    total = sum(len(v) for v in results.values())
    print(f"\nDone. {total}/{len(all_videos)} videos with transcripts.", flush=True)
    print(f"Stats: {json.dumps(stats)}", flush=True)
    for scene in SCENE_NAMES:
        print(f"  {SCENE_NAMES[scene]}: {len(results.get(scene, []))}", flush=True)

    if CHECKPOINT_PATH.exists() and total > 0:
        CHECKPOINT_PATH.unlink()

    return results


if __name__ == "__main__":
    transcribe_all()
