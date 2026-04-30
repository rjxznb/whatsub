import type { Subtitle } from "../llm/types";

/** ffmpeg/libass uses centiseconds (1/100 sec) in event times. Round once to
 *  total cs before splitting so floating-point error in `seconds` (e.g.
 *  67.91 stored as 67.9099…) doesn't drop a centisecond. */
function fmtAssTime(seconds: number): string {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(totalCs / 360000);
  const m = Math.floor((totalCs % 360000) / 6000);
  const s = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${h}:${m.toString().padStart(2, "0")}:${s
    .toString()
    .padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

/**
 * Escape arbitrary user text for an ASS Dialogue line.
 *
 *  - Curly braces are reserved for override tags — escape them.
 *  - Backslashes are reserved for line breaks (\N) — escape them.
 *  - Real newlines must become the ASS break sequence \N (literally
 *    backslash-N in the file).
 *  - Comma is the field separator inside Dialogue, but since we always
 *    place text in the LAST field it's safe.
 */
function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

export interface AssBuildOptions {
  includeEnglish: boolean;
  includeChinese: boolean;
  highlightKeyPhrases: boolean;
  /** Source video resolution; libass scales the styles relative to PlayResY. */
  playResX?: number;
  playResY?: number;
}

/**
 * Build a complete .ass file rendering each cue as one or two Dialogue events.
 * Highlights are applied via inline `{\c&H00FFFF&}…{\r}` override tags
 * (yellow in BGR). The same left-to-right span-splicing logic as
 * SubtitleList.tsx is used so highlights match what the user sees on screen.
 */
export function subtitlesToAss(
  subs: Subtitle[],
  opts: AssBuildOptions,
): string {
  const playResX = opts.playResX ?? 1280;
  const playResY = opts.playResY ?? 720;

  // Two styles, anchored bottom-center. English sits on top, Chinese below.
  // MarginV is in PlayRes units; libass scales relative to actual frame size.
  const styles = [
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // English: Arial, white, black outline, slightly bigger.
    "Style: EN,Arial,42,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,2.4,1,2,40,40,90,1",
    // Chinese: Microsoft YaHei (universal on Win), white, black outline.
    "Style: ZH,Microsoft YaHei,38,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2.4,1,2,40,40,42,1",
  ].join("\n");

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const lines: string[] = [];
  for (const cue of subs) {
    const start = fmtAssTime(cue.time);
    const end = fmtAssTime(cue.endTime);

    if (opts.includeEnglish) {
      const text = buildLine(
        cue.text,
        opts.highlightKeyPhrases ? cue.highlightWords : [],
      );
      if (text.trim()) {
        lines.push(`Dialogue: 0,${start},${end},EN,,0,0,0,,${text}`);
      }
    }
    if (opts.includeChinese) {
      const zhPhrases = opts.highlightKeyPhrases
        ? cue.highlightWords
            .map((w) => cue.highlightTranslations[w])
            .filter((zh): zh is string => Boolean(zh))
        : [];
      const text = buildLine(cue.translation, zhPhrases);
      if (text.trim()) {
        lines.push(`Dialogue: 0,${start},${end},ZH,,0,0,0,,${text}`);
      }
    }
  }

  return `${header}\n${lines.join("\n")}\n`;
}

/**
 * Splice override tags around each phrase occurrence (left-to-right,
 * non-overlapping), then escape the result for ASS. The escape happens AFTER
 * splicing so override tags themselves are preserved verbatim.
 */
function buildLine(text: string, phrases: string[]): string {
  if (phrases.length === 0) return escapeAssText(text);

  // Place the same phrase only once; sort by first occurrence to mirror
  // SubtitleList's renderWithSpans algorithm.
  const seen = new Set<string>();
  const sorted = [...phrases]
    .filter((p) => {
      if (!p || seen.has(p)) return false;
      seen.add(p);
      return true;
    })
    .sort((a, b) => text.indexOf(a) - text.indexOf(b));

  // ASS yellow in BGR: 0xFFFF00 RGB → 0x00FFFF BGR. The `\r` resets to the
  // line's default style, so we don't have to know the parent style name.
  const ON = "{\\c&H00FFFF&}";
  const OFF = "{\\r}";

  const parts: string[] = [];
  let cursor = 0;
  for (const p of sorted) {
    const idx = text.indexOf(p, cursor);
    if (idx === -1) continue;
    if (idx > cursor) parts.push(escapeAssText(text.slice(cursor, idx)));
    parts.push(ON);
    parts.push(escapeAssText(p));
    parts.push(OFF);
    cursor = idx + p.length;
  }
  if (cursor < text.length) parts.push(escapeAssText(text.slice(cursor)));
  return parts.join("");
}
