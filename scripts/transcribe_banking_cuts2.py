# -*- coding: utf-8 -*-
"""Batch Whisper transcription for all banking cut MP4 files (batch 2)."""
import sys, os, time, glob
sys.stdout.reconfigure(encoding='utf-8')

from faster_whisper import WhisperModel

BASE = r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\banking"

def find_cut_files():
    files = []
    for mp4 in glob.glob(os.path.join(BASE, "*", "cut_*.mp4")):
        files.append(mp4)
    files.sort()
    return files

def format_vtt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"

def transcribe_to_vtt(model, mp4_path):
    vtt_path = mp4_path.rsplit(".", 1)[0] + ".en.vtt"
    if os.path.exists(vtt_path):
        print(f"  SKIP (already exists): {os.path.basename(vtt_path)}", flush=True)
        return vtt_path
    print(f"  Transcribing: {os.path.basename(mp4_path)}...", flush=True)
    t0 = time.time()
    segments, info = model.transcribe(mp4_path, language="en", beam_size=5,
                                       vad_filter=True, vad_parameters=dict(min_silence_duration_ms=500))
    lines = ["WEBVTT\n"]
    seg_count = 0
    for seg in segments:
        seg_count += 1
        lines.append(f"\n{format_vtt_time(seg.start)} --> {format_vtt_time(seg.end)}")
        lines.append(seg.text.strip())
    with open(vtt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    elapsed = time.time() - t0
    print(f"  Done: {seg_count} segments in {elapsed:.1f}s -> {os.path.basename(vtt_path)}", flush=True)
    return vtt_path

def main():
    cut_files = find_cut_files()
    print(f"Found {len(cut_files)} cut files to transcribe:\n", flush=True)
    for f in cut_files:
        print(f"  {os.path.relpath(f, BASE)}", flush=True)
    print(flush=True)

    print("Loading faster-whisper large-v3 model (CUDA)...", flush=True)
    model = WhisperModel("large-v3", device="cuda", compute_type="float16")
    print("Model loaded.\n", flush=True)

    for i, mp4 in enumerate(cut_files, 1):
        print(f"[{i}/{len(cut_files)}] {os.path.relpath(mp4, BASE)}", flush=True)
        transcribe_to_vtt(model, mp4)
    print(f"\nAll done.", flush=True)

if __name__ == "__main__":
    main()
