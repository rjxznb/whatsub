#!/usr/bin/env python3
"""Fix unescaped quotes and invalid escapes in analysis JSON files."""
import json, sys
sys.stdout.reconfigure(encoding='utf-8')

filepath = sys.argv[1]
with open(filepath, encoding='utf-8') as f:
    content = f.read()

for attempt in range(200):
    try:
        d = json.loads(content)
        break
    except json.JSONDecodeError as e:
        pos = e.pos
        msg = str(e)
        if "Expecting ',' delimiter" in msg or "Expecting ':' delimiter" in msg:
            if pos < len(content) and content[pos] == '"':
                prev_q = content.rfind('"', max(0, pos - 150), pos)
                if prev_q > 0:
                    before_ch = content[prev_q - 1] if prev_q > 0 else ''
                    if before_ch not in (',', ':', '{', '[', ' ', '\n', '\t'):
                        content = content[:prev_q] + '\u300c' + content[prev_q+1:]
                        content = content[:pos] + '\u300d' + content[pos+1:]
                        continue
                content = content[:pos] + '\u300c' + content[pos+1:]
                continue
            elif pos > 0 and content[pos-1] == '"':
                content = content[:pos-1] + '\u300d' + content[pos:]
                continue
        elif "Invalid \\escape" in msg:
            bslash = '\\'
            for i in range(max(0, pos-3), min(len(content), pos+3)):
                if content[i] == bslash and i+1 < len(content) and content[i+1] not in 'nrtbf/\\"u':
                    content = content[:i] + content[i+1:]
                    break
            else:
                print(f'Cannot fix escape at pos {pos}')
                sys.exit(1)
            continue
        elif "Invalid control character" in msg:
            if pos < len(content) and ord(content[pos]) < 32:
                content = content[:pos] + ' ' + content[pos+1:]
                continue
        print(f'Unfixable at attempt {attempt}, pos {pos}: {msg}')
        sys.exit(1)
else:
    print('Max attempts reached')
    sys.exit(1)

with open(filepath, 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
print(f'Fixed after {attempt+1} iterations and re-serialized via json.dump')

subs = d['subtitles']
kp = sum(1 for s in subs if s.get('isKeyPoint'))
overlaps = 0
for i in range(len(subs)-1):
    if subs[i]['endTime'] > subs[i+1]['time']:
        overlaps += 1
        print(f'  Overlap at {i}: endTime={subs[i]["endTime"]} > next.time={subs[i+1]["time"]}')
hw_errors = 0
for i, s in enumerate(subs):
    for hw in s.get('highlightWords', []):
        if hw not in s['text']:
            hw_errors += 1
            print(f'  HW err at {i}: {repr(hw)}')
ht_errors = 0
for i, s in enumerate(subs):
    for k, v in s.get('highlightTranslations', {}).items():
        if v not in s['translation']:
            ht_errors += 1
            print(f'  HT err at {i}: {repr(v)}')
print(f'Subtitles: {len(subs)}, Key points: {kp} ({kp*100//len(subs)}%), Key phrases: {len(d["keyPhrases"])}, Overlaps: {overlaps}, HW errors: {hw_errors}, HT errors: {ht_errors}')
