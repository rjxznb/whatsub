# -*- coding: utf-8 -*-
"""Match cut VTT entries against original analyses for shopping videos."""
import re
import json
import os
from difflib import SequenceMatcher

BASE = r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\shopping"

# All cut VTT files and their original analysis
CUTS = [
    ("EvvEAg2ODCs", "cut_EvvEAg2ODCs.en.clean.vtt", "EvvEAg2ODCs.analysis.json"),
    ("FwqgPhtR8C0", "cut_part1_cooking.en.clean.vtt", "FwqgPhtR8C0.analysis.json"),
    ("FwqgPhtR8C0", "cut_part2_makeup-1.en.clean.vtt", "FwqgPhtR8C0.analysis.json"),
    ("FwqgPhtR8C0", "cut_part3_makeup-1.en.clean.vtt", "FwqgPhtR8C0.analysis.json"),
    ("FwqgPhtR8C0", "cut_part4_cooking-1.en.clean.vtt", "FwqgPhtR8C0.analysis.json"),
    ("pAC_BHLaNDk", "cut_part1_exercise-1.en.clean.vtt", "pAC_BHLaNDk.analysis.json"),
    ("pAC_BHLaNDk", "cut_part2_shppping.en.clean.vtt", "pAC_BHLaNDk.analysis.json"),
    ("pAC_BHLaNDk", "cut_part3_trip.en.clean.vtt", "pAC_BHLaNDk.analysis.json"),
    ("pVO8P4TKXJY", "cut_pVO8P4TKXJY.en.clean.vtt", "pVO8P4TKXJY.analysis.json"),
    ("rui0QIorHbE", "cut_rui0QIorHbE.en.clean.vtt", "rui0QIorHbE.analysis.json"),
    ("s_TAZs0U3_g", "cut_s_TAZs0U3_g.en.clean.vtt", "s_TAZs0U3_g.analysis.json"),
]


def parse_vtt(path):
    """Parse clean VTT into list of {time, endTime, text}."""
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    entries = []
    pattern = r'(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})\n(.+?)(?=\n\n|\n\d{2}:\d{2}|\Z)'
    for m in re.finditer(pattern, content, re.DOTALL):
        start_str, end_str, text = m.group(1), m.group(2), m.group(3).strip()
        start = ts_to_sec(start_str)
        end = ts_to_sec(end_str)
        # Skip empty or music-only entries
        text_clean = re.sub(r'\[.*?\]', '', text).strip()
        if not text_clean:
            continue
        entries.append({"time": start, "endTime": end, "text": text})
    return entries


def ts_to_sec(ts):
    """Convert HH:MM:SS.mmm to seconds."""
    h, m, rest = ts.split(":")
    s, ms = rest.split(".")
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def match_entries(vtt_entries, orig_subs, threshold=0.45):
    """Match VTT entries against original subs using text similarity."""
    results = []
    for entry in vtt_entries:
        best_score = 0
        best_match = None
        vtt_text = entry["text"].lower().strip()
        for sub in orig_subs:
            orig_text = sub["text"].lower().strip()
            score = SequenceMatcher(None, vtt_text, orig_text).ratio()
            if score > best_score:
                best_score = score
                best_match = sub

        result = {
            "time": entry["time"],
            "endTime": entry["endTime"],
            "text": entry["text"],
            "translation": "",
            "isKeyPoint": False,
            "highlightWords": [],
            "keyNotes": {},
            "highlightTranslations": {},
        }

        if best_score >= threshold and best_match:
            result["translation"] = best_match.get("translation", "")
            result["isKeyPoint"] = best_match.get("isKeyPoint", False)
            # Validate highlightWords against new text
            hw = best_match.get("highlightWords", [])
            valid_hw = [w for w in hw if w in entry["text"]]
            result["highlightWords"] = valid_hw
            # Copy keyNotes and highlightTranslations for valid words
            kn = best_match.get("keyNotes", {})
            ht = best_match.get("highlightTranslations", {})
            result["keyNotes"] = {w: kn[w] for w in valid_hw if w in kn}
            result["highlightTranslations"] = {w: ht[w] for w in valid_hw if w in ht}

        results.append((result, best_score))
    return results


def main():
    total_cues = 0
    total_matched = 0

    for vid_id, vtt_name, orig_name in CUTS:
        vtt_path = os.path.join(BASE, vid_id, vtt_name)
        orig_path = os.path.join(BASE, vid_id, orig_name)

        vtt_entries = parse_vtt(vtt_path)
        with open(orig_path, "r", encoding="utf-8") as f:
            orig_data = json.load(f)
        orig_subs = orig_data.get("subtitles", [])

        results = match_entries(vtt_entries, orig_subs)
        matched = sum(1 for _, score in results if score >= 0.45)
        gaps = sum(1 for r, score in results if not r["translation"])

        total_cues += len(vtt_entries)
        total_matched += matched

        print(f"{vid_id}/{vtt_name}: {len(vtt_entries)} cues, {matched} matched ({matched*100//max(len(vtt_entries),1)}%), {gaps} gaps", flush=True)

        # Save matched results
        out_name = vtt_name.replace(".en.clean.vtt", ".analysis.json")
        out_path = os.path.join(BASE, vid_id, out_name)

        subs = [r for r, _ in results]
        analysis = {
            "sceneContext": orig_data.get("sceneContext", ""),
            "subtitles": subs,
            "keyPhrases": orig_data.get("keyPhrases", []),
            "roleSetup": orig_data.get("roleSetup", {}),
            "complications": orig_data.get("complications", {}),
            "maxRounds": orig_data.get("maxRounds", {}),
            "commonErrors": orig_data.get("commonErrors", []),
            "culturalNotes": orig_data.get("culturalNotes", ""),
            "country": orig_data.get("country", "US"),
        }

        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(analysis, f, ensure_ascii=False, indent=2)
        print(f"  -> Saved {out_path}", flush=True)

    print(f"\nTotal: {total_cues} cues, {total_matched} matched ({total_matched*100//max(total_cues,1)}%)", flush=True)
    print(f"Gaps to fill: {total_cues - total_matched}", flush=True)


if __name__ == "__main__":
    main()
