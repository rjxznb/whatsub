/**
 * Extract a YouTube video ID from a URL string. Returns null for any URL
 * that doesn't match a known YouTube pattern. Used by the library-sync
 * UI to decide whether to enable the cloud ☁️ button (v1 only syncs
 * YouTube sources to keep backend storage tractable).
 *
 * Supported patterns:
 *   youtube.com/watch?v=ID         -> ID
 *   youtu.be/ID                    -> ID
 *   m.youtube.com/watch?v=ID       -> ID
 *   youtube.com/embed/ID           -> ID
 *   youtube.com/shorts/ID          -> ID
 *
 * Excluded (returns null):
 *   playlist URLs (no specific video)
 *   non-YouTube hosts (bilibili, etc.)
 *   anything that doesn't parse as URL
 */
export function extractYouTubeId(url: string): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const isYtHost =
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com");
  if (!isYtHost) return null;

  // youtu.be/ID
  if (host === "youtu.be") {
    const id = parsed.pathname.replace(/^\//, "");
    return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
  }
  // youtube.com/watch?v=ID
  if (parsed.pathname === "/watch") {
    const v = parsed.searchParams.get("v");
    return v && /^[A-Za-z0-9_-]{6,}$/.test(v) ? v : null;
  }
  // youtube.com/embed/ID  or  youtube.com/shorts/ID
  const m = parsed.pathname.match(/^\/(embed|shorts)\/([A-Za-z0-9_-]{6,})/);
  if (m) return m[2]!;
  return null;
}
