// src/agent/mention.ts
//
// Pure helpers for "@" references in the chat input. The user types "@" to
// reference a Library video; the chosen videos become chips, and on send a
// machine-readable preamble anchors the agent to them (it then uses
// read_video_analysis / youtube_search / etc. around the referenced video).

export interface VideoRef {
  id: string;
  title: string;
}

/** If the text ends with an "@name" fragment being typed (after start or a
 *  space), return the query + the index of the "@" so it can be replaced.
 *  Null when there's no active mention at the end. */
export function atQueryAtEnd(text: string): { query: string; start: number } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text);
  if (!m) return null;
  const start = m.index + m[0].indexOf("@");
  return { query: m[2], start };
}

/** Machine-readable anchor lines prepended to the sent message for each ref. */
export function buildReferencePreamble(refs: VideoRef[]): string {
  if (!refs.length) return "";
  return refs
    .map((r) => `[引用·库视频] "${r.title}" (videoId=${r.id})`)
    .join("\n");
}

/** Compose the final message: reference preamble + the user's prompt. */
export function composeWithRefs(refs: VideoRef[], prompt: string): string {
  const pre = buildReferencePreamble(refs);
  const body = prompt.trim();
  if (!pre) return body;
  return body ? `${pre}\n\n${body}` : pre;
}
