#!/usr/bin/env python3
"""Extract JSON from agent output file."""
import json, sys, re, os

def extract_json(filepath, output_path):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Find the last occurrence of "sceneContext" which marks the main JSON
    idx = content.rfind('"sceneContext"')
    if idx == -1:
        print("No sceneContext found")
        return False

    # Go back to find opening brace
    brace_idx = content.rfind('{', 0, idx)
    snippet = content[brace_idx:]

    # Check if content is JSON-escaped (literal \n and \")
    if snippet[1:5] == '\\n  ' or '\\n' in snippet[:50]:
        # Unescape the JSON string
        # Find the end - look for closing brace pattern
        # The JSON ends with \n} possibly followed by escaped backticks
        end_pattern = re.search(r'\\n\}(?:\\n```|[^\\])', snippet)
        if end_pattern:
            json_escaped = snippet[:end_pattern.start() + 3]  # include \n}
        else:
            # Find last unescaped }
            last = snippet.rfind('\\n}')
            json_escaped = snippet[:last + 3]

        # Unescape
        unescaped = json_escaped.replace('\\\\', '\x00BACKSLASH\x00')
        unescaped = unescaped.replace('\\n', '\n')
        unescaped = unescaped.replace('\\"', '"')
        unescaped = unescaped.replace('\\/', '/')
        unescaped = unescaped.replace('\\t', '\t')
        unescaped = unescaped.replace('\x00BACKSLASH\x00', '\\')
        text = unescaped
    else:
        # Not escaped, find closing brace
        # Count braces to find matching close
        depth = 0
        end_idx = 0
        for i, c in enumerate(snippet):
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    end_idx = i
                    break
        text = snippet[:end_idx + 1]

    # Parse JSON
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        print(f"Parse error: {e}")
        lines = text.split('\n')
        ln = e.lineno - 1
        for i in range(max(0, ln-2), min(len(lines), ln+3)):
            mk = '>>>' if i == ln else '   '
            print(f'{mk} {i+1}: {lines[i][:150]}')
        return False

    subs = parsed.get('subtitles', [])
    kp = sum(1 for s in subs if s.get('isKeyPoint'))
    print(f"Subtitles: {len(subs)}, Key points: {kp}, Key phrases: {len(parsed.get('keyPhrases', []))}")

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(parsed, f, ensure_ascii=False, indent=2)
    print(f"Written to {output_path}")
    return True

if __name__ == '__main__':
    extract_json(sys.argv[1], sys.argv[2])
