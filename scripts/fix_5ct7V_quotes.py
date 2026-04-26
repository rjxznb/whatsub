# -*- coding: utf-8 -*-
"""Fix ASCII double quotes inside CJK text in 5ct7V20VEkY analysis."""
import re
import json

path = r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\medical\5ct7V20VEkY\cut_5ct7V20VEkY.analysis.json"

with open(path, "r", encoding="utf-8") as f:
    text = f.read()

LQ = "\u201c"  # left curly double quote
RQ = "\u201d"  # right curly double quote

# Strategy: process line by line, fix embedded ASCII quotes in JSON string values
# An embedded quote is one that's inside a JSON value string and surrounded by non-JSON-structural chars

def fix_line(line):
    """Fix ASCII quotes embedded in CJK text within a JSON string value."""
    # Find key-value pattern: "key": "value"
    # We want to fix quotes inside the value part
    m = re.match(r'^(\s*"[^"]*":\s*)"(.*)"(,?\s*)$', line)
    if not m:
        return line

    prefix = m.group(1)
    value = m.group(2)
    suffix = m.group(3)

    # In the value, replace ASCII quotes between CJK chars
    # Pattern: CJK-ish char before and after a quote
    CJK = r'[\u2000-\u9fff\uf900-\ufaff\uff00-\uffef]'
    # Replace opening quotes (CJK/punct before, CJK after)
    fixed_value = value
    # Do multiple passes for paired quotes
    # Match: (CJK-like char)(ASCII quote)(CJK chars)(ASCII quote)(CJK-like char)
    fixed_value = re.sub(
        r'(' + CJK + r'|[。，、；：！？）】」』])(")((?:' + CJK + r'|[^\x22])*?)(")',
        lambda m: m.group(1) + LQ + m.group(3) + RQ,
        fixed_value
    )
    # Also handle: start of string with quote followed by CJK
    fixed_value = re.sub(
        r'^(")([\u4e00-\u9fff])',
        lambda m: LQ + m.group(2),
        fixed_value
    )

    if fixed_value != value:
        return prefix + '"' + fixed_value + '"' + suffix
    return line

lines = text.split("\n")
fixed_lines = [fix_line(line) for line in lines]
fixed_text = "\n".join(fixed_lines)

# Try to parse
try:
    data = json.loads(fixed_text)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"Fixed and saved. {len(data['subtitles'])} subtitles.")
except json.JSONDecodeError as e:
    print(f"Still broken at line {e.lineno}: {e.msg}")
    err_lines = fixed_text.split("\n")
    for i in range(max(0, e.lineno-3), min(len(err_lines), e.lineno+2)):
        print(f"  {i+1}: {err_lines[i][:120]}")

    # Fallback: try more aggressive quote fixing
    print("\nAttempting aggressive fix...")
    # Find all remaining embedded ASCII quotes
    for idx in range(len(err_lines)):
        line = err_lines[idx]
        # Count quotes in the line
        quotes = [i for i, c in enumerate(line) if c == '"']
        if len(quotes) > 4:  # More than key:value pair quotes
            print(f"  Line {idx+1} has {len(quotes)} quotes: {line[:100]}")
