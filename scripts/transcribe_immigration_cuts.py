# -*- coding: utf-8 -*-
"""Batch Whisper transcription for immigration cut MP4 files."""
import sys
import os
import time

from faster_whisper import WhisperModel

CUT_FILES = [
    r"C:\Users\renjx\Desktop\immigration\cut_part2.mp4",
    r"C:\Users\renjx\Desktop\immigration\cut_part3.mp4",
    r"C:\Users\renjx\Desktop\immigration\cut_rb9lS5PGKAg.mp4",
    r"C:\Users\renjx\Desktop\immigration\JjaCs2IKnZ0.mp4",
    r"C:\Users\renjx\Desktop\immigration\ljr2QMNPpAI.mp4",
]


def format_vtt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def transcribe_to_vtt(model, mp4_path):
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
