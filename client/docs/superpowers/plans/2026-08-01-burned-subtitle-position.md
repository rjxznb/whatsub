# Burned Subtitle Position Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make burned-in subtitle export inherit the bilingual caption block's current session-only drag displacement.

**Architecture:** Keep `Player` as the owner of temporary pixel offsets and pass those offsets plus the current video element viewport to `ExportVideoModal`. The modal normalizes the geometry before calling the ASS builder, which converts the normalized displacement to PlayRes units and adds the same delta to the existing English and Chinese bottom-center anchors.

**Tech Stack:** React 19, TypeScript 5.8, Vitest, Testing Library, ASS/libass, Tauri 2.

## Global Constraints

- Caption position remains session-only and resets when `Player` remounts.
- Zero or invalid viewport dimensions must preserve the current default burned-subtitle position.
- A zero displacement must preserve current ASS output and emit no explicit `\\pos` override.
- English and Chinese must move by the same delta while retaining their existing 48-PlayRes-unit vertical separation.
- Export without selected subtitles remains a stream copy.
- Do not modify Rust or ffmpeg arguments.
- Do not change caption typography, colors, highlighting, drag behavior, or Picture-in-Picture behavior.

---

## File Structure

- Modify `src/utils/ass.ts`: own normalized caption position types, viewport normalization, and ASS position-tag generation.
- Modify `src/utils/ass.test.ts`: verify normalization, fallback behavior, PlayRes scaling, and bilingual spacing.
- Modify `src/components/ExportVideoModal.tsx`: accept the session pixel offset plus player viewport, normalize them, and supply the result to `subtitlesToAss`.
- Create `src/components/ExportVideoModal.test.tsx`: verify the modal sends position-aware ASS content to the existing Rust command.
- Modify `src/pages/Player.tsx`: pass the current temporary drag offset and current video element dimensions to the modal.
- Create `src/pages/Player.captionExport.test.ts`: verify the Player export adapter preserves the session offset and reads the current video viewport.

---

### Task 1: Normalize drag displacement and render it in ASS

**Files:**
- Modify: `src/utils/ass.ts`
- Test: `src/utils/ass.test.ts`

**Interfaces:**
- Produces: `AssCaptionPosition { xRatio: number; yRatio: number }`
- Produces: `normalizeCaptionOffset(offsetX: number, offsetY: number, viewportWidth: number, viewportHeight: number): AssCaptionPosition`
- Extends: `AssBuildOptions.captionPosition?: AssCaptionPosition`
- Consumes: existing ASS PlayRes defaults (`1280x720`) and style margins (`EN=90`, `ZH=42`).

- [ ] **Step 1: Write failing normalization tests**

Add these cases to `src/utils/ass.test.ts`:

```ts
import { normalizeCaptionOffset, subtitlesToAss } from "./ass";

it("normalizes player pixel displacement against the current viewport", () => {
  expect(normalizeCaptionOffset(128, -72, 1280, 720)).toEqual({
    xRatio: 0.1,
    yRatio: -0.1,
  });
});

it.each([
  [10, 20, 0, 720],
  [10, 20, 1280, 0],
  [Number.NaN, 20, 1280, 720],
  [10, Number.POSITIVE_INFINITY, 1280, 720],
])("falls back to zero displacement for invalid geometry", (x, y, width, height) => {
  expect(normalizeCaptionOffset(x, y, width, height)).toEqual({
    xRatio: 0,
    yRatio: 0,
  });
});
```

- [ ] **Step 2: Run the normalization tests and verify RED**

Run:

```powershell
pnpm test -- src/utils/ass.test.ts
```

Expected: FAIL because `normalizeCaptionOffset` is not exported.

- [ ] **Step 3: Add the minimal normalized-position interface and helper**

Add to `src/utils/ass.ts`:

```ts
export interface AssCaptionPosition {
  xRatio: number;
  yRatio: number;
}

const ZERO_CAPTION_POSITION: AssCaptionPosition = { xRatio: 0, yRatio: 0 };

export function normalizeCaptionOffset(
  offsetX: number,
  offsetY: number,
  viewportWidth: number,
  viewportHeight: number,
): AssCaptionPosition {
  if (
    !Number.isFinite(offsetX) ||
    !Number.isFinite(offsetY) ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return ZERO_CAPTION_POSITION;
  }
  return {
    xRatio: offsetX / viewportWidth,
    yRatio: offsetY / viewportHeight,
  };
}
```

- [ ] **Step 4: Run the normalization tests and verify GREEN**

Run:

```powershell
pnpm test -- src/utils/ass.test.ts
```

Expected: all existing and new normalization tests PASS.

- [ ] **Step 5: Write failing ASS-position tests**

Add these cases to `src/utils/ass.test.ts`:

```ts
it("keeps default ASS events free of explicit position overrides", () => {
  const out = subtitlesToAss([cue()], {
    includeEnglish: true,
    includeChinese: true,
    highlightKeyPhrases: false,
    captionPosition: { xRatio: 0, yRatio: 0 },
  });
  expect(out).not.toContain("\\pos(");
});

it("scales one normalized displacement into both ASS language anchors", () => {
  const out = subtitlesToAss([cue()], {
    includeEnglish: true,
    includeChinese: true,
    highlightKeyPhrases: false,
    playResX: 1920,
    playResY: 1080,
    captionPosition: { xRatio: 0.1, yRatio: -0.2 },
  });
  expect(out).toContain(",EN,,0,0,0,,{\\pos(1152,774)}hello world");
  expect(out).toContain(",ZH,,0,0,0,,{\\pos(1152,822)}");
});
```

The expected anchors are `x=960+192`, `EN y=(1080-90)-216=774`, and `ZH y=(1080-42)-216=822`.

- [ ] **Step 6: Run the ASS-position tests and verify RED**

Run:

```powershell
pnpm test -- src/utils/ass.test.ts
```

Expected: FAIL because `captionPosition` is not part of `AssBuildOptions` and no `\\pos` tags are emitted.

- [ ] **Step 7: Implement minimal ASS position overrides**

Extend `AssBuildOptions`:

```ts
captionPosition?: AssCaptionPosition;
```

Add a private helper:

```ts
function positionOverride(
  position: AssCaptionPosition | undefined,
  playResX: number,
  playResY: number,
  marginV: number,
): string {
  if (
    !position ||
    !Number.isFinite(position.xRatio) ||
    !Number.isFinite(position.yRatio) ||
    (position.xRatio === 0 && position.yRatio === 0)
  ) {
    return "";
  }
  const x = Math.round(playResX / 2 + position.xRatio * playResX);
  const y = Math.round(playResY - marginV + position.yRatio * playResY);
  return `{\\pos(${x},${y})}`;
}
```

Inside `subtitlesToAss`, compute `enPosition` with margin `90` and `zhPosition` with margin `42`, then prefix the corresponding `buildLine(...)` result in each Dialogue row. Do not emit a prefix when the helper returns an empty string.

```ts
const enPosition = positionOverride(
  opts.captionPosition,
  playResX,
  playResY,
  90,
);
const zhPosition = positionOverride(
  opts.captionPosition,
  playResX,
  playResY,
  42,
);

// In the English branch:
const text = enPosition + buildLine(
  cue.text,
  opts.highlightKeyPhrases ? cue.highlightWords : [],
);

// In the Chinese branch:
const text = zhPosition + buildLine(cue.translation, zhPhrases);
```

- [ ] **Step 8: Run focused tests and commit Task 1**

Run:

```powershell
pnpm test -- src/utils/ass.test.ts
pnpm typecheck
git diff --check
```

Expected: all commands pass.

Commit:

```powershell
git add -- src/utils/ass.ts src/utils/ass.test.ts
git commit -m "feat(export): position burned subtitles from player offset"
```

---

### Task 2: Thread the current session position through the export flow

**Files:**
- Modify: `src/components/ExportVideoModal.tsx`
- Create: `src/components/ExportVideoModal.test.tsx`
- Modify: `src/pages/Player.tsx`
- Create: `src/pages/Player.captionExport.test.ts`

**Interfaces:**
- Consumes: `normalizeCaptionOffset` from `src/utils/ass.ts`.
- Extends: `ExportVideoModal` props with `captionOffset: { x: number; y: number }` and `captionViewport: { width: number; height: number }`.
- Preserves: existing `export_burned_video` invoke payload; only `assContent` changes.

- [ ] **Step 1: Write a failing modal handoff test**

Create `src/components/ExportVideoModal.test.tsx` with Tauri mocks and assert on the real generated ASS content:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { ExportVideoModal } from "./ExportVideoModal";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  vi.mocked(save).mockReset().mockResolvedValue("C:\\out.mp4");
});

describe("ExportVideoModal", () => {
  it("passes the current normalized caption position into burned ASS", async () => {
    render(
      <ExportVideoModal
        videoId="video-1"
        videoTitle="Example"
        subtitles={[{
          time: 0,
          endTime: 1,
          text: "hello world",
          translation: "你好 世界",
          isKeyPoint: false,
          highlightWords: [],
          keyNotes: {},
          highlightTranslations: {},
        }]}
        durationSec={1}
        captionOffset={{ x: 128, y: -144 }}
        captionViewport={{ width: 1280, height: 720 }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "开始导出" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "export_burned_video",
      expect.objectContaining({
        assContent: expect.stringContaining("{\\pos(768,486)}hello world"),
      }),
    ));
  });
});
```

For default `1280x720`, the English anchor is `x=640+128=768`, `y=(720-90)-144=486`.

- [ ] **Step 2: Run the modal test and verify RED**

Run:

```powershell
pnpm test -- src/components/ExportVideoModal.test.tsx
```

Expected: FAIL because the raw offset and viewport are not accepted or normalized.

- [ ] **Step 3: Thread the normalized position through `ExportVideoModal`**

In `src/components/ExportVideoModal.tsx`:

```ts
import { normalizeCaptionOffset, subtitlesToAss } from "../utils/ass";

interface Props {
  videoId: string;
  videoTitle: string;
  subtitles: Subtitle[];
  durationSec: number;
  captionOffset: { x: number; y: number };
  captionViewport: { width: number; height: number };
  onClose: () => void;
}
```

Normalize the player geometry before building ASS, then pass the result into the ASS options:

```ts
const captionPosition = normalizeCaptionOffset(
  captionOffset.x,
  captionOffset.y,
  captionViewport.width,
  captionViewport.height,
);

subtitlesToAss(subtitles, {
  includeEnglish,
  includeChinese,
  highlightKeyPhrases: highlight,
  captionPosition,
})
```

- [ ] **Step 4: Run the modal test and verify GREEN**

Run:

```powershell
pnpm test -- src/components/ExportVideoModal.test.tsx src/utils/ass.test.ts
```

Expected: both test files pass.

- [ ] **Step 5: Pass the current session offset from `Player`**

Pass the current temporary offset and the current `<video>` element's CSS viewport to `ExportVideoModal`:

```tsx
export function captionExportGeometry(
  captionOffset: { x: number; y: number },
  video: Pick<HTMLVideoElement, "clientWidth" | "clientHeight"> | null,
) {
  return {
    captionOffset,
    captionViewport: {
      width: video?.clientWidth ?? 0,
      height: video?.clientHeight ?? 0,
    },
  };
}

// ExportVideoModal props:
{...captionExportGeometry(captionOffset, videoRef.current)}
```

This uses the current display geometry at the moment the modal renders and does not write the result into settings or library storage.

Add focused tests in `src/pages/Player.captionExport.test.ts` for a non-zero `1280x720` viewport and for the pre-mount `null` video fallback.

- [ ] **Step 6: Run full frontend verification**

Run:

```powershell
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all frontend tests, typecheck, build, and whitespace checks pass.

- [ ] **Step 7: Commit Task 2**

```powershell
git add -- src/components/ExportVideoModal.tsx src/components/ExportVideoModal.test.tsx src/pages/Player.tsx src/pages/Player.captionExport.test.ts
git commit -m "feat(player): carry dragged caption position into export"
```

---

### Task 3: Final regression review

**Files:**
- Review only: all files changed by Tasks 1 and 2.

**Interfaces:**
- Consumes: completed position conversion and export handoff.
- Produces: verified feature branch ready for merge.

- [ ] **Step 1: Inspect the final diff for scope and encoding damage**

Run:

```powershell
git diff main...HEAD -- src/utils/ass.ts src/utils/ass.test.ts src/components/ExportVideoModal.tsx src/components/ExportVideoModal.test.tsx src/pages/Player.tsx
git status --short
```

Confirm only the intended frontend files and design/plan documents changed, Chinese UI copy is untouched, and no user-owned main-workspace changes entered the branch.

- [ ] **Step 2: Re-run the final gate from a clean branch state**

Run:

```powershell
pnpm test
pnpm typecheck
pnpm build
git diff --check main...HEAD
```

Expected: all commands pass with no failures.

- [ ] **Step 3: Request code review**

Use `superpowers:requesting-code-review` to verify spec compliance, coordinate math, ASS syntax, unchanged zero-offset output, and absence of persistence changes. Apply only evidence-backed findings, then repeat Step 2 if code changes.
