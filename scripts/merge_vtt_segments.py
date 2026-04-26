# -*- coding: utf-8 -*-
"""Merge short VTT segments into ~10s chunks (post-processing for whisper output)."""
import re, sys, os, glob
from pathlib import Path

def parse_timestamp(ts):
    parts = ts.strip().split(":")
    if len(parts) == 3:
        h, m, s = parts
    elif len(parts) == 2:
        h = "0"; m, s = parts
    else:
        return 0.0
    s = s.replace(",", ".")
    return int(h) * 3600 + int(m) * 60 + float(s)

def format_timestamp(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"

def merge_vtt(vtt_text, max_segment=10.0, merge_gap=1.5):
    cue_pattern = re.compile(
        r"(\d{2}:\d{2}:\d{2}[\.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[\.,]\d{3})[^\n]*\n"
        r"(.*?)(?=\n\n|\n\d{2}:\d{2}|\Z)",
        re.DOTALL
    )
    cues = []
    for match in cue_pattern.finditer(vtt_text):
        start = parse_timestamp(match.group(1))
        end = parse_timestamp(match.group(2))
        text = match.group(3).strip().replace("\n", " ")
        text = re.sub(r"<[^>]+>", "", text).strip()
        text = re.sub(r"\s+", " ", text)
        if text:
            cues.append((start, end, text))
    if not cues:
        return vtt_text

    # Merge into ~10s segments
    segments = []
    seg_start, seg_end, seg_texts = cues[0][0], cues[0][1], [cues[0][2]]
    for i in range(1, len(cues)):
        cs, ce, ct = cues[i]
        gap = cs - seg_end
        duration = ce - seg_start
        if gap > merge_gap or duration > max_segment:
            segments.append((seg_start, seg_end, " ".join(seg_texts)))
            seg_start, seg_end, seg_texts = cs, ce, [ct]
        else:
            seg_end = ce
            seg_texts.append(ct)
    segments.append((seg_start, seg_end, " ".join(seg_texts)))

    # Hard-split segments > 13s
    split = []
    for start, end, text in segments:
        dur = end - start
        if dur <= max_segment * 1.3:
            split.append((start, end, text))
            continue
        words = text.split()
        n = max(2, int(dur / max_segment + 0.5))
        wpn = max(1, len(words) // n)
        pdur = dur / n
        for p in range(n):
            ps = start + p * pdur
            pe = start + (p + 1) * pdur
            ws = p * wpn
            we = (p + 1) * wpn if p < n - 1 else len(words)
            pt = " ".join(words[ws:we])
            if pt:
                split.append((ps, pe, pt))
    segments = split

    lines = ["WEBVTT", "Kind: captions", "Language: en", ""]
    for start, end, text in segments:
        lines.append(f"{format_timestamp(start)} --> {format_timestamp(end)}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)

def main():
    if len(sys.argv) < 2:
        print("Usage: python merge_vtt_segments.py <dir_or_file>")
        return
    target = sys.argv[1]
    if os.path.isdir(target):
        files = list(Path(target).rglob("cut_*.clean.vtt"))
    else:
        files = [Path(target)]

    for f in sorted(files):
        with open(f, "r", encoding="utf-8") as fh:
            text = fh.read()
        cue_count_before = len(re.findall(r"\d{2}:\d{2}:\d{2}", text)) // 2
        merged = merge_vtt(text)
        cue_count_after = len(re.findall(r"\d{2}:\d{2}:\d{2}", merged)) // 2
        with open(f, "w", encoding="utf-8") as fh:
            fh.write(merged)
        print(f"  {f.name}: {cue_count_before} -> {cue_count_after} cues", flush=True)

if __name__ == "__main__":
    main()
