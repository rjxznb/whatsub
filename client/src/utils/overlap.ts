export type DropMode = "reorder" | "merge" | "add";

/** Overlap area between two rects, normalized by the dragged rect's area.
 *  Returns 0 if either rect is degenerate or there is no intersection. */
export function overlapRatio(dragRect: DOMRect, targetRect: DOMRect): number {
  const xOverlap = Math.max(
    0,
    Math.min(dragRect.right, targetRect.right) - Math.max(dragRect.left, targetRect.left)
  );
  const yOverlap = Math.max(
    0,
    Math.min(dragRect.bottom, targetRect.bottom) - Math.max(dragRect.top, targetRect.top)
  );
  const intersection = xOverlap * yOverlap;
  const dragArea = dragRect.width * dragRect.height;
  return dragArea > 0 ? intersection / dragArea : 0;
}

/** Overlap ratio at/above which a drop counts as "fully on top" rather than
 *  "slid past the edge" — i.e. triggers merge/add instead of reorder. */
export const MERGE_THRESHOLD = 0.7;

/** What happens if the user drops `source` on `target` with this much overlap?
 *  Folders cannot be merged or nested, so folder sources / folder-target merge
 *  attempts fall back to reorder. */
export function resolveDropMode(
  sourceType: "video" | "folder",
  targetType: "video" | "folder",
  overlap: number
): DropMode {
  if (overlap >= MERGE_THRESHOLD) {
    if (sourceType === "video" && targetType === "video") return "merge";
    if (sourceType === "video" && targetType === "folder") return "add";
  }
  return "reorder";
}
