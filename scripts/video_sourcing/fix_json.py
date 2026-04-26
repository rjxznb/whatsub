#!/usr/bin/env python3
"""Fix unescaped double quotes inside JSON string values in analysis files."""

import json
import os
import glob
import sys


def fix_json_quotes(text):
    """Fix unescaped double quotes inside JSON string values."""
    result = []
    i = 0
    in_string = False

    while i < len(text):
        ch = text[i]

        if not in_string:
            result.append(ch)
            if ch == '"':
                in_string = True
        else:
            # We're inside a string
            if ch == '\\':
                # Escape sequence - copy both chars
                result.append(ch)
                if i + 1 < len(text):
                    i += 1
                    result.append(text[i])
            elif ch == '"':
                # Is this the closing quote or an unescaped interior quote?
                # Look ahead: if followed by JSON structural chars, it's closing
                rest = text[i + 1:].lstrip(' \t')
                if rest and rest[0] in ':,}]\r\n':
                    # This is a structural closing quote
                    result.append(ch)
                    in_string = False
                elif not rest:
                    # End of text
                    result.append(ch)
                    in_string = False
                else:
                    # Interior quote - replace with Chinese curly quote
                    prev_char = text[i - 1] if i > 0 else ''
                    next_char = text[i + 1] if i + 1 < len(text) else ''

                    if prev_char in '：:，, （(\u3000':
                        result.append('\u201c')  # left "
                    elif next_char in '，,。.！!？? ）)\u3000':
                        result.append('\u201d')  # right "
                    else:
                        # Default: use left quote for now
                        result.append('\u201c')
            else:
                result.append(ch)

        i += 1

    return ''.join(result)


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else 'data/cc-video'
    fixed = 0
    still_broken = 0
    already_valid = 0

    for f in sorted(glob.glob(os.path.join(base, '*/*/*.analysis.json'))):
        vid = os.path.basename(f).replace('.analysis.json', '')
        scene = f.split(os.sep)[-3]

        with open(f, 'r', encoding='utf-8') as fh:
            content = fh.read()

        try:
            json.loads(content)
            already_valid += 1
            continue
        except json.JSONDecodeError:
            pass

        # Try to fix
        repaired = fix_json_quotes(content)
        try:
            data = json.loads(repaired)
            # Re-write with proper formatting to ensure clean JSON
            with open(f, 'w', encoding='utf-8') as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
            fixed += 1
            print(f'  FIXED: {scene}/{vid}')
        except json.JSONDecodeError as e:
            still_broken += 1
            print(f'  STILL BROKEN: {scene}/{vid} - {str(e)[:80]}')

    print(f'\nAlready valid: {already_valid}, Fixed: {fixed}, Still broken: {still_broken}')


if __name__ == '__main__':
    main()
