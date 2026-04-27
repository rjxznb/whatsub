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

  return cues;
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
