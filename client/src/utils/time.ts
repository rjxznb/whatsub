export function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0)
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Editable timestamp format: "m:ss.ms" (no hour) or "h:mm:ss.ms" (with hour). */
export function formatEditTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad2 = (n: number) => n.toString().padStart(2, "0");
  const pad3 = (n: number) => n.toString().padStart(3, "0");
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
  return `${m}:${pad2(s)}.${pad3(ms)}`;
}

/** Parse "m:ss[.ms]" or "h:mm:ss[.ms]" or plain seconds. Returns null on garbage. */
export function parseEditTime(input: string): number | null {
  const str = input.trim();
  if (!str) return null;
  const parts = str.split(":");
  if (parts.length < 1 || parts.length > 3) return null;
  const nums = parts.map((p) => parseFloat(p));
  if (nums.some((n) => Number.isNaN(n) || n < 0)) return null;
  if (nums.length === 1) return nums[0];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  return nums[0] * 3600 + nums[1] * 60 + nums[2];
}
