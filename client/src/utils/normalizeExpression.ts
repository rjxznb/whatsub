const EDGE_PUNCT = /^[\s,.!?;:"'(){}[\]]+|[\s,.!?;:"'(){}[\]]+$/g;

/**
 * Trim whitespace and edge punctuation from a user selection. Internal
 * apostrophes and hyphens (can't, state-of-the-art) are preserved. Multiple
 * internal spaces collapse to one.
 */
export function normalizeExpression(raw: string): string {
  return raw.replace(EDGE_PUNCT, "").replace(/\s+/g, " ");
}
