"""Step 3: Subtitle retrieval for CC videos (yt-dlp + Whisper GPU fallback).

Reads cc_filtered_results.json, downloads subtitles, outputs cc_transcribed_results.json.
Subtitles are saved to data/cc-video/{scene}/{video_id}/{video_id}.en.vtt.

Usage:
    python transcribe_cc.py
    python transcribe_cc.py --scenes medical dining
"""

import json
import os
import subprocess
import sys
import time
import glob as glob_mod
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "video_sourcing"))
from config import (
    CC_VIDEO_DIR, COOKIES_FILE, SCENE_NAMES,
    WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE,
)

YTDLP = r"C:\Users\renjx\anaconda3\envs\ASR\Scripts\yt-dlp.exe"
_cookies_args = ["--cookies", str(COOKIES_FILE)] if COOKIES_FILE.exists() else []
_js_args = ["--js-runtimes", "node"]

FILTERED_FILE = CC_VIDEO_DIR / "cc_filtered_results.json"
OUTPUT_FILE = CC_VIDEO_DIR / "cc_transcribed_results.json"
CHECKPOINT_PATH = CC_VIDEO_DIR / "cc_transcribe_checkpoint.json"

SUBTITLE_WORKERS = 4
AUDIO_DELAY = 5


# ── VTT parsing ──

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


# ── yt-dlp subtitle download ──

def get_subtitles(video_id, scene):
    """Download subtitles via yt-dlp. Save to cc-video/{scene}/{video_id}/."""
    vid_dir = CC_VIDEO_DIR / scene / video_id
    vid_dir.mkdir(parents=True, exist_ok=True)
    sub_path = vid_dir / f"{video_id}.en.vtt"

    # Check cached
    if sub_path.exists() and sub_path.stat().st_size > 0:
        segments = parse_vtt(str(sub_path))
        if segments:
            return segments, "cached"

    # Try manual subs first, then auto-subs
    for sub_args in [
        ["--write-sub", "--sub-lang", "en"],
        ["--write-auto-sub", "--sub-lang", "en"],
    ]:
        try:
            subprocess.run(
                [YTDLP, *_js_args, *_cookies_args,
                 *sub_args, "--sub-format", "vtt",
                 "--skip-download", "--no-warnings",
                 "-o", str(vid_dir / f"{video_id}.%(ext)s"),
                 f"https://www.youtube.com/watch?v={video_id}"],
                capture_output=True, timeout=120,
            )
        except subprocess.TimeoutExpired:
            pass

        if sub_path.exists() and sub_path.stat().st_size > 0:
            segments = parse_vtt(str(sub_path))
            if segments:
                source = "manual" if "--write-sub" in sub_args else "auto"
                return segments, source

    return None, None


def _sub_worker(args):
    video_id, scene = args
    segments, source = get_subtitles(video_id, scene)
    return video_id, segments, source


# ── Audio download + Whisper ──

def download_audio(video_id, scene):
    """Download audio for Whisper transcription."""
    vid_dir = CC_VIDEO_DIR / scene / video_id
    vid_dir.mkdir(parents=True, exist_ok=True)
    output_path = str(vid_dir / f"{video_id}.mp3")

    if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
        return output_path

    try:
        subprocess.run(
            [YTDLP, *_js_args, *_cookies_args,
             "--extract-audio", "--audio-format", "mp3",
             "--audio-quality", "5", "--no-warnings",
             "--output", str(vid_dir / f"{video_id}.%(ext)s"),
             f"https://www.youtube.com/watch?v={video_id}"],
            capture_output=True, timeout=180,
        )
    except subprocess.TimeoutExpired:
        return None

    return output_path if os.path.exists(output_path) and os.path.getsize(output_path) > 0 else None


_whisper_model = None

def _get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        print(f"Loading faster-whisper '{WHISPER_MODEL}' on {WHISPER_DEVICE}...", flush=True)
        _whisper_model = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE,
                                       compute_type=WHISPER_COMPUTE_TYPE)
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

def transcribe_all(scenes=None):
    with open(FILTERED_FILE, "r", encoding="utf-8") as f:
        filtered = json.load(f)

    completed = load_checkpoint()
    print(f"Cookies: {'YES' if _cookies_args else 'NO'}", flush=True)
    print(f"Checkpoint: {len(completed)} videos already done", flush=True)

    all_videos = []
    for scene, videos in filtered.items():
        if scenes and scene not in scenes:
            continue
        for v in videos:
            v["_scene"] = scene
            all_videos.append(v)

    todo = [v for v in all_videos if v["video_id"] not in completed]
    print(f"Total: {len(all_videos)}, Todo: {len(todo)}\n", flush=True)

    if not todo:
        print("All done!", flush=True)
    else:
        # ── Phase 1: yt-dlp subtitles (concurrent) ──
        print(f"--- Phase 1: yt-dlp subtitles ({len(todo)} videos, "
              f"{SUBTITLE_WORKERS} workers) ---", flush=True)
        need_whisper = []

        with ThreadPoolExecutor(max_workers=SUBTITLE_WORKERS) as executor:
            futures = {
                executor.submit(_sub_worker, (v["video_id"], v["_scene"])): v
                for v in todo
            }
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
                    print(f"  [{done_count}/{len(futures)}] Subs: {got} | "
                          f"Need Whisper: {len(need_whisper)}", flush=True)

                if done_count % 50 == 0:
                    save_checkpoint(completed)

        save_checkpoint(completed)
        got_subs = len(todo) - len(need_whisper)
        print(f"\nPhase 1 done. Got subs: {got_subs}, "
              f"Need Whisper: {len(need_whisper)}", flush=True)

        # ── Phase 2: Whisper for remaining ──
        if need_whisper:
            print(f"\n--- Phase 2: Whisper ({len(need_whisper)} videos, "
                  f"{AUDIO_DELAY}s delay) ---", flush=True)

            for i, v in enumerate(need_whisper):
                vid = v["video_id"]
                scene = v["_scene"]
                print(f"  [{i+1}/{len(need_whisper)}] {vid}: "
                      f"{v.get('title', '')[:50]}...", flush=True)

                audio = download_audio(vid, scene)
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

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    total = sum(len(v) for v in results.values())
    print(f"\nDone. {total}/{len(all_videos)} videos with transcripts.", flush=True)
    print(f"Stats: {json.dumps(stats)}", flush=True)
    for scene in SCENE_NAMES:
        if scene in results:
            print(f"  {SCENE_NAMES[scene]}: {len(results[scene])}", flush=True)
    print(f"Output: {OUTPUT_FILE}", flush=True)

    if CHECKPOINT_PATH.exists() and total > 0:
        CHECKPOINT_PATH.unlink()

    return results


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Download subtitles for filtered CC videos")
    parser.add_argument("--scenes", nargs="+", help="Specific scenes only")
    args = parser.parse_args()
    transcribe_all(scenes=args.scenes)
