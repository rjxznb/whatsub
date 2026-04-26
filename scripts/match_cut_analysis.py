"""
Match Whisper-transcribed cut VTT subtitles against original analysis.json files.
Copies translations, keyNotes, highlightWords, highlightTranslations from originals.
"""
import json
import re
import os
from difflib import SequenceMatcher

BASE = r"C:\Users\renjx\Desktop\Get_Video\data\cc-video"

def parse_vtt(path):
    """Parse clean VTT into list of {time, endTime, text}."""
    entries = []
    with open(path, "r", encoding="utf-8") as f:
        lines = f.read().strip().split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        m = re.match(r"(\d+:\d+:\d+\.\d+)\s*-->\s*(\d+:\d+:\d+\.\d+)", line)
        if m:
            start_str, end_str = m.group(1), m.group(2)
            start = ts_to_sec(start_str)
            end = ts_to_sec(end_str)
            text_lines = []
            i += 1
            while i < len(lines) and lines[i].strip() and not re.match(r"\d+:\d+:\d+\.\d+\s*-->", lines[i].strip()):
                text_lines.append(lines[i].strip())
                i += 1
            text = " ".join(text_lines)
            if text:
                entries.append({"time": round(start, 3), "endTime": round(end, 3), "text": text})
        else:
            i += 1
    return entries

def ts_to_sec(ts):
    parts = ts.split(":")
    h, m, s = int(parts[0]), int(parts[1]), float(parts[2])
    return h * 3600 + m * 60 + s

def clean_text(t):
    """Normalize text for comparison."""
    t = t.lower().strip()
    t = re.sub(r"[^a-z0-9\s]", "", t)
    t = re.sub(r"\s+", " ", t)
    return t

def similarity(a, b):
    return SequenceMatcher(None, clean_text(a), clean_text(b)).ratio()

def find_best_match(whisper_text, orig_subs, used_indices):
    """Find best matching original subtitle for a Whisper entry."""
    best_score = 0
    best_idx = -1
    for idx, orig in enumerate(orig_subs):
        if idx in used_indices:
            continue
        score = similarity(whisper_text, orig["text"])
        if score > best_score:
            best_score = score
            best_idx = idx
    return best_idx, best_score

def process_cut(cut_vtt_path, orig_analysis_path, output_path):
    """Process one cut video: match Whisper subs against original analysis."""
    print(f"\n{'='*60}")
    print(f"Processing: {os.path.basename(cut_vtt_path)}")
    print(f"  Original: {os.path.basename(orig_analysis_path)}")

    whisper_entries = parse_vtt(cut_vtt_path)
    print(f"  Whisper entries: {len(whisper_entries)}")

    with open(orig_analysis_path, "r", encoding="utf-8") as f:
        orig = json.load(f)

    orig_subs = orig["subtitles"]
    print(f"  Original subs: {len(orig_subs)}")

    used_indices = set()
    matched = 0
    unmatched = 0
    new_subs = []

    for entry in whisper_entries:
        best_idx, best_score = find_best_match(entry["text"], orig_subs, used_indices)

        if best_score >= 0.45:
            used_indices.add(best_idx)
            matched += 1
            orig_sub = orig_subs[best_idx]

            # Validate highlightWords are substrings of new text
            valid_hw = []
            valid_kn = {}
            valid_ht = {}
            for hw in orig_sub.get("highlightWords", []):
                if hw.lower() in entry["text"].lower():
                    valid_hw.append(hw)
                    if hw in orig_sub.get("keyNotes", {}):
                        valid_kn[hw] = orig_sub["keyNotes"][hw]
                    if hw in orig_sub.get("highlightTranslations", {}):
                        valid_ht[hw] = orig_sub["highlightTranslations"][hw]

            new_subs.append({
                "time": entry["time"],
                "endTime": entry["endTime"],
                "text": entry["text"],
                "translation": orig_sub.get("translation", ""),
                "isKeyPoint": bool(valid_hw),
                "highlightWords": valid_hw,
                "keyNotes": valid_kn,
                "highlightTranslations": valid_ht
            })
        else:
            unmatched += 1
            new_subs.append({
                "time": entry["time"],
                "endTime": entry["endTime"],
                "text": entry["text"],
                "translation": "",
                "isKeyPoint": False,
                "highlightWords": [],
                "keyNotes": {},
                "highlightTranslations": {}
            })

    print(f"  Matched: {matched}, Unmatched: {unmatched}")
    print(f"  Match rate: {matched/(matched+unmatched)*100:.1f}%")

    # Build output analysis
    output = {
        "sceneContext": orig.get("sceneContext", ""),
        "subtitles": new_subs,
        "keyPhrases": orig.get("keyPhrases", []),
        "roleSetup": orig.get("roleSetup", {}),
        "complications": orig.get("complications", []),
        "maxRounds": orig.get("maxRounds", 10),
        "commonErrors": orig.get("commonErrors", []),
        "culturalNotes": orig.get("culturalNotes", ""),
        "country": orig.get("country", "US")
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"  Written: {output_path}")
    return matched, unmatched

# Define all cut video mappings
cuts = [
    (
        os.path.join(BASE, "medical", "-cDhWSVxPGE", "cut_-cDhWSVxPGE.clean.vtt"),
        os.path.join(BASE, "medical", "-cDhWSVxPGE", "-cDhWSVxPGE.analysis.json"),
        os.path.join(BASE, "medical", "-cDhWSVxPGE", "cut_-cDhWSVxPGE.analysis.json"),
    ),
    (
        os.path.join(BASE, "medical", "8NN60iwUdgA", "cut_part1.clean.vtt"),
        os.path.join(BASE, "medical", "8NN60iwUdgA", "8NN60iwUdgA.analysis.json"),
        os.path.join(BASE, "medical", "8NN60iwUdgA", "cut_part1.analysis.json"),
    ),
    (
        os.path.join(BASE, "medical", "nAsy-Eayoec", "cut_part1.clean.vtt"),
        os.path.join(BASE, "medical", "nAsy-Eayoec", "nAsy-Eayoec.analysis.json"),
        os.path.join(BASE, "medical", "nAsy-Eayoec", "cut_part1.analysis.json"),
    ),
    (
        os.path.join(BASE, "medical", "nAsy-Eayoec", "cut_part2.clean.vtt"),
        os.path.join(BASE, "medical", "nAsy-Eayoec", "nAsy-Eayoec.analysis.json"),
        os.path.join(BASE, "medical", "nAsy-Eayoec", "cut_part2.analysis.json"),
    ),
    (
        os.path.join(BASE, "medical", "nAsy-Eayoec", "cut_part3.clean.vtt"),
        os.path.join(BASE, "medical", "nAsy-Eayoec", "nAsy-Eayoec.analysis.json"),
        os.path.join(BASE, "medical", "nAsy-Eayoec", "cut_part3.analysis.json"),
    ),
    (
        os.path.join(BASE, "mental_health", "EGHsLhYl3Bk", "cut_EGHsLhYl3Bk.clean.vtt"),
        os.path.join(BASE, "mental_health", "EGHsLhYl3Bk", "EGHsLhYl3Bk.analysis.json"),
        os.path.join(BASE, "mental_health", "EGHsLhYl3Bk", "cut_EGHsLhYl3Bk.analysis.json"),
    ),
    (
        os.path.join(BASE, "mental_health", "Jpdrd0ZTaeI", "cut_part1.clean.vtt"),
        os.path.join(BASE, "mental_health", "Jpdrd0ZTaeI", "Jpdrd0ZTaeI.analysis.json"),
        os.path.join(BASE, "mental_health", "Jpdrd0ZTaeI", "cut_part1.analysis.json"),
    ),
    (
        os.path.join(BASE, "mental_health", "Jpdrd0ZTaeI", "cut_part2.clean.vtt"),
        os.path.join(BASE, "mental_health", "Jpdrd0ZTaeI", "Jpdrd0ZTaeI.analysis.json"),
        os.path.join(BASE, "mental_health", "Jpdrd0ZTaeI", "cut_part2.analysis.json"),
    ),
    (
        os.path.join(BASE, "mental_health", "Jpdrd0ZTaeI", "cut_part3.clean.vtt"),
        os.path.join(BASE, "mental_health", "Jpdrd0ZTaeI", "Jpdrd0ZTaeI.analysis.json"),
        os.path.join(BASE, "mental_health", "Jpdrd0ZTaeI", "cut_part3.analysis.json"),
    ),
    (
        os.path.join(BASE, "mental_health", "Jpdrd0ZTaeI", "cut_part4.clean.vtt"),
        os.path.join(BASE, "mental_health", "Jpdrd0ZTaeI", "Jpdrd0ZTaeI.analysis.json"),
        os.path.join(BASE, "mental_health", "Jpdrd0ZTaeI", "cut_part4.analysis.json"),
    ),
    (
        os.path.join(BASE, "mental_health", "TgBNLsAgvlU", "cut_TgBNLsAgvlU.clean.vtt"),
        os.path.join(BASE, "mental_health", "TgBNLsAgvlU", "TgBNLsAgvlU.analysis.json"),
        os.path.join(BASE, "mental_health", "TgBNLsAgvlU", "cut_TgBNLsAgvlU.analysis.json"),
    ),
]

if __name__ == "__main__":
    total_matched = 0
    total_unmatched = 0
    for cut_vtt, orig_json, out_json in cuts:
        if not os.path.exists(cut_vtt):
            print(f"SKIP (no VTT): {cut_vtt}")
            continue
        if not os.path.exists(orig_json):
            print(f"SKIP (no original): {orig_json}")
            continue
        m, u = process_cut(cut_vtt, orig_json, out_json)
        total_matched += m
        total_unmatched += u

    print(f"\n{'='*60}")
    print(f"TOTAL: {total_matched} matched, {total_unmatched} unmatched")
    print(f"Overall match rate: {total_matched/(total_matched+total_unmatched)*100:.1f}%")
