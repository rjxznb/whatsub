import type { Subtitle } from "../llm/types";

function pad(n: number, len: number) {
  return n.toString().padStart(len, "0");
}

export function formatSrtTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

export function subtitlesToSrt(subs: Subtitle[], lang: "en" | "zh"): string {
  return subs
    .map((c, i) => {
      const text = (lang === "en" ? c.text : c.translation) ?? "";
      return `${i + 1}\n${formatSrtTime(c.time)} --> ${formatSrtTime(c.endTime)}\n${text}\n`;
    })
    .join("\n");
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "subtitle";
}
