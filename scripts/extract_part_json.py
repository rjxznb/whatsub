#!/usr/bin/env python3
"""Extract analysis JSON from agent JSONL output file."""
import json, sys, re, os
sys.stdout.reconfigure(encoding='utf-8')


def fix_unescaped_quotes(json_str):
    """Fix unescaped ASCII double quotes inside JSON string values iteratively."""
    max_attempts = 50
    for _ in range(max_attempts):
        try:
            return json.loads(json_str)
        except json.JSONDecodeError as e:
            pos = e.pos
            msg = str(e)
            if "Expecting ',' delimiter" in msg or "Expecting ':' delimiter" in msg:
                # Likely an unescaped quote inside a string value
                # Look backwards from pos for the problematic quote
                # The char at pos or just before is usually the issue
                # Strategy: scan backwards to find string value context
                search_start = max(0, pos - 100)
                segment = json_str[search_start:pos]
                # Find the last unescaped quote pair that looks like inner quoting
                # Replace ASCII " with Chinese 「」 in the problematic area
                # Find the quote that broke parsing (usually right before pos)
                if json_str[pos] == '"':
                    # This quote ended the string prematurely
                    # Look backwards for the matching inner opening quote
                    # Find previous " that's not a key/value boundary
                    prev_q = json_str.rfind('"', search_start, pos - 1)
                    if prev_q > search_start:
                        # Check if this looks like an inner quote (preceded by non-JSON chars)
                        before = json_str[prev_q - 1] if prev_q > 0 else ''
                        if before not in [',', ':', '{', '[', '\\', '\n', ' ']:
                            json_str = json_str[:prev_q] + '\u300c' + json_str[prev_q+1:]
                            json_str = json_str[:pos] + '\u300d' + json_str[pos+1:]
                            continue
                    # Fallback: just escape the quote at pos
                    json_str = json_str[:pos] + '\u300c' + json_str[pos+1:]
                    continue
                elif pos > 0 and json_str[pos-1] == '"':
                    json_str = json_str[:pos-1] + '\u300d' + json_str[pos:]
                    continue
            elif "Invalid \\escape" in msg:
                # Find the bad escape near pos
                for i in range(max(0, pos-3), min(len(json_str), pos+3)):
                    if json_str[i] == '\\' and i+1 < len(json_str) and json_str[i+1] not in 'nrtbf/\\"u':
                        json_str = json_str[:i] + json_str[i+1:]
                        break
                continue
            elif "Invalid control character" in msg:
                # Replace control chars (tabs, newlines inside strings) with space
                if pos < len(json_str) and ord(json_str[pos]) < 32:
                    json_str = json_str[:pos] + ' ' + json_str[pos+1:]
                    continue
                # Scan nearby for control chars
                for i in range(max(0, pos-5), min(len(json_str), pos+5)):
                    if ord(json_str[i]) < 32 and json_str[i] not in '\n\r':
                        json_str = json_str[:i] + ' ' + json_str[i+1:]
                        break
                continue
            # Unknown error, bail
            raise
    raise json.JSONDecodeError("Max fix attempts reached", json_str, 0)


def clean_control_chars(s):
    """Remove control characters that are invalid in JSON strings."""
    out = []
    for ch in s:
        if ord(ch) < 32 and ch not in '\n\r\t':
            out.append(' ')
        else:
            out.append(ch)
    return ''.join(out)


def pre_fix_inner_quotes(s):
    """Fix unescaped quotes in JSON by processing line by line.

    For pretty-printed JSON, each line has a clear structure.
    Lines with string values (containing `: "..."`): find inner unescaped quotes
    and replace with 「」.
    """
    lines = s.split('\n')
    fixed = []
    for line in lines:
        # Find string value pattern: "key": "value"  or just "value",
        # We look for the value part and fix inner quotes
        stripped = line.lstrip()
        if '": "' in line:
            # Line has key-value pair with string value
            # Find the value start (after ": ")
            idx = line.index('": "') + 4
            # The value should end at the last " on the line (before optional ,)
            rest = line[idx:]
            # Find the closing quote: it's the last " before optional , and whitespace
            rstripped = rest.rstrip()
            if rstripped.endswith('",') or rstripped.endswith('"'):
                if rstripped.endswith('",'):
                    val_content = rstripped[:-2]
                else:
                    val_content = rstripped[:-1]
                # Replace all " in val_content with 「」 alternating
                new_val = val_content.replace('"', '\u300c')
                if rstripped.endswith('",'):
                    line = line[:idx] + new_val + '",'
                else:
                    line = line[:idx] + new_val + '"'
        fixed.append(line)
    return '\n'.join(fixed)


def extract_and_write(text, output_file):
    """Extract JSON from text containing ```json blocks and write to file."""
    json_markers = list(re.finditer(r'```json\n', text))
    if not json_markers:
        return False
    start = json_markers[-1].end()
    end = text.find('\n```', start)
    if end == -1:
        end = len(text)
    json_str = text[start:end].strip()
    json_str = clean_control_chars(json_str)
    json_str = pre_fix_inner_quotes(json_str)
    parsed = fix_unescaped_quotes(json_str)
    subs = parsed.get('subtitles', [])
    kp = sum(1 for s in subs if s.get('isKeyPoint'))
    ht = sum(1 for s in subs if s.get('highlightTranslations'))
    print(f"Subtitles: {len(subs)}, Key points: {kp}, "
          f"Key phrases: {len(parsed.get('keyPhrases', []))}, "
          f"With highlightTranslations: {ht}")
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(parsed, f, ensure_ascii=False, indent=2)
    print(f"Written to {output_file}")
    return True


input_file = sys.argv[1]
output_file = sys.argv[2]

with open(input_file, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find the assistant message containing sceneContext
for line in reversed(lines):
    obj = json.loads(line)
    msg = obj.get('message', {})
    content = msg.get('content', '')
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and 'text' in block and 'sceneContext' in block['text']:
                if extract_and_write(block['text'], output_file):
                    sys.exit(0)
    elif isinstance(content, str) and 'sceneContext' in content:
        if extract_and_write(content, output_file):
            sys.exit(0)

print("ERROR: Could not find JSON in agent output")
sys.exit(1)
