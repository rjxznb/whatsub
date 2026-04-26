"""Batch offset detection + VTT trimming for all dining cut videos."""
import os, sys, json, re, subprocess
from pathlib import Path
from difflib import SequenceMatcher

BASE = Path(r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\dining")
FFPROBE = r"C:\Users\renjx\Desktop\ASR\ffmpeg\bin\ffprobe.exe"
FFMPEG = r"C:\Users\renjx\Desktop\ASR\ffmpeg\bin\ffmpeg.exe"

# Videos with VTTs and their cut files
VIDEOS = {
    "4r7mrHPYhoU": ["cut_part1.mp4", "cut_part2.mp4"],
    "95YZZNyMHwk": ["cut_95YZZNyMHwk.mp4"],
    "fpJL53G93lQ": ["cut_part1.mp4", "cut_part2.mp4"],
    "h9h7X0t6kHg": ["cut_h9h7X0t6kHg.mp4"],
    "OM21Lbay5s0": ["cut_OM21Lbay5s0.mp4"],
    "qcF8V404scU": ["cut_qcF8V404scU.mp4"],
    "z-dsHjf6voQ": ["cut_z-dsHjf6voQ.mp4"],
}


def get_duration(mp4_path):
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", str(mp4_path)], capture_output=True)
    return float(r.stdout.decode().strip())


def parse_vtt(vtt_path):
    """Parse clean VTT into list of (start_sec, end_sec, text)."""
    cues = []
    with open(vtt_path, "r", encoding="utf-8") as f:
        content = f.read()
    pattern = re.compile(r"(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\s*\n(.+?)(?=\n\n|\n\d{2}:\d{2}|\Z)", re.DOTALL)
    for m in pattern.finditer(content):
        s = ts_to_sec(m.group(1))
        e = ts_to_sec(m.group(2))
        text = m.group(3).strip().replace("\n", " ")
        if text and text not in ("[Music]", "[Applause]", "foreign"):
            cues.append((s, e, text))
    return cues


def ts_to_sec(ts):
    parts = ts.replace(",", ".").split(":")
    return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])


def sec_to_ts(sec):
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def whisper_first_20s(mp4_path):
    """Run Whisper on first 20s and return transcribed text."""
    tmp_wav = str(mp4_path).replace(".mp4", "_tmp20s.wav")
    subprocess.run([FFMPEG, "-y", "-i", str(mp4_path), "-t", "20", "-ar", "16000",
                    "-ac", "1", "-f", "wav", tmp_wav],
                   capture_output=True)

    import faster_whisper
    model = whisper_first_20s._model
    segments, _ = model.transcribe(tmp_wav, language="en", beam_size=5)
    text = " ".join(s.text.strip() for s in segments)

    os.remove(tmp_wav)
    return text.lower()

# lazy load model
whisper_first_20s._model = None


def find_offset(whisper_text, cues):
    """Find the VTT offset by matching whisper text against cue texts."""
    whisper_clean = whisper_text.lower().strip()
    if not whisper_clean:
        return 0.0, 0.0  # no speech detected

    best_ratio = 0
    best_offset = 0

    # Try matching against windows of concatenated cues
    all_texts = [(c[0], c[2].lower()) for c in cues]

    for i in range(len(all_texts)):
        concat = ""
        for j in range(i, min(i + 8, len(all_texts))):
            concat += " " + all_texts[j][1]
            concat = concat.strip()
            ratio = SequenceMatcher(None, whisper_clean[:len(concat) + 50], concat[:len(whisper_clean) + 50]).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_offset = all_texts[i][0]

    return best_offset, best_ratio


def trim_vtt(cues, offset, duration, output_path):
    """Trim cues to [offset, offset+duration] and write clean VTT."""
    end_time = offset + duration
    trimmed = []
    for s, e, text in cues:
        if s >= offset and s < end_time:
            trimmed.append((s - offset, min(e, end_time) - offset, text))

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        for s, e, text in trimmed:
            f.write(f"{sec_to_ts(s)} --> {sec_to_ts(e)}\n{text}\n\n")

    return len(trimmed)


def main():
    # Load Whisper model once
    print("Loading Whisper model...", flush=True)
    import faster_whisper
    whisper_first_20s._model = faster_whisper.WhisperModel("large-v3", device="cuda", compute_type="float16")
    print("Model loaded.", flush=True)

    results = []

    for vid, cuts in VIDEOS.items():
        vtt_path = BASE / vid / f"{vid}.en.clean.vtt"
        if not vtt_path.exists():
            print(f"SKIP {vid}: no clean VTT", flush=True)
            continue

        cues = parse_vtt(vtt_path)
        print(f"\n{'='*60}", flush=True)
        print(f"Video: {vid} ({len(cues)} cues in clean VTT)", flush=True)

        for cut_name in cuts:
            mp4_path = BASE / vid / cut_name
            if not mp4_path.exists():
                print(f"  SKIP {cut_name}: file not found", flush=True)
                continue

            duration = get_duration(mp4_path)
            print(f"\n  Cut: {cut_name} (duration={duration:.1f}s)", flush=True)

            # Whisper first 20s
            print(f"  Running Whisper...", flush=True)
            w_text = whisper_first_20s(mp4_path)
            print(f"  Whisper: {w_text[:100]}...", flush=True)

            # Find offset
            offset, ratio = find_offset(w_text, cues)
            print(f"  Offset: {offset:.3f}s (match ratio: {ratio:.3f})", flush=True)

            # Trim VTT
            out_name = cut_name.replace(".mp4", ".en.clean.vtt")
            out_path = BASE / vid / out_name
            n_cues = trim_vtt(cues, offset, duration, out_path)
            print(f"  Trimmed: {n_cues} cues -> {out_path.name}", flush=True)

            results.append({
                "video_id": vid,
                "cut": cut_name,
                "duration": round(duration, 3),
                "offset": round(offset, 3),
                "match_ratio": round(ratio, 3),
                "trimmed_cues": n_cues,
                "output": str(out_path)
            })

    print(f"\n{'='*60}", flush=True)
    print(f"SUMMARY: Processed {len(results)} cut files", flush=True)
    for r in results:
        flag = " ⚠️LOW" if r["match_ratio"] < 0.4 else ""
        print(f"  {r['video_id']}/{r['cut']}: offset={r['offset']}s, {r['trimmed_cues']} cues, ratio={r['match_ratio']}{flag}", flush=True)

    # Save results
    with open(BASE / "trim_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)


if __name__ == "__main__":
    main()
