import type { SrtCue } from "./types";

export function parseSrt(content: string): SrtCue[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n").filter((b) => b.trim().length > 0);
  const cues: SrtCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 3) continue;
    const index = parseInt(lines[0].trim(), 10);
    if (isNaN(index)) continue;
    const tc = parseTimecodeLine(lines[1]);
    if (!tc) continue;
    const text = lines.slice(2).join(" ").trim();
    cues.push({ index, time: tc.time, endTime: tc.endTime, text });
  }

  return mergeWhisperRepeats(cues);
}

/** Merge only contiguous Whisper repeats; repeats later in a video stay intact. */
function mergeWhisperRepeats(cues: SrtCue[]): SrtCue[] {
  const out: SrtCue[] = [];
  let i = 0;
  while (i < cues.length) {
    const first = cues[i];
    const exactKey = normalizeCueText(first.text, false);
    const looseKey = normalizeCueText(first.text, true);
    let end = i + 1;
    while (end < cues.length && isAdjacent(cues[end - 1], cues[end])) {
      const exact = normalizeCueText(cues[end].text, false) === exactKey;
      const loose = normalizeCueText(cues[end].text, true) === looseKey;
      if (!exact && !loose) break;
      end += 1;
    }
    const runLength = end - i;
    if (runLength >= 2 && (looseKey === exactKey || runLength >= 3)) {
      out.push({ ...first, endTime: cues[end - 1].endTime });
      i = end;
      continue;
    }
    out.push(first);
    i += 1;
  }
  return out;
}

function isAdjacent(a: SrtCue, b: SrtCue): boolean {
  return b.time >= a.endTime - 0.05 && b.time - a.endTime <= 0.35;
}

function normalizeCueText(text: string, loose: boolean): string {
  let value = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (loose) value = value.replace(/^(and|but|so|well)\s+/i, "");
  return value.replace(/[^a-z0-9']+/g, " ").trim();
}

function parseTimecodeLine(line: string): { time: number; endTime: number } | null {
  const parts = line.split("-->");
  if (parts.length !== 2) return null;
  const time = parseTimecode(parts[0].trim());
  const endTime = parseTimecode(parts[1].trim());
  if (time === null || endTime === null) return null;
  return { time, endTime };
}

function parseTimecode(t: string): number | null {
  const normalized = t.replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length !== 3) return null;
  const h = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const s = parseFloat(parts[2]);
  if ([h, m, s].some(isNaN)) return null;
  return h * 3600 + m * 60 + s;
}
