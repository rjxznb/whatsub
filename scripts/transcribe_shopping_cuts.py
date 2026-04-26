# -*- coding: utf-8 -*-
"""Batch Whisper transcription for all shopping cut MP4 files."""
import sys
import os
import time

# Add parent for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "video_sourcing"))

from faster_whisper import WhisperModel

CUT_FILES = [
    r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\shopping\EvvEAg2ODCs\cut_EvvEAg2ODCs.mp4",
    r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\shopping\FwqgPhtR8C0\cut_part1_cooking.mp4",
    r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\shopping\FwqgPhtR8C0\cut_part2_makeup-1.mp4",
    r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\shopping\FwqgPhtR8C0\cut_part3_makeup-1.mp4",
    r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\shopping\FwqgPhtR8C0\cut_part4_cooking-1.mp4",
    r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\shopping\pAC_BHLaNDk\cut_part1_exercise-1.mp4",
    r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\shopping\pAC_BHLaNDk\cut_part2_shppping.mp4",
    r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\shopping\pAC_BHLaNDk\cut_part3_trip.mp4",
    r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\shopping\pVO8P4TKXJY\cut_pVO8P4TKXJY.mp4",
    r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\shopping\rui0QIorHbE\cut_rui0QIorHbE.mp4",
    r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\shopping\s_TAZs0U3_g\cut_s_TAZs0U3_g.mp4",
]


def format_vtt_time(seconds):
    """Convert seconds to VTT timestamp format HH:MM:SS.mmm"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def transcribe_to_vtt(model, mp4_path):
    """Transcribe an MP4 file and write a VTT subtitle file."""
    vtt_path = mp4_path.rsplit(".", 1)[0] + ".en.vtt"
    if os.path.exists(vtt_path):
        print(f"  SKIP (already exists): {vtt_path}", flush=True)
        return vtt_path

    print(f"  Transcribing: {os.path.basename(mp4_path)}...", flush=True)
    t0 = time.time()

    segments, info = model.transcribe(
        mp4_path,
        language="en",
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
    )

    lines = ["WEBVTT\n"]
    seg_count = 0
    for seg in segments:
        seg_count += 1
        start = format_vtt_time(seg.start)
        end = format_vtt_time(seg.end)
        lines.append(f"\n{start} --> {end}")
        lines.append(seg.text.strip())

    with open(vtt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    elapsed = time.time() - t0
    print(f"  Done: {seg_count} segments in {elapsed:.1f}s -> {os.path.basename(vtt_path)}", flush=True)
    return vtt_path


def main():
    print("Loading faster-whisper large-v3 model (CUDA)...", flush=True)
    model = WhisperModel("large-v3", device="cuda", compute_type="float16")
    print("Model loaded.\n", flush=True)

    results = []
    for i, mp4 in enumerate(CUT_FILES, 1):
        print(f"[{i}/{len(CUT_FILES)}] {os.path.basename(mp4)}", flush=True)
        if not os.path.exists(mp4):
            print(f"  NOT FOUND, skipping.", flush=True)
            continue
        vtt = transcribe_to_vtt(model, mp4)
        results.append(vtt)

    print(f"\nAll done. {len(results)} VTT files generated.", flush=True)


if __name__ == "__main__":
    main()
