#!/usr/bin/env python3
"""
Clean auto-generated YouTube VTT subtitles.

YouTube auto-captions use a rolling two-line display with <c> word-level timestamps.
This creates massive redundancy (each text chunk appears 3-4 times). This script
deduplicates them into clean, sequential paragraph-level subtitles.

Usage:
    python clean_vtt.py <input.vtt>                  # prints clean VTT to stdout
    python clean_vtt.py <input.vtt> -o <output.vtt>  # writes to file
    python clean_vtt.py --dir <path>                  # batch clean all VTTs in tree
"""

import re
import sys
import os
import argparse
from pathlib import Path


def is_auto_generated(vtt_text: str) -> bool:
    """Detect if VTT is YouTube auto-generated (has <c> tags and position:0%)."""
    return "<c>" in vtt_text and "position:0%" in vtt_text


def parse_timestamp(ts: str) -> float:
    """Convert VTT timestamp to seconds. '00:01:23.450' -> 83.45"""
    parts = ts.strip().split(":")
    if len(parts) == 3:
        h, m, s = parts
    elif len(parts) == 2:
        h = "0"
        m, s = parts
    else:
        return 0.0
    s = s.replace(",", ".")
    return int(h) * 3600 + int(m) * 60 + float(s)


def format_timestamp(seconds: float) -> str:
    """Convert seconds to VTT timestamp. 83.45 -> '00:01:23.450'"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def strip_c_tags(text: str) -> str:
    """Remove <c>, </c>, and <00:00:xx.xxx> inline timestamp tags."""
    text = re.sub(r"<\d{2}:\d{2}:\d{2}\.\d{3}>", "", text)
    text = re.sub(r"</?c>", "", text)
    return text.strip()


def _is_noise(text: str) -> bool:
    """Check if text is purely [Music], [Applause], foreign, etc."""
    cleaned = re.sub(r"\[.*?\]", "", text).strip()
    if not cleaned:
        return True
    if cleaned.lower() in ("foreign", "applause", "music"):
        return True
    return False


def clean_auto_vtt(vtt_text: str, merge_gap: float = 1.5, max_segment_duration: float = 10.0) -> str:
    """
    Clean auto-generated VTT by extracting unique text chunks and merging
    them into ~10s segments.

    Key design choices:
    - Use START timestamps only (YouTube end times are unreliable and can exceed video duration)
    - Skip [Music]/[Applause]/foreign-only cues
    - Preserve silence gaps — don't stretch end times across gaps
    - Hard-split any segment > max_duration at word boundaries
    """
    # Parse all cues
    cue_pattern = re.compile(
        r"(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})[^\n]*\n"
        r"(.*?)(?=\n\n|\n\d{2}:\d{2}|\Z)",
        re.DOTALL
    )

    chunks = []  # list of (start, text)

    for match in cue_pattern.finditer(vtt_text):
        start = parse_timestamp(match.group(1))
        end = parse_timestamp(match.group(2))
        body = match.group(3).strip()

        # Skip bridge cues (duration < 0.05s)
        if end - start < 0.05:
            continue

        # Main cue has two lines; the second line contains <c> tags with new content
        lines = body.split("\n")
        if len(lines) >= 2:
            new_line = lines[-1].strip()
            if "<c>" in new_line or re.search(r"<\d{2}:\d{2}:\d{2}\.\d{3}>", new_line):
                text = strip_c_tags(new_line)
            else:
                text = new_line
        elif len(lines) == 1:
            text = strip_c_tags(lines[0])
        else:
            continue

        if not text or _is_noise(text):
            continue

        chunks.append((start, text))

    if not chunks:
        return vtt_text

    # Calculate end times from speech duration and next chunk's start
    timed_chunks = []  # (start, end, text)
    for i, (start, text) in enumerate(chunks):
        word_count = len(text.split())
        speech_dur = max(word_count / 2.5, 0.5)
        if i + 1 < len(chunks):
            next_start = chunks[i + 1][0]
            end = min(start + speech_dur, next_start)
        else:
            end = start + speech_dur
        # Ensure end > start
        end = max(end, start + 0.1)
        timed_chunks.append((start, end, text))

    # Merge chunks into segments (target ~10s)
    segments = []
    seg_start = timed_chunks[0][0]
    seg_end = timed_chunks[0][1]
    seg_texts = [timed_chunks[0][2]]

    for i in range(1, len(timed_chunks)):
        curr_start = timed_chunks[i][0]
        curr_end = timed_chunks[i][1]
        gap = curr_start - seg_end
        seg_duration = curr_end - seg_start

        if gap > merge_gap or seg_duration > max_segment_duration:
            segments.append((seg_start, seg_end, " ".join(seg_texts)))
            seg_start = curr_start
            seg_end = curr_end
            seg_texts = [timed_chunks[i][2]]
        else:
            seg_end = curr_end
            seg_texts.append(timed_chunks[i][2])

    segments.append((seg_start, seg_end, " ".join(seg_texts)))

    # Hard-split any segment still > max_duration * 1.3 (13s) at word boundaries
    split_segments = []
    for start, end, text in segments:
        duration = end - start
        if duration <= max_segment_duration * 1.3:
            split_segments.append((start, end, text))
            continue
        # Split into roughly equal parts
        words = text.split()
        n_parts = max(2, int(duration / max_segment_duration + 0.5))
        words_per_part = max(1, len(words) // n_parts)
        part_duration = duration / n_parts
        for p in range(n_parts):
            p_start = start + p * part_duration
            p_end = start + (p + 1) * part_duration
            w_start = p * words_per_part
            w_end = (p + 1) * words_per_part if p < n_parts - 1 else len(words)
            p_text = " ".join(words[w_start:w_end])
            if p_text:
                split_segments.append((p_start, p_end, p_text))
    segments = split_segments

    # Absorb very short segments (< 3 words) into neighbors,
    # but never create segments longer than max_duration
    max_dur = max_segment_duration * 1.3
    merged = True
    while merged:
        merged = False
        new_segments = []
        i = 0
        while i < len(segments):
            start, end, text = segments[i]
            if len(text.split()) < 3 and len(segments) > 1:
                # Try merging with previous (if closer and won't exceed max_dur)
                can_prev = (len(new_segments) > 0 and
                            end - new_segments[-1][0] <= max_dur)
                can_next = (i + 1 < len(segments) and
                            segments[i+1][1] - start <= max_dur)
                closer_to_prev = (i == len(segments) - 1 or
                    (len(new_segments) > 0 and
                     (start - new_segments[-1][1]) <= (segments[i+1][0] - end if i+1 < len(segments) else float('inf'))))

                if can_prev and (closer_to_prev or not can_next):
                    ps, pe, pt = new_segments[-1]
                    new_segments[-1] = (ps, end, pt + " " + text)
                    merged = True
                elif can_next:
                    ns, ne, nt = segments[i + 1]
                    segments[i + 1] = (start, ne, text + " " + nt)
                    merged = True
                else:
                    new_segments.append(segments[i])
            else:
                new_segments.append(segments[i])
            i += 1
        segments = new_segments

    # Build clean VTT
    lines = ["WEBVTT", "Kind: captions", "Language: en", ""]
    for start, end, text in segments:
        lines.append(f"{format_timestamp(start)} --> {format_timestamp(end)}")
        lines.append(text)
        lines.append("")

    return "\n".join(lines)


def clean_manual_vtt(vtt_text: str, max_segment_duration: float = 10.0) -> str:
    """
    Clean a manually-authored VTT: remove &nbsp;, skip [Music]-only cues,
    and split segments longer than max_duration.
    """
    cue_pattern = re.compile(
        r"(\d{2}:\d{2}:\d{2}[\.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[\.,]\d{3})[^\n]*\n"
        r"(.*?)(?=\n\n|\n\d{2}:\d{2}|\Z)",
        re.DOTALL
    )

    segments = []
    for match in cue_pattern.finditer(vtt_text):
        start = parse_timestamp(match.group(1))
        end = parse_timestamp(match.group(2))
        body = match.group(3).strip()
        # Clean HTML entities and tags
        body = body.replace("&nbsp;", " ").replace("\n", " ")
        body = re.sub(r"<[^>]+>", "", body).strip()
        body = re.sub(r"\s+", " ", body)

        if not body or _is_noise(body):
            continue

        segments.append((start, end, body))

    if not segments:
        return vtt_text

    # Split long segments at word boundaries
    split_segments = []
    for start, end, text in segments:
        duration = end - start
        if duration <= max_segment_duration * 1.3:
            split_segments.append((start, end, text))
            continue
        words = text.split()
        n_parts = max(2, int(duration / max_segment_duration + 0.5))
        words_per_part = max(1, len(words) // n_parts)
        part_duration = duration / n_parts
        for p in range(n_parts):
            p_start = start + p * part_duration
            p_end = start + (p + 1) * part_duration
            w_start = p * words_per_part
            w_end = (p + 1) * words_per_part if p < n_parts - 1 else len(words)
            p_text = " ".join(words[w_start:w_end])
            if p_text:
                split_segments.append((p_start, p_end, p_text))

    # Ensure sequential timestamps (no overlaps)
    for i in range(1, len(split_segments)):
        if split_segments[i][0] < split_segments[i-1][1]:
            s, e, t = split_segments[i-1]
            split_segments[i-1] = (s, split_segments[i][0], t)

    lines = ["WEBVTT", "Kind: captions", "Language: en", ""]
    for start, end, text in split_segments:
        lines.append(f"{format_timestamp(start)} --> {format_timestamp(end)}")
        lines.append(text)
        lines.append("")

    return "\n".join(lines)


def clean_vtt_file(input_path: str, output_path: str = None) -> str:
    """
    Clean a VTT file. Auto-generated: deduplicate. Manual: clean & split long segments.
    Returns the output path.
    """
    with open(input_path, "r", encoding="utf-8") as f:
        vtt_text = f.read()

    if output_path is None:
        base = input_path.rsplit(".", 1)[0]
        output_path = base + ".clean.vtt"

    if is_auto_generated(vtt_text):
        cleaned = clean_auto_vtt(vtt_text)
    else:
        cleaned = clean_manual_vtt(vtt_text)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(cleaned)
    return output_path


def batch_clean(directory: str) -> dict:
    """Clean all .en.vtt files in a directory tree. Returns stats."""
    stats = {"auto_cleaned": 0, "manual_cleaned": 0, "errors": 0}

    for vtt_path in Path(directory).rglob("*.en.vtt"):
        try:
            with open(vtt_path, "r", encoding="utf-8") as f:
                vtt_text = f.read()

            clean_path = str(vtt_path).replace(".en.vtt", ".clean.vtt")
            if is_auto_generated(vtt_text):
                cleaned = clean_auto_vtt(vtt_text)
                stats["auto_cleaned"] += 1
                label = "Auto"
            else:
                cleaned = clean_manual_vtt(vtt_text)
                stats["manual_cleaned"] += 1
                label = "Manual"

            with open(clean_path, "w", encoding="utf-8") as f:
                f.write(cleaned)
            print(f"  {label}: {vtt_path.name} -> {Path(clean_path).name}")
        except Exception as e:
            stats["errors"] += 1
            print(f"  ERROR: {vtt_path.name}: {e}")

    return stats


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Clean auto-generated YouTube VTT subtitles")
    parser.add_argument("input", nargs="?", help="Input VTT file path")
    parser.add_argument("-o", "--output", help="Output VTT file path")
    parser.add_argument("--dir", help="Batch clean all VTTs in directory tree")
    parser.add_argument("--overwrite", action="store_true",
                        help="Overwrite original .en.vtt instead of creating .clean.vtt")
    args = parser.parse_args()

    if args.dir:
        print(f"Batch cleaning VTTs in: {args.dir}")
        stats = batch_clean(args.dir)
        print(f"\nDone: {stats['auto_cleaned']} auto cleaned, {stats['manual_cleaned']} manual cleaned, {stats['errors']} errors")
    elif args.input:
        output = args.output
        if args.overwrite:
            output = args.input
        result = clean_vtt_file(args.input, output)
        print(f"Output: {result}")
    else:
        parser.print_help()
