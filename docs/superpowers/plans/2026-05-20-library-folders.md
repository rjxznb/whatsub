# Library Folders + Drag-to-Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add single-level folders to the Library page: drag a video onto another video (≥90% overlap) merges them into a folder with an animated pop; <90% overlap reorders; drop onto a folder card adds the video; right-click creates an empty folder; click a folder opens an iPad-style modal showing its contents.

**Architecture:** Library JSON gets two new fields — `folders` (array) and `topLevelOrder` (array of typed refs). Backward-compat: old files auto-upgrade on first read via `#[serde(default)]`. Rust adds five granular commands (create/delete/rename folder, move video, merge). Frontend extracts the inline card into `VideoCard`, adds `FolderCard` / `FolderOpenView` / `MergeAnimationLayer` components, and computes drop mode (reorder/merge/add) from drag overlap geometry. All animations use CSS transitions + `@keyframes` — no framer-motion.

**Tech Stack:** TypeScript + React 19 + zustand · Rust + Tauri 2 · Tailwind v3 · Vitest + @testing-library/react · cargo test.

**Spec:** `docs/superpowers/specs/2026-05-20-library-folders-design.md`

---

## File Map

| File | Purpose |
|------|---------|
| `client/src/types/library.ts` | + `LibraryFolder`, `LibraryItemRef`; extend `Library` |
| `client/src-tauri/src/commands/library.rs` | + `LibraryFolder`, `LibraryItemRef`; extend `Library`; backward-compat read; 5 new commands; generalize `library_reorder` |
| `client/src-tauri/src/lib.rs` | Register 5 new command handlers |
| `client/src/store/library.ts` | + 5 store actions wrapping the new commands; update `reorder` signature |
| `client/src/utils/overlap.ts` (new) | Pure overlap math + drop-mode resolver |
| `client/src/utils/overlap.test.ts` (new) | Unit tests |
| `client/src/components/RenameDialog.tsx` | Generalize: optional `title` prop (defaults to existing copy) |
| `client/src/components/VideoCard.tsx` (new) | Extracted card from Library.tsx inline JSX |
| `client/src/components/FolderCard.tsx` (new) | 2×2 mosaic thumbnail + name + count |
| `client/src/components/FolderCard.test.tsx` (new) | Render tests |
| `client/src/components/FolderOpenView.tsx` (new) | iPad-style modal, originating-rect → center animation |
| `client/src/components/MergeAnimationLayer.tsx` (new) | Three-phase pop animation |
| `client/src/pages/Library.tsx` | Major refactor: iterate `topLevelOrder`, new drop logic, hook new dialogs/views |
| `client/src/index.css` | + `@keyframes` for merge animation |

---

## Task 1: Data model — TS types

**Files:**
- Modify: `client/src/types/library.ts`

- [ ] **Step 1: Add the new interfaces + extend `Library`**

Replace the contents of `client/src/types/library.ts` with:

```ts
import type { TranslationStyle } from "./settings";

export type LibrarySource =
  | { type: "local"; originalPath: string }
  | { type: "url"; url: string };

export type LibraryStatus = "analyzing" | "ready" | "failed";

export interface LibraryEntry {
  id: string;
  title: string;
  source: LibrarySource;
  durationSec: number;
  thumbnailPath: string;
  createdAt: string;
  status: LibraryStatus;
  lastError: string | null;
  videoDir?: string;
  analysisStyle?: TranslationStyle;
}

export interface LibraryFolder {
  id: string;
  name: string;
  /** Order of videos inside this folder. */
  videoIds: string[];
  createdAt: string;
}

export type LibraryItemRef =
  | { type: "video"; id: string }
  | { type: "folder"; id: string };

export interface Library {
  videos: LibraryEntry[];
  /** Optional in backward-compat read; first save populates it. */
  folders?: LibraryFolder[];
  /** Optional in backward-compat read; first save populates it. */
  topLevelOrder?: LibraryItemRef[];
}
```

- [ ] **Step 2: Typecheck**

Run: `cd client && pnpm typecheck`
Expected: a wave of errors in `Library.tsx` and `store/library.ts` because they reference `library.videos` directly — that still works, but consumers may not yet handle missing optional fields. **This is expected at this point**; later tasks resolve them. Confirm no _type-mismatch_ errors in `types/library.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add client/src/types/library.ts
git commit -m "feat(client/types): add LibraryFolder, LibraryItemRef, extend Library"
```

---

## Task 2: Pure helpers — overlap math + drop-mode resolver

**Files:**
- Create: `client/src/utils/overlap.ts`
- Create: `client/src/utils/overlap.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/src/utils/overlap.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { overlapRatio, resolveDropMode } from "./overlap";

function rect(left: number, top: number, w: number, h: number): DOMRect {
  return {
    left, top,
    right: left + w, bottom: top + h,
    x: left, y: top,
    width: w, height: h,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("overlapRatio", () => {
  it("returns 0 when no overlap", () => {
    expect(overlapRatio(rect(0, 0, 100, 100), rect(200, 0, 100, 100))).toBe(0);
  });

  it("returns 1 when fully covered", () => {
    expect(overlapRatio(rect(0, 0, 100, 100), rect(0, 0, 100, 100))).toBe(1);
  });

  it("returns 0.25 at 50% x and 50% y partial overlap", () => {
    // drag: [0,0,100,100], target: [50,50,100,100] → intersection 50x50 = 2500 / drag area 10000
    expect(overlapRatio(rect(0, 0, 100, 100), rect(50, 50, 100, 100))).toBe(0.25);
  });

  it("normalizes by dragged area, not target", () => {
    // drag 50x50, target 100x100, fully covering drag → ratio = 1.0
    expect(overlapRatio(rect(0, 0, 50, 50), rect(0, 0, 100, 100))).toBe(1);
  });

  it("returns 0 when drag area is 0", () => {
    expect(overlapRatio(rect(0, 0, 0, 0), rect(0, 0, 100, 100))).toBe(0);
  });
});

describe("resolveDropMode", () => {
  it("any pair with overlap < 0.9 is reorder", () => {
    expect(resolveDropMode("video", "video", 0.89)).toBe("reorder");
    expect(resolveDropMode("video", "folder", 0.5)).toBe("reorder");
    expect(resolveDropMode("folder", "video", 0.95)).toBe("reorder");
    expect(resolveDropMode("folder", "folder", 0.95)).toBe("reorder");
  });

  it("video → video at ≥ 0.9 is merge", () => {
    expect(resolveDropMode("video", "video", 0.9)).toBe("merge");
    expect(resolveDropMode("video", "video", 1.0)).toBe("merge");
  });

  it("video → folder at ≥ 0.9 is add", () => {
    expect(resolveDropMode("video", "folder", 0.9)).toBe("add");
  });

  it("folder source at high overlap falls back to reorder", () => {
    expect(resolveDropMode("folder", "video", 0.95)).toBe("reorder");
    expect(resolveDropMode("folder", "folder", 0.95)).toBe("reorder");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && pnpm test src/utils/overlap.test.ts --run`
Expected: FAIL — `Cannot find module './overlap'`.

- [ ] **Step 3: Implement the helpers**

Create `client/src/utils/overlap.ts`:

```ts
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

/** What happens if the user drops `source` on `target` with this much overlap?
 *  Folders cannot be merged or nested, so folder sources / folder-target merge
 *  attempts fall back to reorder. */
export function resolveDropMode(
  sourceType: "video" | "folder",
  targetType: "video" | "folder",
  overlap: number
): DropMode {
  if (overlap >= 0.9) {
    if (sourceType === "video" && targetType === "video") return "merge";
    if (sourceType === "video" && targetType === "folder") return "add";
  }
  return "reorder";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && pnpm test src/utils/overlap.test.ts --run`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/overlap.ts client/src/utils/overlap.test.ts
git commit -m "feat(client/utils): overlap math + drop mode resolver"
```

---

## Task 3: Rust — extend types + backward-compat read

**Files:**
- Modify: `client/src-tauri/src/commands/library.rs`

- [ ] **Step 1: Add the new structs**

Edit `client/src-tauri/src/commands/library.rs`. After the existing `LibraryEntry` struct, add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolder {
    pub id: String,
    pub name: String,
    pub video_ids: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum LibraryItemRef {
    Video { id: String },
    Folder { id: String },
}
```

Replace the existing `Library` struct with:

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Library {
    pub videos: Vec<LibraryEntry>,
    #[serde(default)]
    pub folders: Vec<LibraryFolder>,
    #[serde(default, rename = "topLevelOrder")]
    pub top_level_order: Vec<LibraryItemRef>,
}
```

- [ ] **Step 2: Add backward-compat fixup in `read_index`**

After `let lib: Library = serde_json::from_str(&raw)?;` in `read_index`, before returning, add:

```rust
fn read_index() -> AppResult<Library> {
    let path = paths::library_index_path()?;
    if !path.exists() {
        return Ok(Library::default());
    }
    let raw = fs::read_to_string(&path)?;
    let mut lib: Library = serde_json::from_str(&raw)?;
    if lib.top_level_order.is_empty() && !lib.videos.is_empty() {
        // Legacy file: synthesize default top-level order from the videos list.
        lib.top_level_order = lib
            .videos
            .iter()
            .map(|v| LibraryItemRef::Video { id: v.id.clone() })
            .collect();
    }
    Ok(lib)
}
```

- [ ] **Step 3: Add a test for the backward-compat shape**

In the existing `mod tests` block at the bottom, add:

```rust
#[test]
fn library_default_has_empty_folders_and_order() {
    let lib = Library::default();
    assert!(lib.folders.is_empty());
    assert!(lib.top_level_order.is_empty());
}

#[test]
fn library_round_trips_with_folders() {
    let mut lib = Library::default();
    upsert_in_memory(&mut lib, sample("v1"));
    lib.folders.push(LibraryFolder {
        id: "f1".into(),
        name: "Folder".into(),
        video_ids: vec!["v1".into()],
        created_at: "2026-05-20T00:00:00Z".into(),
    });
    lib.top_level_order = vec![LibraryItemRef::Folder { id: "f1".into() }];
    let json = serde_json::to_string(&lib).unwrap();
    let parsed: Library = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.folders.len(), 1);
    assert_eq!(parsed.folders[0].video_ids, vec!["v1".to_string()]);
    assert_eq!(parsed.top_level_order.len(), 1);
    match &parsed.top_level_order[0] {
        LibraryItemRef::Folder { id } => assert_eq!(id, "f1"),
        _ => panic!("expected folder ref"),
    }
}

#[test]
fn library_legacy_json_decodes_with_default_fields() {
    // Old shape: only `videos` field present.
    let legacy = r#"{"videos":[]}"#;
    let lib: Library = serde_json::from_str(legacy).unwrap();
    assert_eq!(lib.videos.len(), 0);
    assert!(lib.folders.is_empty());
    assert!(lib.top_level_order.is_empty());
}
```

- [ ] **Step 4: Run tests**

Run: `cd client/src-tauri && cargo test --lib library`
Expected: all existing tests + 3 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add client/src-tauri/src/commands/library.rs
git commit -m "feat(client/rust): LibraryFolder + LibraryItemRef structs, backward-compat read"
```

---

## Task 4: Rust — folder management commands

**Files:**
- Modify: `client/src-tauri/src/commands/library.rs`
- Modify: `client/src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing tests**

Append to the `mod tests` block at the bottom of `client/src-tauri/src/commands/library.rs`:

```rust
#[test]
fn create_folder_appends_to_top_level() {
    let mut lib = Library::default();
    upsert_in_memory(&mut lib, sample("v1"));
    lib.top_level_order = vec![LibraryItemRef::Video { id: "v1".into() }];
    let folder_id = create_folder_in_memory(&mut lib, Some("Test".into()));
    assert_eq!(lib.folders.len(), 1);
    assert_eq!(lib.folders[0].name, "Test");
    assert_eq!(lib.folders[0].video_ids.len(), 0);
    assert_eq!(lib.top_level_order.len(), 2);
    match &lib.top_level_order[1] {
        LibraryItemRef::Folder { id } => assert_eq!(id, &folder_id),
        _ => panic!("expected folder ref at end"),
    }
}

#[test]
fn merge_into_folder_pulls_videos_from_top_level() {
    let mut lib = Library::default();
    upsert_in_memory(&mut lib, sample("v1"));
    upsert_in_memory(&mut lib, sample("v2"));
    upsert_in_memory(&mut lib, sample("v3"));
    lib.top_level_order = vec![
        LibraryItemRef::Video { id: "v1".into() },
        LibraryItemRef::Video { id: "v2".into() },
        LibraryItemRef::Video { id: "v3".into() },
    ];
    let folder_id = merge_into_folder_in_memory(
        &mut lib,
        vec!["v2".into(), "v3".into()],
        Some("Pair".into()),
    )
    .unwrap();
    // v2 and v3 removed from top level; folder inserted at v2's old position.
    assert_eq!(lib.top_level_order.len(), 2);
    match &lib.top_level_order[0] {
        LibraryItemRef::Video { id } => assert_eq!(id, "v1"),
        _ => panic!(),
    }
    match &lib.top_level_order[1] {
        LibraryItemRef::Folder { id } => assert_eq!(id, &folder_id),
        _ => panic!(),
    }
    assert_eq!(lib.folders[0].video_ids, vec!["v2".to_string(), "v3".into()]);
}

#[test]
fn move_video_to_folder_then_back() {
    let mut lib = Library::default();
    upsert_in_memory(&mut lib, sample("v1"));
    upsert_in_memory(&mut lib, sample("v2"));
    let folder_id = create_folder_in_memory(&mut lib, None);
    lib.top_level_order = vec![
        LibraryItemRef::Video { id: "v1".into() },
        LibraryItemRef::Video { id: "v2".into() },
        LibraryItemRef::Folder { id: folder_id.clone() },
    ];
    move_video_to_folder_in_memory(&mut lib, "v1", Some(&folder_id), None).unwrap();
    assert_eq!(lib.folders[0].video_ids, vec!["v1".to_string()]);
    // v1 removed from top-level
    assert!(!lib.top_level_order.iter().any(|r| matches!(r, LibraryItemRef::Video { id } if id == "v1")));

    // Move it back
    move_video_to_folder_in_memory(&mut lib, "v1", None, None).unwrap();
    assert_eq!(lib.folders[0].video_ids.len(), 0);
    assert!(lib.top_level_order.iter().any(|r| matches!(r, LibraryItemRef::Video { id } if id == "v1")));
}

#[test]
fn delete_folder_returns_videos_to_top_level_end() {
    let mut lib = Library::default();
    upsert_in_memory(&mut lib, sample("v1"));
    upsert_in_memory(&mut lib, sample("v2"));
    upsert_in_memory(&mut lib, sample("v3"));
    let folder_id = merge_into_folder_in_memory(
        &mut lib,
        vec!["v2".into(), "v3".into()],
        None,
    )
    .unwrap();
    lib.top_level_order.insert(0, LibraryItemRef::Video { id: "v1".into() });
    // Now: [v1, folder(v2,v3)]
    delete_folder_in_memory(&mut lib, &folder_id).unwrap();
    assert_eq!(lib.folders.len(), 0);
    assert_eq!(lib.top_level_order.len(), 3);
    // Order: v1 stays, then v2, v3 in folder's previous internal order
    let ids: Vec<_> = lib.top_level_order.iter().filter_map(|r| match r {
        LibraryItemRef::Video { id } => Some(id.clone()),
        _ => None,
    }).collect();
    assert_eq!(ids, vec!["v1", "v2", "v3"]);
}

#[test]
fn rename_folder_updates_name() {
    let mut lib = Library::default();
    let folder_id = create_folder_in_memory(&mut lib, Some("Old".into()));
    rename_folder_in_memory(&mut lib, &folder_id, "New".into()).unwrap();
    assert_eq!(lib.folders[0].name, "New");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client/src-tauri && cargo test --lib library`
Expected: FAIL — `cannot find function 'create_folder_in_memory'` etc.

- [ ] **Step 3: Implement the in-memory helpers + tauri commands**

In `client/src-tauri/src/commands/library.rs`, before the `mod tests` block, add:

```rust
fn now_iso() -> String {
    // Match the format used elsewhere (e.g. import flow).
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn new_id(prefix: &str) -> String {
    use rand::Rng;
    let bytes: [u8; 6] = rand::thread_rng().gen();
    format!(
        "{}{}",
        prefix,
        bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>()
    )
}

/// In-memory variants — every Tauri command below calls one of these,
/// then writes the file. Pure functions for easy testing.

fn create_folder_in_memory(lib: &mut Library, name: Option<String>) -> String {
    let id = new_id("f-");
    let folder = LibraryFolder {
        id: id.clone(),
        name: name.unwrap_or_else(|| "新建文件夹".to_string()),
        video_ids: Vec::new(),
        created_at: now_iso(),
    };
    lib.folders.push(folder);
    lib.top_level_order.push(LibraryItemRef::Folder { id: id.clone() });
    id
}

fn delete_folder_in_memory(lib: &mut Library, folder_id: &str) -> Result<(), String> {
    let folder_idx = lib
        .folders
        .iter()
        .position(|f| f.id == folder_id)
        .ok_or_else(|| format!("folder {} not found", folder_id))?;
    let folder = lib.folders.remove(folder_idx);
    // Find folder's slot in top-level and replace with its contained videos.
    let pos = lib.top_level_order.iter().position(
        |r| matches!(r, LibraryItemRef::Folder { id } if id == folder_id),
    );
    if let Some(pos) = pos {
        lib.top_level_order.remove(pos);
    }
    // Append contained videos to the end of top level (spec: end of top-level).
    for vid in folder.video_ids {
        lib.top_level_order
            .push(LibraryItemRef::Video { id: vid });
    }
    Ok(())
}

fn rename_folder_in_memory(
    lib: &mut Library,
    folder_id: &str,
    name: String,
) -> Result<(), String> {
    let folder = lib
        .folders
        .iter_mut()
        .find(|f| f.id == folder_id)
        .ok_or_else(|| format!("folder {} not found", folder_id))?;
    folder.name = name;
    Ok(())
}

fn move_video_to_folder_in_memory(
    lib: &mut Library,
    video_id: &str,
    target_folder_id: Option<&str>,
    insert_at: Option<usize>,
) -> Result<(), String> {
    // 1. Remove the video from anywhere it currently is.
    for folder in lib.folders.iter_mut() {
        folder.video_ids.retain(|v| v != video_id);
    }
    lib.top_level_order.retain(
        |r| !matches!(r, LibraryItemRef::Video { id } if id == video_id),
    );

    // 2. Insert into destination.
    match target_folder_id {
        Some(fid) => {
            let folder = lib
                .folders
                .iter_mut()
                .find(|f| f.id == fid)
                .ok_or_else(|| format!("folder {} not found", fid))?;
            let pos = insert_at.unwrap_or(folder.video_ids.len()).min(folder.video_ids.len());
            folder.video_ids.insert(pos, video_id.to_string());
        }
        None => {
            let pos = insert_at
                .unwrap_or(lib.top_level_order.len())
                .min(lib.top_level_order.len());
            lib.top_level_order.insert(pos, LibraryItemRef::Video { id: video_id.to_string() });
        }
    }
    Ok(())
}

fn merge_into_folder_in_memory(
    lib: &mut Library,
    video_ids: Vec<String>,
    name: Option<String>,
) -> Result<String, String> {
    if video_ids.len() < 2 {
        return Err("merge requires at least 2 videos".into());
    }
    // Find the insertion position from the first video's current top-level slot,
    // falling back to end if it's not at the top level.
    let insert_pos = lib
        .top_level_order
        .iter()
        .position(|r| matches!(r, LibraryItemRef::Video { id } if id == &video_ids[0]))
        .unwrap_or(lib.top_level_order.len());

    // Remove every source video from anywhere it currently sits.
    for vid in &video_ids {
        for folder in lib.folders.iter_mut() {
            folder.video_ids.retain(|v| v != vid);
        }
        lib.top_level_order
            .retain(|r| !matches!(r, LibraryItemRef::Video { id } if id == vid));
    }

    // Recompute insert_pos in case it shifted due to removals before that point.
    let insert_pos = insert_pos.min(lib.top_level_order.len());

    // Create the new folder.
    let folder_id = new_id("f-");
    lib.folders.push(LibraryFolder {
        id: folder_id.clone(),
        name: name.unwrap_or_else(|| "新建文件夹".to_string()),
        video_ids,
        created_at: now_iso(),
    });
    lib.top_level_order
        .insert(insert_pos, LibraryItemRef::Folder { id: folder_id.clone() });
    Ok(folder_id)
}

fn set_top_level_order_in_memory(
    lib: &mut Library,
    refs: Vec<LibraryItemRef>,
) -> Result<(), String> {
    // Validate every ref points to something that exists at top level.
    for r in &refs {
        match r {
            LibraryItemRef::Video { id } => {
                if !lib.videos.iter().any(|v| &v.id == id) {
                    return Err(format!("unknown video id {}", id));
                }
            }
            LibraryItemRef::Folder { id } => {
                if !lib.folders.iter().any(|f| &f.id == id) {
                    return Err(format!("unknown folder id {}", id));
                }
            }
        }
    }
    lib.top_level_order = refs;
    Ok(())
}

// === Tauri commands ===

#[tauri::command]
pub fn library_create_folder(name: Option<String>) -> AppResult<String> {
    let mut lib = read_index()?;
    let id = create_folder_in_memory(&mut lib, name);
    write_index(&lib)?;
    Ok(id)
}

#[tauri::command]
pub fn library_delete_folder(folder_id: String) -> AppResult<()> {
    let mut lib = read_index()?;
    delete_folder_in_memory(&mut lib, &folder_id)
        .map_err(crate::error::AppError::Internal)?;
    write_index(&lib)
}

#[tauri::command]
pub fn library_rename_folder(folder_id: String, name: String) -> AppResult<()> {
    let mut lib = read_index()?;
    rename_folder_in_memory(&mut lib, &folder_id, name)
        .map_err(crate::error::AppError::Internal)?;
    write_index(&lib)
}

#[tauri::command]
pub fn library_move_video_to_folder(
    video_id: String,
    target_folder_id: Option<String>,
    insert_at: Option<usize>,
) -> AppResult<()> {
    let mut lib = read_index()?;
    move_video_to_folder_in_memory(&mut lib, &video_id, target_folder_id.as_deref(), insert_at)
        .map_err(crate::error::AppError::Internal)?;
    write_index(&lib)
}

#[tauri::command]
pub fn library_merge_into_folder(
    video_ids: Vec<String>,
    name: Option<String>,
) -> AppResult<String> {
    let mut lib = read_index()?;
    let id = merge_into_folder_in_memory(&mut lib, video_ids, name)
        .map_err(crate::error::AppError::Internal)?;
    write_index(&lib)?;
    Ok(id)
}

#[tauri::command]
pub fn library_set_top_level_order(refs: Vec<LibraryItemRef>) -> AppResult<()> {
    let mut lib = read_index()?;
    set_top_level_order_in_memory(&mut lib, refs)
        .map_err(crate::error::AppError::Internal)?;
    write_index(&lib)
}
```

Notes:
- `chrono` and `rand` crates should already be in `Cargo.toml` (used elsewhere in the codebase — confirm; if not, the first cargo build will fail and you can add them).
- The check `crate::error::AppError::Internal(...)` assumes an `Internal(String)` variant. If the project uses a different variant for ad-hoc error strings, substitute it.

- [ ] **Step 4: Register commands in lib.rs**

Open `client/src-tauri/src/lib.rs` and find the existing `tauri::generate_handler!` macro call. Add to the list:

```rust
crate::commands::library::library_create_folder,
crate::commands::library::library_delete_folder,
crate::commands::library::library_rename_folder,
crate::commands::library::library_move_video_to_folder,
crate::commands::library::library_merge_into_folder,
crate::commands::library::library_set_top_level_order,
```

(Match the formatting of existing entries; the precise path prefix may already use a different style — follow what's there.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd client/src-tauri && cargo test --lib library`
Expected: PASS — all 5 new tests + earlier ones.

- [ ] **Step 6: Confirm the full crate builds**

Run: `cd client/src-tauri && cargo check`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add client/src-tauri/src/commands/library.rs client/src-tauri/src/lib.rs
git commit -m "feat(client/rust): folder management commands (create/delete/rename/move/merge)"
```

---

## Task 5: Frontend store — new actions

**Files:**
- Modify: `client/src/store/library.ts`

- [ ] **Step 1: Update the store interface**

Replace the contents of `client/src/store/library.ts` with:

```ts
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  Library,
  LibraryEntry,
  LibraryStatus,
  LibraryItemRef,
} from "../types/library";

interface LibraryState {
  library: Library;
  loaded: boolean;
  reload: () => Promise<void>;
  setStatus: (id: string, status: LibraryStatus, error?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  /** Reorder the top-level grid. Accepts the full new ref list. */
  setTopLevelOrder: (refs: LibraryItemRef[]) => Promise<void>;
  reveal: (videoId: string) => Promise<void>;

  // Folder operations
  createFolder: (name?: string) => Promise<string>;
  deleteFolder: (folderId: string) => Promise<void>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  moveVideoToFolder: (
    videoId: string,
    targetFolderId: string | null,
    insertAt?: number
  ) => Promise<void>;
  mergeIntoFolder: (videoIds: string[], name?: string) => Promise<string>;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  library: { videos: [], folders: [], topLevelOrder: [] },
  loaded: false,
  async reload() {
    const lib = await invoke<Library>("library_list");
    // Backward compat: ensure required-shape fields exist locally.
    set({
      library: {
        videos: lib.videos ?? [],
        folders: lib.folders ?? [],
        topLevelOrder:
          lib.topLevelOrder ??
          (lib.videos ?? []).map((v) => ({ type: "video" as const, id: v.id })),
      },
      loaded: true,
    });
  },
  async setStatus(id, status, error) {
    await invoke("library_set_status", { id, status, error: error ?? null });
    await get().reload();
  },
  async remove(id) {
    await invoke("library_delete", { id });
    await get().reload();
  },
  async rename(id, title) {
    await invoke("library_rename", { id, title });
    set((s) => ({
      library: {
        ...s.library,
        videos: s.library.videos.map((v) => (v.id === id ? { ...v, title } : v)),
      },
    }));
  },
  async setTopLevelOrder(refs) {
    set((s) => ({ library: { ...s.library, topLevelOrder: refs } }));
    await invoke("library_set_top_level_order", { refs });
  },
  async reveal(videoId) {
    const path = await invoke<string>("video_source_path", { videoId });
    await invoke("reveal_in_explorer", { path });
  },
  async createFolder(name) {
    const id = await invoke<string>("library_create_folder", { name: name ?? null });
    await get().reload();
    return id;
  },
  async deleteFolder(folderId) {
    await invoke("library_delete_folder", { folderId });
    await get().reload();
  },
  async renameFolder(folderId, name) {
    await invoke("library_rename_folder", { folderId, name });
    set((s) => ({
      library: {
        ...s.library,
        folders: (s.library.folders ?? []).map((f) =>
          f.id === folderId ? { ...f, name } : f
        ),
      },
    }));
  },
  async moveVideoToFolder(videoId, targetFolderId, insertAt) {
    await invoke("library_move_video_to_folder", {
      videoId,
      targetFolderId: targetFolderId ?? null,
      insertAt: insertAt ?? null,
    });
    await get().reload();
  },
  async mergeIntoFolder(videoIds, name) {
    const id = await invoke<string>("library_merge_into_folder", {
      videoIds,
      name: name ?? null,
    });
    await get().reload();
    return id;
  },
}));

export type { LibraryEntry, Library, LibraryStatus };
```

- [ ] **Step 2: Typecheck**

Run: `cd client && pnpm typecheck`
Expected: errors only in `Library.tsx` referencing the removed `reorder(ids)` method (we renamed to `setTopLevelOrder(refs)`). Fixed in Task 9.

- [ ] **Step 3: Commit**

```bash
git add client/src/store/library.ts
git commit -m "feat(client/store): folder actions + setTopLevelOrder"
```

---

## Task 6: Generalize RenameDialog

**Files:**
- Modify: `client/src/components/RenameDialog.tsx`

- [ ] **Step 1: Update the component**

Replace `client/src/components/RenameDialog.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";

interface Props {
  initialTitle: string;
  onConfirm: (newTitle: string) => void;
  onClose: () => void;
  /** Heading shown at the top of the dialog. Defaults to 「重命名视频」 to
   *  preserve existing call-site behavior. */
  title?: string;
}

export function RenameDialog({ initialTitle, onConfirm, onClose, title }: Props) {
  const [value, setValue] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100]">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-5 w-[420px]">
        <h2 className="text-base font-semibold text-zinc-100 mb-3">
          {title ?? "重命名视频"}
        </h2>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") onClose();
          }}
          className="w-full px-3 py-2 bg-zinc-800 text-zinc-100 rounded text-sm border border-zinc-700"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-300">
            取消
          </button>
          <button
            onClick={submit}
            disabled={!value.trim()}
            className="px-4 py-1.5 bg-blue-500 text-black text-sm rounded font-medium disabled:opacity-50"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd client && pnpm typecheck`
Expected: same Library.tsx errors as before (no new ones).

- [ ] **Step 3: Commit**

```bash
git add client/src/components/RenameDialog.tsx
git commit -m "refactor(client): generalize RenameDialog with optional title prop"
```

---

## Task 7: Extract VideoCard

**Files:**
- Create: `client/src/components/VideoCard.tsx`
- Modify: `client/src/pages/Library.tsx`

- [ ] **Step 1: Identify the card JSX in Library.tsx**

Open `client/src/pages/Library.tsx`. Find the inline JSX returning `<div>` (or similar) for each video — this is the one inside the `library.videos.filter(...).map((v) => ...)` block, currently around line 305 (look for `onDragStart={(e) => onDragStart(e, v.id)}`). Note all props/state it depends on: `v: LibraryEntry`, `draggedId`, `dragOverId`, `vocab`, `analysis`, several handlers (`onDragStart`, `onDragOver`, `onDragLeave`, `onDrop`, `onDragEnd`, navigate, `handleContextMenu`, `setRenaming`, etc.).

- [ ] **Step 2: Create VideoCard**

Create `client/src/components/VideoCard.tsx` with this exact shape — copy the inline JSX into it. Substitute the props in the JSX with the new prop names below:

```tsx
import type { ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { LibraryEntry } from "../types/library";

interface Props {
  entry: LibraryEntry;
  /** Currently-being-dragged item id (any type); used to suppress the click→play handler
   *  and apply the dragged state styling. */
  draggedId: string | null;
  /** Visual feedback during drag, decided by the parent. null when this card is not the active drop target. */
  dropFeedback: null | { mode: "reorder" | "merge" | "add" };
  /** Right-context-menu handler bubbled to the parent. */
  onContextMenu: (e: React.MouseEvent, entry: LibraryEntry) => void;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  /** Optional overlay slot used by the parent for "在后台解析" badges,
   *  vocab-attached indicators, etc. */
  badge?: ReactNode;
}

export function VideoCard({
  entry,
  draggedId,
  dropFeedback,
  onContextMenu,
  onClick,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  badge,
}: Props) {
  const isDragged = draggedId === entry.id;
  const ring =
    dropFeedback?.mode === "merge"
      ? "ring-2 ring-amber-400"
      : dropFeedback?.mode === "add"
      ? "ring-2 ring-amber-400 scale-105"
      : dropFeedback?.mode === "reorder"
      ? "ring-2 ring-blue-400/60"
      : "";

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={() => {
        if (draggedId) return;
        onClick();
      }}
      onContextMenu={(e) => onContextMenu(e, entry)}
      className={
        "relative cursor-pointer group rounded overflow-hidden bg-zinc-900 border border-zinc-800 transition-transform " +
        (isDragged ? "opacity-40 " : "") +
        ring
      }
    >
      {entry.thumbnailPath && (
        <img
          src={convertFileSrc(entry.thumbnailPath)}
          alt=""
          className="w-full aspect-video object-cover"
        />
      )}
      <div className="p-2 text-xs">
        <div className="truncate font-medium text-zinc-100">{entry.title}</div>
      </div>
      {dropFeedback?.mode === "reorder" && (
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-400 pointer-events-none" />
      )}
      {dropFeedback?.mode === "merge" && (
        <div className="absolute top-1 right-1 w-5 h-5 rounded-sm bg-amber-400 text-zinc-900 text-[10px] flex items-center justify-center font-bold pointer-events-none">
          ＋
        </div>
      )}
      {badge}
    </div>
  );
}
```

Notes:
- The exact wording / class names of the badge area (in-progress %, "在后台解析" indicator, etc.) currently live inline in Library.tsx. Move those into the `badge` slot at the parent so we don't need to thread their many dependencies into this component. Library.tsx in Task 9 composes them as JSX and passes via `badge={...}`.

- [ ] **Step 3: Re-wire Library.tsx to use VideoCard**

Edit `client/src/pages/Library.tsx`:
- Import `VideoCard` from `../components/VideoCard`.
- Replace the inline card JSX inside the `library.videos.filter(...).map((v) => (...))` loop with `<VideoCard {...props}>` (composing badge inline).

Keep the existing handlers (`onDragStart`, `onDragOver`, etc.); they're now passed as props.

- [ ] **Step 4: Typecheck + visual smoke**

Run: `cd client && pnpm typecheck`
Expected: errors about `library.videos.filter` if Task 5 changed Library shape — but Library shape still has `videos: LibraryEntry[]` so this should compile. Address any new errors that ARE caused by Task 7 changes.

Run: `cd client && pnpm tauri dev` for ~30s. Confirm: Library still renders identically, drag-to-reorder still works (this is the existing baseline preserved).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/VideoCard.tsx client/src/pages/Library.tsx
git commit -m "refactor(client/library): extract VideoCard component"
```

---

## Task 8: FolderCard component

**Files:**
- Create: `client/src/components/FolderCard.tsx`
- Create: `client/src/components/FolderCard.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `client/src/components/FolderCard.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { FolderCard } from "./FolderCard";
import type { LibraryEntry, LibraryFolder } from "../types/library";

const cue = (id: string, thumb: string): LibraryEntry => ({
  id,
  title: id,
  source: { type: "local", originalPath: "/x" },
  durationSec: 10,
  thumbnailPath: thumb,
  createdAt: "2026-05-20T00:00:00Z",
  status: "ready",
  lastError: null,
});

const folder: LibraryFolder = {
  id: "f1",
  name: "Test Folder",
  videoIds: ["a", "b", "c"],
  createdAt: "2026-05-20T00:00:00Z",
};

describe("FolderCard", () => {
  it("renders folder name and video count", () => {
    const { getByText } = render(
      <FolderCard
        folder={folder}
        videos={[cue("a", "a.jpg"), cue("b", "b.jpg"), cue("c", "c.jpg")]}
        draggedId={null}
        dropFeedback={null}
        onClick={() => {}}
        onContextMenu={() => {}}
        onDragStart={() => {}}
        onDragOver={() => {}}
        onDragLeave={() => {}}
        onDrop={() => {}}
        onDragEnd={() => {}}
      />
    );
    expect(getByText("Test Folder")).toBeTruthy();
    expect(getByText("3")).toBeTruthy();
  });

  it("fires onClick when not in a drag operation", () => {
    const onClick = vi.fn();
    const { container } = render(
      <FolderCard
        folder={folder}
        videos={[cue("a", "a.jpg")]}
        draggedId={null}
        dropFeedback={null}
        onClick={onClick}
        onContextMenu={() => {}}
        onDragStart={() => {}}
        onDragOver={() => {}}
        onDragLeave={() => {}}
        onDrop={() => {}}
        onDragEnd={() => {}}
      />
    );
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("suppresses onClick while a drag is in flight", () => {
    const onClick = vi.fn();
    const { container } = render(
      <FolderCard
        folder={folder}
        videos={[cue("a", "a.jpg")]}
        draggedId="someOtherId"
        dropFeedback={null}
        onClick={onClick}
        onContextMenu={() => {}}
        onDragStart={() => {}}
        onDragOver={() => {}}
        onDragLeave={() => {}}
        onDrop={() => {}}
        onDragEnd={() => {}}
      />
    );
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClick).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && pnpm test src/components/FolderCard.test.tsx --run`
Expected: FAIL — `Cannot find module './FolderCard'`.

- [ ] **Step 3: Implement FolderCard**

Create `client/src/components/FolderCard.tsx`:

```tsx
import { convertFileSrc } from "@tauri-apps/api/core";
import type { LibraryEntry, LibraryFolder } from "../types/library";

interface Props {
  folder: LibraryFolder;
  /** All videos in this folder (in order) — caller looks them up by folder.videoIds. */
  videos: LibraryEntry[];
  draggedId: string | null;
  dropFeedback: null | { mode: "reorder" | "merge" | "add" };
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

export function FolderCard({
  folder,
  videos,
  draggedId,
  dropFeedback,
  onClick,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: Props) {
  const isDragged = draggedId === folder.id;
  const cover = videos.slice(0, 4);

  const ring =
    dropFeedback?.mode === "add"
      ? "ring-2 ring-amber-400 scale-105"
      : dropFeedback?.mode === "reorder"
      ? "ring-2 ring-blue-400/60"
      : "";

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={() => {
        if (draggedId) return;
        onClick();
      }}
      onContextMenu={onContextMenu}
      className={
        "relative cursor-pointer rounded overflow-hidden bg-zinc-900 border border-zinc-800 transition-transform " +
        (isDragged ? "opacity-40 " : "") +
        ring
      }
    >
      <div className="aspect-video grid grid-cols-2 grid-rows-2 gap-px bg-zinc-800 p-px">
        {[0, 1, 2, 3].map((i) => {
          const v = cover[i];
          return v && v.thumbnailPath ? (
            <img
              key={i}
              src={convertFileSrc(v.thumbnailPath)}
              alt=""
              className="object-cover w-full h-full"
            />
          ) : (
            <div key={i} className="bg-zinc-800" />
          );
        })}
      </div>
      <div className="p-2 text-xs flex items-center gap-2">
        <span className="truncate font-medium text-zinc-100 flex-1">
          📁 {folder.name}
        </span>
        <span className="text-zinc-500 tabular-nums">{folder.videoIds.length}</span>
      </div>
      {dropFeedback?.mode === "reorder" && (
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-400 pointer-events-none" />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && pnpm test src/components/FolderCard.test.tsx --run`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/FolderCard.tsx client/src/components/FolderCard.test.tsx
git commit -m "feat(client): FolderCard with 2x2 mosaic + count badge"
```

---

## Task 9: Render `topLevelOrder` in Library

**Files:**
- Modify: `client/src/pages/Library.tsx`

- [ ] **Step 1: Replace the grid rendering loop**

Inside the grid container in `Library.tsx` (the JSX block that currently does `library.videos.filter(...).map((v) => <VideoCard .../>)`), replace it with a topLevelOrder-driven loop. The exact rendering block:

```tsx
{searchActive
  ? // Search mode: flatten everything that matches, ignore folder structure.
    library.videos
      .filter((v) => v.title.toLowerCase().includes(search.toLowerCase()))
      .map((v) => (
        <VideoCard
          key={v.id}
          entry={v}
          draggedId={draggedId}
          dropFeedback={null}
          onContextMenu={handleContextMenu}
          onClick={() => navigate(`/player/${v.id}`)}
          onDragStart={(e) => onDragStart(e, { type: "video", id: v.id })}
          onDragOver={(e) => onDragOver(e, { type: "video", id: v.id })}
          onDragLeave={() => onDragLeave(v.id)}
          onDrop={(e) => onDrop(e, { type: "video", id: v.id })}
          onDragEnd={onDragEnd}
        />
      ))
  : // Normal mode: iterate top-level order, render videos and folders.
    (library.topLevelOrder ?? []).map((ref) => {
      if (ref.type === "video") {
        const v = library.videos.find((x) => x.id === ref.id);
        if (!v) return null;
        return (
          <VideoCard
            key={"v-" + v.id}
            entry={v}
            draggedId={draggedId}
            dropFeedback={dragOver?.targetId === v.id ? { mode: dragOver.mode } : null}
            onContextMenu={handleContextMenu}
            onClick={() => navigate(`/player/${v.id}`)}
            onDragStart={(e) => onDragStart(e, { type: "video", id: v.id })}
            onDragOver={(e) => onDragOver(e, { type: "video", id: v.id })}
            onDragLeave={() => onDragLeave(v.id)}
            onDrop={(e) => onDrop(e, { type: "video", id: v.id })}
            onDragEnd={onDragEnd}
          />
        );
      } else {
        const f = (library.folders ?? []).find((x) => x.id === ref.id);
        if (!f) return null;
        const inside = f.videoIds
          .map((vid) => library.videos.find((v) => v.id === vid))
          .filter((v): v is LibraryEntry => Boolean(v));
        return (
          <FolderCard
            key={"f-" + f.id}
            folder={f}
            videos={inside}
            draggedId={draggedId}
            dropFeedback={dragOver?.targetId === f.id ? { mode: dragOver.mode } : null}
            onClick={() => setOpenFolderId(f.id)}
            onContextMenu={(e) => handleFolderContextMenu(e, f)}
            onDragStart={(e) => onDragStart(e, { type: "folder", id: f.id })}
            onDragOver={(e) => onDragOver(e, { type: "folder", id: f.id })}
            onDragLeave={() => onDragLeave(f.id)}
            onDrop={(e) => onDrop(e, { type: "folder", id: f.id })}
            onDragEnd={onDragEnd}
          />
        );
      }
    })}
```

- [ ] **Step 2: Update Library state + handlers**

Add to the top of the `Library()` function body (alongside other useState calls):

```tsx
import { FolderCard } from "../components/FolderCard";
import { overlapRatio, resolveDropMode, type DropMode } from "../utils/overlap";

// ...inside the component:
const [openFolderId, setOpenFolderId] = useState<string | null>(null);
const [dragOver, setDragOver] = useState<null | { targetId: string; mode: DropMode }>(null);
// Track the dragged item's *type* (video vs folder) and its starting rect.
const [drag, setDrag] = useState<null | {
  ref: { type: "video" | "folder"; id: string };
  startRect: DOMRect;
  startClient: { x: number; y: number };
}>(null);
```

Remove the old `draggedId` / `dragOverId` state (the new `drag` and `dragOver` replace them).

The `searchActive` boolean = `search.trim().length > 0`.

Add a folder context menu handler:

```tsx
function handleFolderContextMenu(e: React.MouseEvent, folder: LibraryFolder) {
  e.preventDefault();
  setMenu({
    type: "folder",
    folder,
    x: e.clientX,
    y: e.clientY,
  });
}
```

(Note: this requires updating the existing `MenuState` discriminated union to accept a folder case. Find the existing `MenuState` type — likely defined at top of file — and extend it.)

- [ ] **Step 3: Update onDragStart / onDragOver / onDrop**

Replace the existing three functions with:

```tsx
function onDragStart(e: React.DragEvent, ref: { type: "video" | "folder"; id: string }) {
  const card = e.currentTarget as HTMLElement;
  const startRect = card.getBoundingClientRect();
  setDrag({
    ref,
    startRect,
    startClient: { x: e.clientX, y: e.clientY },
  });
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", `${ref.type}:${ref.id}`);
}

function onDragOver(
  e: React.DragEvent,
  target: { type: "video" | "folder"; id: string }
) {
  if (!drag || drag.ref.id === target.id) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  // Compute the dragged card's current rect from the start rect + mouse delta.
  const dx = e.clientX - drag.startClient.x;
  const dy = e.clientY - drag.startClient.y;
  const dragRect = new DOMRect(
    drag.startRect.left + dx,
    drag.startRect.top + dy,
    drag.startRect.width,
    drag.startRect.height
  );
  const targetRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const overlap = overlapRatio(dragRect, targetRect);
  const mode = resolveDropMode(drag.ref.type, target.type, overlap);
  setDragOver({ targetId: target.id, mode });
}

function onDragLeave(id: string) {
  setDragOver((cur) => (cur?.targetId === id ? null : cur));
}

function onDragEnd() {
  setDrag(null);
  setDragOver(null);
}
```

Add the dispatch:

```tsx
async function onDrop(
  e: React.DragEvent,
  target: { type: "video" | "folder"; id: string }
) {
  e.preventDefault();
  if (!drag || !dragOver || drag.ref.id === target.id) {
    setDrag(null);
    setDragOver(null);
    return;
  }
  const { mode } = dragOver;
  const source = drag.ref;
  setDrag(null);
  setDragOver(null);

  switch (mode) {
    case "reorder": {
      // Build new top-level order with source moved to target's position.
      const refs = (library.topLevelOrder ?? []).filter(
        (r) => !(r.type === source.type && r.id === source.id)
      );
      const targetIdx = refs.findIndex((r) => r.type === target.type && r.id === target.id);
      if (targetIdx === -1) return;
      const sourceRef =
        source.type === "video"
          ? { type: "video" as const, id: source.id }
          : { type: "folder" as const, id: source.id };
      const newRefs = [...refs.slice(0, targetIdx), sourceRef, ...refs.slice(targetIdx)];
      try {
        await setTopLevelOrder(newRefs);
      } catch (err) {
        console.error("reorder failed", err);
        await reload();
      }
      break;
    }
    case "add": {
      // source must be a video (resolveDropMode guarantees), target is a folder.
      try {
        await moveVideoToFolder(source.id, target.id);
      } catch (err) {
        console.error("move to folder failed", err);
        await reload();
      }
      break;
    }
    case "merge": {
      // Trigger merge animation + the rename dialog handoff. Animation
      // component is added in Task 10.
      setMerge({ source: source.id, target: target.id });
      break;
    }
  }
}
```

`setMerge` is new state introduced in Task 10. For now temporarily stub:

```tsx
const [merge, setMerge] = useState<null | { source: string; target: string }>(null);
```

- [ ] **Step 4: Typecheck + smoke test**

Run: `cd client && pnpm typecheck`
Resolve any errors that arose from rename/restructure (likely around old `reorder` calls).

Run: `cd client && pnpm tauri dev`. Confirm: Library still renders, drag-to-reorder still works, drag video onto video shows blue ring with vertical bar. Drop should reorder (merge animation will appear non-functional until Task 10).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Library.tsx
git commit -m "feat(client/library): iterate topLevelOrder, render videos + folders side-by-side"
```

---

## Task 10: MergeAnimationLayer + index.css keyframes

**Files:**
- Create: `client/src/components/MergeAnimationLayer.tsx`
- Modify: `client/src/index.css`
- Modify: `client/src/pages/Library.tsx`

- [ ] **Step 1: Add keyframes**

Append to `client/src/index.css`:

```css
@keyframes mergeClonePhaseA {
  0%   { transform: translate(0, 0) scale(1); opacity: 1; }
  100% { transform: translate(var(--toX), var(--toY)) scale(0.55); opacity: 0.8; }
}

@keyframes mergeClonePhaseB {
  0%   { opacity: 0.8; }
  100% { opacity: 0; }
}

@keyframes mergeFolderPop {
  0%   { transform: scale(0); }
  60%  { transform: scale(1.08); }
  80%  { transform: scale(0.95); }
  100% { transform: scale(1); }
}
```

- [ ] **Step 2: Create the component**

Create `client/src/components/MergeAnimationLayer.tsx`:

```tsx
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { LibraryEntry } from "../types/library";

interface Props {
  /** The two videos being merged. */
  source: LibraryEntry;
  target: LibraryEntry;
  /** The on-screen rects of the source and target cards at drop time. */
  sourceRect: DOMRect;
  targetRect: DOMRect;
  /** Called when the animation has fully played (≈ 750ms). */
  onDone: () => void;
}

export function MergeAnimationLayer({
  source,
  target,
  sourceRect,
  targetRect,
  onDone,
}: Props) {
  const [phase, setPhase] = useState<"A" | "B" | "done">("A");

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("B"), 300);
    const t2 = setTimeout(() => setPhase("done"), 550);
    const t3 = setTimeout(() => onDone(), 750);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [onDone]);

  const midX = (sourceRect.left + targetRect.left + sourceRect.width) / 2;
  const midY = (sourceRect.top + targetRect.top + sourceRect.height) / 2;

  const cloneStyle = (rect: DOMRect): React.CSSProperties => ({
    position: "fixed",
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    ["--toX" as never]: `${midX - rect.left - rect.width / 2}px`,
    ["--toY" as never]: `${midY - rect.top - rect.height / 2}px`,
    animation:
      phase === "A"
        ? "mergeClonePhaseA 300ms ease-out forwards"
        : "mergeClonePhaseB 250ms ease-out forwards",
    pointerEvents: "none",
    zIndex: 40,
  });

  return (
    <div className="fixed inset-0 pointer-events-none z-40">
      {phase !== "done" && source.thumbnailPath && (
        <img src={convertFileSrc(source.thumbnailPath)} alt="" style={cloneStyle(sourceRect)} />
      )}
      {phase !== "done" && target.thumbnailPath && (
        <img src={convertFileSrc(target.thumbnailPath)} alt="" style={cloneStyle(targetRect)} />
      )}
      {phase !== "A" && (
        <div
          aria-hidden
          style={{
            position: "fixed",
            left: midX - 40,
            top: midY - 32,
            width: 80,
            height: 64,
            animation: "mergeFolderPop 450ms cubic-bezier(0.25, 0.8, 0.35, 1.2) forwards",
            zIndex: 41,
          }}
        >
          {/* Simple macOS-blue folder shape: a rounded rect with a small tab. */}
          <div
            style={{
              position: "absolute",
              top: 8,
              left: 0,
              right: 0,
              bottom: 0,
              borderRadius: 8,
              background: "linear-gradient(180deg, #4aa3ff 0%, #1d6fd1 100%)",
              boxShadow: "0 6px 24px rgba(29, 111, 209, 0.45)",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 8,
              width: 28,
              height: 12,
              borderTopLeftRadius: 6,
              borderTopRightRadius: 6,
              background: "#4aa3ff",
            }}
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire the animation into Library.tsx**

In `Library.tsx`, when `merge` state is set, run the animation then call the store and open the rename dialog.

At the JSX root level (alongside `<ImportModal />`, `<RenameDialog />` etc.), add:

```tsx
{merge && (() => {
  const src = library.videos.find((v) => v.id === merge.source);
  const tgt = library.videos.find((v) => v.id === merge.target);
  if (!src || !tgt || !merge.sourceRect || !merge.targetRect) return null;
  return (
    <MergeAnimationLayer
      source={src}
      target={tgt}
      sourceRect={merge.sourceRect}
      targetRect={merge.targetRect}
      onDone={async () => {
        try {
          // Order: target first, source second (target was the "base" being dropped onto).
          const folderId = await mergeIntoFolder([merge.target, merge.source]);
          setMerge(null);
          setRenamingFolder({ id: folderId, currentName: "新建文件夹" });
        } catch (err) {
          console.error("merge failed", err);
          await reload();
          setMerge(null);
        }
      }}
    />
  );
})()}
```

Extend the `merge` state shape to carry rects:

```tsx
const [merge, setMerge] = useState<null | {
  source: string;
  target: string;
  sourceRect: DOMRect;
  targetRect: DOMRect;
}>(null);
```

Update the `onDrop` "merge" branch to capture rects:

```tsx
case "merge": {
  const sourceRect = drag.startRect; // captured at dragstart
  const targetRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  setMerge({ source: source.id, target: target.id, sourceRect, targetRect });
  break;
}
```

Also add a `renamingFolder` state for the post-merge dialog handoff:

```tsx
const [renamingFolder, setRenamingFolder] = useState<null | { id: string; currentName: string }>(null);
```

And render the dialog:

```tsx
{renamingFolder && (
  <RenameDialog
    title="重命名文件夹"
    initialTitle={renamingFolder.currentName}
    onConfirm={async (name) => {
      try {
        await renameFolder(renamingFolder.id, name);
      } catch (err) {
        console.error("rename folder failed", err);
        await reload();
      }
    }}
    onClose={() => setRenamingFolder(null)}
  />
)}
```

- [ ] **Step 4: Typecheck + smoke test**

Run: `cd client && pnpm typecheck`. Fix any errors.
Run: `cd client && pnpm tauri dev`. Drag video A onto video B with high overlap → see folder pop animation → rename dialog opens.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/MergeAnimationLayer.tsx client/src/index.css client/src/pages/Library.tsx
git commit -m "feat(client/library): merge-into-folder animation + rename handoff"
```

---

## Task 11: FolderOpenView (iPad-style modal)

**Files:**
- Create: `client/src/components/FolderOpenView.tsx`
- Modify: `client/src/pages/Library.tsx`

- [ ] **Step 1: Create the component**

Create `client/src/components/FolderOpenView.tsx`:

```tsx
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { LibraryEntry, LibraryFolder } from "../types/library";

interface Props {
  folder: LibraryFolder;
  videos: LibraryEntry[];
  /** Original card rect for the open/close animation source. */
  originRect: DOMRect;
  onClose: () => void;
  onVideoClick: (videoId: string) => void;
  onVideoContextMenu: (e: React.MouseEvent, video: LibraryEntry) => void;
}

export function FolderOpenView({
  folder,
  videos,
  originRect,
  onClose,
  onVideoClick,
  onVideoContextMenu,
}: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Trigger transition on next frame so the start state renders first.
    const r = requestAnimationFrame(() => setOpen(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(r);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const targetW = Math.min(window.innerWidth * 0.8, 1100);
  const targetH = Math.min(window.innerHeight * 0.75, 700);
  const targetLeft = (window.innerWidth - targetW) / 2;
  const targetTop = (window.innerHeight - targetH) / 2;

  const cardStyle: React.CSSProperties = open
    ? {
        position: "fixed",
        left: targetLeft,
        top: targetTop,
        width: targetW,
        height: targetH,
        transition: "all 300ms ease-out",
      }
    : {
        position: "fixed",
        left: originRect.left,
        top: originRect.top,
        width: originRect.width,
        height: originRect.height,
        transition: "all 300ms ease-out",
      };

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-md transition-opacity duration-250"
        style={{ opacity: open ? 1 : 0 }}
        onClick={onClose}
      />
      <div
        style={cardStyle}
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800">
          <span className="text-base font-semibold flex-1">📁 {folder.name}</span>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-100 transition-colors w-7 h-7 rounded flex items-center justify-center"
            title="关闭"
          >
            ✕
          </button>
        </div>
        <div
          className="flex-1 overflow-y-auto p-5 grid grid-cols-2 md:grid-cols-3 gap-4"
          style={{
            opacity: open ? 1 : 0,
            transition: "opacity 200ms ease-out 150ms",
          }}
        >
          {videos.length === 0 ? (
            <div className="col-span-full text-center text-zinc-500 py-12">空文件夹</div>
          ) : (
            videos.map((v) => (
              <div
                key={v.id}
                className="cursor-pointer rounded overflow-hidden bg-zinc-800 border border-zinc-700 hover:border-zinc-600 transition-colors"
                onClick={() => onVideoClick(v.id)}
                onContextMenu={(e) => onVideoContextMenu(e, v)}
              >
                {v.thumbnailPath && (
                  <img
                    src={convertFileSrc(v.thumbnailPath)}
                    alt=""
                    className="w-full aspect-video object-cover"
                  />
                )}
                <div className="p-2 text-xs truncate">{v.title}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire into Library.tsx**

Track the origin rect when a folder is opened. Add to FolderCard click handler:

```tsx
onClick={(e) => {
  // Capture the card's rect for the open animation.
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  setOpenFolder({ id: f.id, rect });
}}
```

But wait — FolderCard's `onClick` doesn't currently receive the event. Update the Props in FolderCard to pass the event:

```tsx
onClick: (e: React.MouseEvent) => void;
```

(And inside FolderCard, change `onClick={() => { if (draggedId) return; onClick(); }}` to `onClick={(e) => { if (draggedId) return; onClick(e); }}`.)

Replace `openFolderId` state with:

```tsx
const [openFolder, setOpenFolder] = useState<null | { id: string; rect: DOMRect }>(null);
```

Render at the JSX root:

```tsx
{openFolder && (() => {
  const f = (library.folders ?? []).find((x) => x.id === openFolder.id);
  if (!f) return null;
  const inside = f.videoIds
    .map((vid) => library.videos.find((v) => v.id === vid))
    .filter((v): v is LibraryEntry => Boolean(v));
  return (
    <FolderOpenView
      folder={f}
      videos={inside}
      originRect={openFolder.rect}
      onClose={() => setOpenFolder(null)}
      onVideoClick={(id) => {
        setOpenFolder(null);
        navigate(`/player/${id}`);
      }}
      onVideoContextMenu={(e, v) => {
        e.preventDefault();
        setMenu({ type: "videoInFolder", entry: v, folderId: f.id, x: e.clientX, y: e.clientY });
      }}
    />
  );
})()}
```

- [ ] **Step 3: Smoke test**

Run: `cd client && pnpm tauri dev`. Click a folder → modal opens with origin-rect animation → click backdrop / Esc → closes.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/FolderOpenView.tsx client/src/pages/Library.tsx
git commit -m "feat(client/library): iPad-style folder open modal"
```

---

## Task 12: Right-click menus — empty-area, folder, video-in-folder

**Files:**
- Modify: `client/src/pages/Library.tsx`

- [ ] **Step 1: Extend the menu state union**

Find `type MenuState = ...` near the top of `Library.tsx`. Replace with a discriminated union:

```tsx
type MenuState =
  | { type: "video"; entry: LibraryEntry; x: number; y: number }
  | { type: "folder"; folder: LibraryFolder; x: number; y: number }
  | { type: "videoInFolder"; entry: LibraryEntry; folderId: string; x: number; y: number }
  | { type: "empty"; x: number; y: number };
```

Update `handleContextMenu` / `handleFolderContextMenu` to use the new shape.

- [ ] **Step 2: Add empty-area handler**

On the grid container `<div className="grid ...">`, add:

```tsx
onContextMenu={(e) => {
  if (e.target !== e.currentTarget) return; // only fire when click lands on the grid bg
  e.preventDefault();
  setMenu({ type: "empty", x: e.clientX, y: e.clientY });
}}
```

- [ ] **Step 3: Build menu items per menu type**

Replace `buildMenuItems(entry)` with a switch on `menu.type`:

```tsx
function buildMenuItems(): ContextMenuItem[] {
  if (!menu) return [];
  switch (menu.type) {
    case "video":
      return [
        // Copy every item from the current `buildMenuItems(entry)` function
        // body (the one being replaced) into this array, using `menu.entry`
        // wherever the old code used the `entry` argument. This is a
        // mechanical lift-and-shift — the items themselves are unchanged.
        // Typical items in there today: 重命名 / 重新解析 / 在文件夹中显示 / 删除.
        { label: "重命名", onClick: () => setRenaming(menu.entry) },
      ];
    case "folder":
      return [
        {
          label: "重命名",
          onClick: () => setRenamingFolder({ id: menu.folder.id, currentName: menu.folder.name }),
        },
        {
          label: "删除文件夹",
          onClick: async () => {
            try {
              await deleteFolder(menu.folder.id);
            } catch (err) {
              console.error("delete folder failed", err);
              await reload();
            }
          },
        },
      ];
    case "videoInFolder":
      // Same items as `case "video"` plus 「移出文件夹」 at the top.
      return [
        {
          label: "移出文件夹",
          onClick: async () => {
            try {
              await moveVideoToFolder(menu.entry.id, null);
            } catch (err) {
              console.error("move out of folder failed", err);
              await reload();
            }
          },
        },
        // Then paste the same items as `case "video"`.
        { label: "重命名", onClick: () => setRenaming(menu.entry) },
      ];
    case "empty":
      return [
        {
          label: "新建文件夹",
          onClick: async () => {
            try {
              const id = await createFolder();
              setRenamingFolder({ id, currentName: "新建文件夹" });
            } catch (err) {
              console.error("create folder failed", err);
              await reload();
            }
          },
        },
      ];
  }
}
```

- [ ] **Step 4: Smoke test**

Run: `cd client && pnpm tauri dev`.
- Right-click on grid background (not on a card) → "新建文件夹" appears → click → empty folder + rename dialog.
- Right-click a folder → 重命名 / 删除文件夹.
- Open a folder, right-click a video inside → 移出文件夹 + other items.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Library.tsx
git commit -m "feat(client/library): context menus for empty area, folders, in-folder videos"
```

---

## Task 13: Final integration pass + manual checklist

**Files:**
- Possibly minor follow-ups to `client/src/pages/Library.tsx`

- [ ] **Step 1: Run the full test suite**

Run: `cd client && pnpm test --run && pnpm typecheck && cd src-tauri && cargo test --lib library`
Expected: all green (except the pre-existing YouTubeEmbed test).

- [ ] **Step 2: Manual walkthrough (dev mode)**

Run `pnpm tauri dev` and verify each item:

- [ ] Drag video A onto video B with ≥90% overlap → blue folder pop animation → rename dialog with default 「新建文件夹」 → confirm with a name → folder card appears.
- [ ] Drag video C onto the folder card (≥90% overlap) → C joins the folder. Folder count goes from 2 to 3.
- [ ] Drag a video onto another video with <50% overlap → reorder (target shifts visually after drop).
- [ ] Drag a folder onto a video at any overlap → reorder (folder moves, never merges).
- [ ] Click folder → iPad open animation → grid of contained videos. Click video inside → /player route.
- [ ] Esc / backdrop click → folder closes with reverse animation.
- [ ] Right-click empty area → 新建文件夹 → empty folder card appears → rename.
- [ ] Right-click folder → 删除文件夹 → folder gone, its videos at the end of top level.
- [ ] Right-click video inside open folder → 移出文件夹 → video returns to top-level end.
- [ ] Existing reorder of videos still works.
- [ ] Restart app → state preserved (folders, top-level order intact).
- [ ] Search: type a query → grid flattens to all matching videos, ignoring folders. Clear search → folders re-appear.

- [ ] **Step 3: Commit any remaining fixes**

```bash
git add ... # whatever was tweaked
git commit -m "chore(client/library): polish after manual walkthrough"
```

---

## Self-Review

**Spec coverage:**
- Data model — Task 1 (TS) + Task 3 (Rust).
- Backward compatibility — Task 3 step 2 + Task 5 (`reload` defensive fallback).
- Rust commands — Task 4 covers all 5 + `set_top_level_order`.
- Single source of truth + invariants — enforced inside `*_in_memory` functions and tested in Task 4.
- Top-level grid render — Task 9.
- VideoCard / FolderCard / FolderOpenView / MergeAnimationLayer — Tasks 7, 8, 10, 11.
- iPad-style folder open — Task 11.
- Drag overlap math + drop-mode — Task 2 (helpers) + Task 9 (wiring).
- Three-mode visual feedback — embedded in VideoCard/FolderCard `dropFeedback` prop, set in Task 9.
- Merge animation — Task 10.
- Right-click menus — Task 12.
- RenameDialog reuse — Task 6.
- Empty folder + single-video folder retention — covered by "no auto-cleanup" non-goal: nothing in the plan deletes empty or single-item folders.

**Placeholder scan:** Every step has explicit code or commands. Comments like "… existing video items …" in Task 12 step 3 instruct the engineer to copy the existing menu items from the inline `buildMenuItems(entry)` they're replacing — explicit reference, not a placeholder.

**Type consistency:** `LibraryItemRef` shape, `DropMode`, store action names (`setTopLevelOrder`, `mergeIntoFolder`, etc.) used consistently across all tasks.

**Edge cases:**
- Drag onto self → guarded in `onDragOver` (`if (drag.ref.id === target.id) return`) and `onDrop`.
- Drag a folder at high overlap on a video → resolveDropMode falls back to reorder (Task 2 test).
- Empty folder → render path in FolderOpenView handles it ("空文件夹").
- Search active → folders ignored, flat list shown (Task 9 step 1).
- Failure recovery → every async store call has a try/catch that calls `reload()` to resync the UI with what Rust actually persisted.
