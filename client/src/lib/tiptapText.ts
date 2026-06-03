// src/lib/tiptapText.ts
//
// Flatten a vocab note (TipTap JSON serialized as a string) to plain text, for
// sending as a corpus usageNote. Falls back to the raw string if it isn't JSON.

interface TiptapNode {
  type?: string;
  text?: string;
  content?: TiptapNode[];
}

export function tiptapToPlainText(note?: string | null): string {
  if (!note) return "";
  let doc: TiptapNode;
  try {
    doc = JSON.parse(note) as TiptapNode;
  } catch {
    return note.trim(); // already plain text
  }
  const parts: string[] = [];
  const walk = (n: TiptapNode) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.text === "string") parts.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (n.type === "paragraph" || n.type === "heading") parts.push("\n");
  };
  walk(doc);
  return parts.join("").replace(/\n{2,}/g, "\n").trim();
}
