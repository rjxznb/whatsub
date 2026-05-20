# Library Folders + Drag-to-Merge

Date: 2026-05-20
Scope: `client/` (Tauri desktop app)
Touches: `src/types/library.ts`, `src/store/library.ts`, `src/pages/Library.tsx`, plus new components for folder card / folder-open modal / merge animation; Rust `src-tauri/src/library.rs` + new commands

## Motivation

Library is currently a flat grid of video cards. Users with growing libraries want to group related videos (same series, same topic) without a flat scroll. macOS / iPad-style folder UX is familiar: drag one card almost-fully onto another to merge into a new folder, or drag one card onto an existing folder to add it. Single-level folders are enough to cover the common case.

## Non-goals

- Folder nesting (a folder cannot contain another folder)
- Multi-select drag (one card per drag)
- Dragging a video out of an open folder (right-click → 移出文件夹 instead — v2 candidate)
- Folder colors / custom icons / tags
- Auto-deleting empty folders or auto-unwrapping single-video folders

## Data model

`src/types/library.ts`:

```ts
export interface LibraryFolder {
  id: string;
  name: string;
  videoIds: string[];   // order of videos inside the folder
  createdAt: string;
}

export type LibraryItemRef =
  | { type: "video"; id: string }
  | { type: "folder"; id: string };

export interface Library {
  videos: LibraryEntry[];           // every video, regardless of folder
  folders: LibraryFolder[];         // every folder
  topLevelOrder: LibraryItemRef[];  // the top-level grid's display order
}
```

`LibraryEntry` is unchanged — no `parentFolderId` field. Membership is derived: a video is inside folder `F` iff `F.videoIds.includes(v.id)`. A video appears at the top level iff its id appears as `{type: "video", id}` in `topLevelOrder`.

**Invariants** (enforced in Rust before write, defensive client-side):
1. Every video id appears either in some `folder.videoIds` or in `topLevelOrder` — exactly once.
2. Every folder id appears in `topLevelOrder` exactly once.
3. No video id appears in more than one folder's `videoIds`.
4. No id appears twice in any single list.

## Backward compatibility

Existing `library.json` only has `videos[]`. On read:
- If `folders` field missing → default `[]`.
- If `topLevelOrder` missing → derive `videos.map(v => ({type: "video", id: v.id}))`.
- After first write, structure is upgraded permanently.

No data migration needed — videos themselves are untouched.

## Rust commands

Five new Tauri commands added to `src-tauri/src/library.rs`, registered in `tauri::generate_handler!` in lib.rs. Each command:
1. Reads `library.json` into the new struct shape.
2. Mutates in memory.
3. Validates invariants (above) — returns `Err` if broken.
4. Writes back atomically (`.tmp` + rename).
5. Returns the new state (or partial result like `folder_id` for `create_folder`).

```rust
create_folder(name: Option<String>) -> Result<String>     // returns folder_id
delete_folder(folder_id: String) -> Result<()>
rename_folder(folder_id: String, name: String) -> Result<()>
move_video_to_folder(
  video_id: String,
  target_folder_id: Option<String>,   // None = move to top level
  insert_at: Option<usize>,           // position inside target list; None = end
) -> Result<()>
merge_into_folder(
  video_ids: Vec<String>,             // must be ≥ 2; first becomes idx 0
  name: Option<String>,               // None = "新建文件夹"
) -> Result<String>                   // returns folder_id
```

Existing `reorder(ids: Vec<String>)` command is generalized to accept `LibraryItemRef[]` for the top-level order. Old `ids: string[]` signature retained as a compatibility wrapper — converts to refs.

Empty folder created by `create_folder` is appended to the end of `topLevelOrder`. Caller (frontend) can then call the generalized `reorder` if a different position is desired.

`merge_into_folder` semantics: removes the source video ids from `topLevelOrder` AND from any other folder, creates new folder containing them in given order, inserts the new folder at the position of the **first** source video in the original top-level order. If the source video was inside a folder (rare — only via future "drag-into-existing-folder" if we add that), insertion falls back to end of top level.

## UI structure

### Top-level grid

`Library.tsx` rendering loop changes from iterating `library.videos.filter(...)` to iterating `library.topLevelOrder`, dispatching on `ref.type`:

```tsx
{library.topLevelOrder.map(ref =>
  ref.type === "video"
    ? <VideoCard key={ref.id} entry={lookupVideo(ref.id)} ... />
    : <FolderCard key={ref.id} folder={lookupFolder(ref.id)} videos={folderVideos(ref.id)} ... />
)}
```

`VideoCard` is extracted from the inline JSX in `Library.tsx` (it's already large enough to deserve its own component). `FolderCard` is new.

Search filtering still applies — when search is non-empty, the grid flattens to all matching videos (top-level + inside folders), folder grouping ignored during search. Folder mode resumes when search clears.

### FolderCard

```
┌──────────────┐
│ ┌──┐ ┌──┐    │  ← 2×2 thumbnail mosaic of folder.videoIds[0..4]
│ └──┘ └──┘    │     (missing slots = zinc-800 placeholder)
│ ┌──┐ ┌──┐    │
│ └──┘ └──┘    │
│              │
│ 文件夹名    7 │  ← name + count badge
└──────────────┘
```

Same outer size + aspect as VideoCard for grid alignment. Click → open folder modal. Right-click → context menu (重命名 / 删除文件夹).

### Folder-open modal (iPad-style)

Click on FolderCard triggers:

1. Render a portal-mounted `<FolderOpenView>` at `position: fixed inset-0 z-50`.
2. Backdrop layer: `bg-black/60 backdrop-blur-md`, opacity animates 0 → 1 over 250ms.
3. The clicked FolderCard's `getBoundingClientRect()` is captured. The modal card starts at that rect with `transform: scale(1)`, then animates to a centered larger rect (e.g. 80vw × 70vh) using `transform: translate + scale` over 300ms ease-out.
4. After scale completes, the folder name header + inner video grid fade in (150ms).
5. Inside the modal, videos are rendered as smaller VideoCards in a grid. Click → play (same as top-level). Right-click → context menu including `移出文件夹`.
6. Close: click backdrop or press Esc → reverse animation (300ms), unmount.

Animation uses only CSS `transform` + `opacity` transitions (no framer-motion).

State for open folder lives in `Library.tsx`: `const [openFolderId, setOpenFolderId] = useState<string | null>(null)` plus a ref to the originating card for return-position animation.

### Drag-and-drop

Extends existing `Library.tsx` handlers (`onDragStart` / `onDragOver` / `onDrop`).

**Overlap math** (in `onDragOver`):

```ts
function overlapRatio(dragRect: DOMRect, targetRect: DOMRect): number {
  const xOverlap = Math.max(0, Math.min(dragRect.right, targetRect.right) - Math.max(dragRect.left, targetRect.left));
  const yOverlap = Math.max(0, Math.min(dragRect.bottom, targetRect.bottom) - Math.max(dragRect.top, targetRect.top));
  const intersection = xOverlap * yOverlap;
  const dragArea = dragRect.width * dragRect.height;
  return dragArea > 0 ? intersection / dragArea : 0;
}
```

`dragRect` is computed as the dragged card's original `getBoundingClientRect()` translated by the mouse delta from `dragStart` (HTML5 D&D doesn't give us a live position of the drag image, but `e.clientX/Y` minus the dragstart x/y gives the offset; apply to the original rect).

**Drop mode resolution**:

```ts
type DropMode = "reorder" | "merge" | "add";

function resolveDropMode(
  sourceType: "video" | "folder",
  targetType: "video" | "folder",
  overlap: number,
): DropMode {
  // Folders cannot merge with anything (no nesting), and a video cannot be
  // "merged into" a folder — only added. Anything that would otherwise hit
  // these dead-ends falls back to reorder.
  if (overlap >= 0.9) {
    if (sourceType === "video" && targetType === "video") return "merge";
    if (sourceType === "video" && targetType === "folder") return "add";
    // folder→folder, folder→video at high overlap: fall through to reorder
  }
  return "reorder";
}
```

Stored as state: `{ targetId, mode }` (or null when no valid target).

Folder cards are also draggable — they participate in reorder against any top-level cell, but can't merge or be added-into.

**Visual feedback during drag**:

- All three modes: target gets a colored ring + an additional cue.
  - `reorder` → ring-blue-400/60 + a thin vertical blue bar overlaid at target's left edge (the future insertion point)
  - `merge` → ring-amber-400 + a small folder mini-icon overlaid at target's top-right corner
  - `add` → ring-amber-400 + slight scale-105 of target (the folder "expands to welcome" the dropped video)
- No live shifting of surrounding cards during drag — only after drop. (Live row-shifting across a 2/3/4-column grid creates wrap-around layout glitches not worth fixing for v1.)

**On drop**:

```ts
async function onDrop() {
  const { targetId, mode } = dragOver;
  if (!sourceId || !targetId) return;
  switch (mode) {
    case "reorder":
      // Move source ref to target's position in topLevelOrder
      await reorderTopLevel(buildNewOrder(sourceId, targetId));
      break;
    case "add":
      // target is a folder
      await moveVideoToFolder(sourceId, targetId);
      break;
    case "merge":
      // both source and target are videos
      await runMergeAnimation(sourceId, targetId);
      // ↑ shows the blue-folder pop animation, then calls merge_into_folder,
      //   then triggers rename dialog
      break;
  }
}
```

### Merge animation (blue folder pop)

When mode is `merge` and drop occurs:

1. Capture both card `getBoundingClientRect()`s.
2. Compute midpoint between them.
3. Mount a portal `<MergeAnimationLayer>` with `position: fixed inset-0 pointer-events-none z-40`.
4. Inside, render two clone divs at the captured rects (using `position: fixed` + `style={{ left, top, width, height }}`), each with a CSS class that triggers a 3-phase keyframe animation:
   - **Phase A (0-300ms)**: clones scale 1 → 0.55, translate toward midpoint, opacity stays 1 → 0.8 (ease-out)
   - **Phase B (300-550ms)**: a blue folder svg/element at midpoint, `transform: scale(0) → scale(1)` with bounce ease, color `bg-blue-500`. Clones continue shrinking, opacity 0.8 → 0.
   - **Phase C (550-750ms)**: blue folder gently settles (scale 1 → 0.95 → 1 micro-bounce), clones fully gone.
5. At 750ms: call `merge_into_folder([sourceId, targetId])`, await new folder_id.
6. On success: reload library, unmount animation layer, open RenameDialog seeded with "新建文件夹" + folder_id.
7. On failure: alert error, reload to recover, unmount.

Single CSS `@keyframes` definition per phase, kept in `src/index.css` alongside other custom keyframes. The blue folder uses a simple JSX shape (rounded rectangle + small tab on top) styled to match macOS Finder blue. No PNG asset needed.

### Right-click menus

Extends existing `ContextMenu`:

- **Empty grid area** (click on the grid container background, not on a card):
  - `新建文件夹` → calls `create_folder()`, reloads, immediately opens RenameDialog for the new folder.
- **Folder card**:
  - `重命名` → RenameDialog
  - `删除文件夹` → confirm-modal-less delete (contained videos return to end of top-level)
- **Video inside open folder modal**:
  - existing video menu items
  - extra: `移出文件夹` → calls `move_video_to_folder(v_id, null)`, video returns to top level

Right-click on empty grid area requires a new `onContextMenu` on the grid container that only fires when target is the container itself (`e.target === e.currentTarget`).

## Rename dialog reuse

`RenameDialog` currently renames a `LibraryEntry`. Generalize it to accept `{ initialName, onConfirm: (name: string) => Promise<void> }` so it can rename both videos and folders. Existing call sites updated.

## Testing

Vitest + @testing-library/react cases:

- `overlapRatio` pure-function tests: edge cases (no overlap, full overlap, partial, source larger than target).
- `mergeIntoFolder` Rust unit test: invariants hold after merge (video gone from top-level, folder created with correct ids, position correct).
- `move_video_to_folder` Rust unit test: top-level → folder, folder → folder (rare for v1 but tested), folder → top-level.
- `delete_folder` Rust unit test: contained videos appear at end of top-level.
- React render test for `FolderCard`: shows 2×2 mosaic, count badge, fallback placeholders.
- React render test for grid: mixed top-level (video, folder, video) renders in correct order.
- React behavior test for drop mode resolution: overlap 0.5 → reorder, 0.95 → merge, etc.

Manual UI walkthrough (dev-mode checklist):
- Drag-merge two videos → folder created with both → rename dialog appears → confirm → folder shows with new name
- Drag a third video onto the folder card (≥90%) → folder count goes from 2 to 3
- Drag a video onto the folder card with <50% overlap → reorder (folder card shifts)
- Click folder → iPad-style open animation → grid of inside videos
- Right-click empty area → 新建文件夹 → empty folder created → renames
- Right-click folder → 删除文件夹 → folder gone, contents at end of top-level
- Right-click video in folder → 移出文件夹 → returns to top-level end
- Existing reorder still works (drag with <90% overlap)
- Restart app → state preserved

## Out of scope / v2 candidates

- Drag video out of open folder
- Folder thumbnail customization
- Folder colors / labels
- Multi-select drag (select with shift-click, drag multiple)
- Search inside a folder (top-bar search currently flattens; could add folder-scoped search)
- Folder sort options (by date, name)
- Subfolders
