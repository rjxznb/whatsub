# Caption Style Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the video player's gear-icon popover from speed-only into a YouTube-style multi-view menu containing playback speed + caption style controls (font color, font scale, font opacity, background color, background opacity, highlight toggle, reset).

**Architecture:** Add 6 optional fields to `Settings` (auto-defaulted via existing `mergeWithDefaults`). Introduce a `CaptionStyle` projection type + derivation helper so caller code stays simple. `CaptionOverlay` switches from hardcoded Tailwind classes to inline-style-driven rendering. `VideoPlayer`'s `showSpeed` boolean becomes a `menuView` discriminated state (`root | speed | captions | null`), with two submenus and an outside-click capture layer. `Player.tsx` derives captionStyle from settings and passes it down with one onChange handler. All settings changes write through `useSettings().save()` immediately.

**Tech Stack:** React 19 + TypeScript + Vite + Tailwind v3 + zustand. Tests: Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-05-20-caption-style-menu-design.md`

---

## File Structure

**Modify:**
- `client/src/types/settings.ts` — add 6 optional settings fields + `CaptionStyle` type + `DEFAULT_CAPTION_STYLE` + `captionStyleFromSettings` helper
- `client/src/components/CaptionOverlay.tsx` — accept `style: CaptionStyle` prop, drive rendering via inline styles, gate highlight spans on `style.highlightsEnabled`
- `client/src/components/VideoPlayer.tsx` — replace `showSpeed` with `menuView` state, render root/speed/captions views, add outside-click overlay, accept `captionStyle` + `onChangeCaptionStyle` props
- `client/src/pages/Player.tsx` — derive `captionStyle` from settings store, wire onChange handler, pass through to `VideoPlayer`

**Create:**
- `client/src/components/CaptionOverlay.test.tsx` — render tests for new style prop
- `client/src/components/VideoPlayer.menu.test.tsx` — menu navigation tests

---

## Task 1: Settings types + caption style projection

**Files:**
- Modify: `client/src/types/settings.ts:34-95`
- Create: `client/src/types/settings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/src/types/settings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  DEFAULT_CAPTION_STYLE,
  captionStyleFromSettings,
  type Settings,
} from "./settings";

describe("caption style defaults", () => {
  it("DEFAULT_SETTINGS carries all 6 caption style defaults", () => {
    expect(DEFAULT_SETTINGS.captionFontColor).toBe("#FFFFFF");
    expect(DEFAULT_SETTINGS.captionFontScale).toBe(1);
    expect(DEFAULT_SETTINGS.captionFontOpacity).toBe(1);
    expect(DEFAULT_SETTINGS.captionBackgroundColor).toBe("#000000");
    expect(DEFAULT_SETTINGS.captionBackgroundOpacity).toBe(0.7);
    expect(DEFAULT_SETTINGS.captionHighlightsEnabled).toBe(true);
  });

  it("DEFAULT_CAPTION_STYLE matches DEFAULT_SETTINGS", () => {
    expect(DEFAULT_CAPTION_STYLE).toEqual({
      fontColor: "#FFFFFF",
      fontScale: 1,
      fontOpacity: 1,
      bgColor: "#000000",
      bgOpacity: 0.7,
      highlightsEnabled: true,
    });
  });
});

describe("captionStyleFromSettings", () => {
  it("returns defaults when fields are absent (legacy settings.json)", () => {
    const legacy: Settings = { ...DEFAULT_SETTINGS };
    // Strip the new fields to simulate an older config
    delete legacy.captionFontColor;
    delete legacy.captionFontScale;
    delete legacy.captionFontOpacity;
    delete legacy.captionBackgroundColor;
    delete legacy.captionBackgroundOpacity;
    delete legacy.captionHighlightsEnabled;

    expect(captionStyleFromSettings(legacy)).toEqual(DEFAULT_CAPTION_STYLE);
  });

  it("projects user values when present", () => {
    const s: Settings = {
      ...DEFAULT_SETTINGS,
      captionFontColor: "#FFEB3B",
      captionFontScale: 1.5,
      captionFontOpacity: 0.8,
      captionBackgroundColor: "#2196F3",
      captionBackgroundOpacity: 0.5,
      captionHighlightsEnabled: false,
    };
    expect(captionStyleFromSettings(s)).toEqual({
      fontColor: "#FFEB3B",
      fontScale: 1.5,
      fontOpacity: 0.8,
      bgColor: "#2196F3",
      bgOpacity: 0.5,
      highlightsEnabled: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && pnpm test src/types/settings.test.ts`
Expected: FAIL — `DEFAULT_CAPTION_STYLE` and `captionStyleFromSettings` not exported, fields missing on `DEFAULT_SETTINGS`.

- [ ] **Step 3: Add settings fields + helpers**

Edit `client/src/types/settings.ts`. Add the new fields to the `Settings` interface (after `bridgeEnabled?`, around line 79):

```ts
  /** Caption (CaptionOverlay) font hex color. Default "#FFFFFF". */
  captionFontColor?: string;
  /** Caption font size scale: 0.75 / 1 / 1.25 / 1.5. Default 1. */
  captionFontScale?: number;
  /** Caption text opacity 0–1. Default 1. */
  captionFontOpacity?: number;
  /** Caption background hex color (no alpha). Default "#000000". */
  captionBackgroundColor?: string;
  /** Caption background opacity 0–1. Default 0.7. */
  captionBackgroundOpacity?: number;
  /** Whether the LLM key-phrase highlight spans render inside CaptionOverlay.
   *  When false, English text + Chinese translation render plain. The
   *  right-side SubtitleList is unaffected. Default true. */
  captionHighlightsEnabled?: boolean;
```

Add the corresponding defaults inside `DEFAULT_SETTINGS` (after `bridgeEnabled: true,`):

```ts
  captionFontColor: "#FFFFFF",
  captionFontScale: 1,
  captionFontOpacity: 1,
  captionBackgroundColor: "#000000",
  captionBackgroundOpacity: 0.7,
  captionHighlightsEnabled: true,
```

Append at the bottom of the file:

```ts
/** Projection of caption-related Settings fields with defaults applied.
 *  CaptionOverlay + the gear-menu captions submenu both consume this. */
export interface CaptionStyle {
  fontColor: string;
  fontScale: number;
  fontOpacity: number;
  bgColor: string;
  bgOpacity: number;
  highlightsEnabled: boolean;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontColor: "#FFFFFF",
  fontScale: 1,
  fontOpacity: 1,
  bgColor: "#000000",
  bgOpacity: 0.7,
  highlightsEnabled: true,
};

export function captionStyleFromSettings(s: Settings): CaptionStyle {
  return {
    fontColor: s.captionFontColor ?? DEFAULT_CAPTION_STYLE.fontColor,
    fontScale: s.captionFontScale ?? DEFAULT_CAPTION_STYLE.fontScale,
    fontOpacity: s.captionFontOpacity ?? DEFAULT_CAPTION_STYLE.fontOpacity,
    bgColor: s.captionBackgroundColor ?? DEFAULT_CAPTION_STYLE.bgColor,
    bgOpacity: s.captionBackgroundOpacity ?? DEFAULT_CAPTION_STYLE.bgOpacity,
    highlightsEnabled:
      s.captionHighlightsEnabled ?? DEFAULT_CAPTION_STYLE.highlightsEnabled,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && pnpm test src/types/settings.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Typecheck**

Run: `cd client && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd client
git add src/types/settings.ts src/types/settings.test.ts
git commit -m "feat(client): add caption style settings fields + projection helper"
```

---

## Task 2: CaptionOverlay accepts style prop

**Files:**
- Modify: `client/src/components/CaptionOverlay.tsx`
- Create: `client/src/components/CaptionOverlay.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/CaptionOverlay.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CaptionOverlay } from "./CaptionOverlay";
import { DEFAULT_CAPTION_STYLE, type CaptionStyle } from "../types/settings";
import type { Subtitle } from "../llm/types";

const cue = (overrides: Partial<Subtitle> = {}): Subtitle => ({
  time: 0,
  endTime: 1,
  text: "I need to catch up on emails",
  translation: "我得追一下邮件",
  isKeyPoint: false,
  highlightWords: ["catch up"],
  keyNotes: { "catch up": "动词短语" },
  highlightTranslations: { "catch up": "追上" },
  ...overrides,
});

const styleWith = (patch: Partial<CaptionStyle> = {}): CaptionStyle => ({
  ...DEFAULT_CAPTION_STYLE,
  ...patch,
});

describe("CaptionOverlay", () => {
  it("renders nothing when subtitle is null", () => {
    const { container } = render(
      <CaptionOverlay subtitle={null} style={styleWith()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("applies bg color + opacity as 8-digit hex backgroundColor", () => {
    const { container } = render(
      <CaptionOverlay
        subtitle={cue()}
        style={styleWith({ bgColor: "#000000", bgOpacity: 0.7 })}
      />
    );
    const box = container.querySelector("[data-caption-box]") as HTMLElement;
    expect(box).toBeTruthy();
    // 0.7 * 255 = 178.5 → 179 → 0xb3 (lowercase from toString(16))
    expect(box.style.backgroundColor).toMatch(/rgba\(0,\s*0,\s*0,\s*0\.7/);
  });

  it("applies font color + opacity to English line via inline style", () => {
    const { container } = render(
      <CaptionOverlay
        subtitle={cue()}
        style={styleWith({ fontColor: "#FFEB3B", fontOpacity: 0.8 })}
      />
    );
    const en = container.querySelector("[data-caption-en]") as HTMLElement;
    expect(en.style.color).toBe("rgb(255, 235, 59)");
    expect(en.style.opacity).toBe("0.8");
  });

  it("scales font size by captionFontScale", () => {
    const { container } = render(
      <CaptionOverlay subtitle={cue()} style={styleWith({ fontScale: 1.5 })} />
    );
    const en = container.querySelector("[data-caption-en]") as HTMLElement;
    const zh = container.querySelector("[data-caption-zh]") as HTMLElement;
    expect(en.style.fontSize).toBe("1.875rem"); // 1.25 * 1.5
    expect(zh.style.fontSize).toBe("1.5rem"); // 1 * 1.5
  });

  it("renders highlight spans when enabled", () => {
    const { container } = render(
      <CaptionOverlay
        subtitle={cue()}
        style={styleWith({ highlightsEnabled: true })}
      />
    );
    const highlights = container.querySelectorAll(".bg-amber-300");
    expect(highlights.length).toBeGreaterThan(0);
  });

  it("strips highlight spans when disabled", () => {
    const { container } = render(
      <CaptionOverlay
        subtitle={cue()}
        style={styleWith({ highlightsEnabled: false })}
      />
    );
    expect(container.querySelectorAll(".bg-amber-300").length).toBe(0);
    // Text content still present, just no styling
    expect(container.textContent).toContain("catch up");
    expect(container.textContent).toContain("追上");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && pnpm test src/components/CaptionOverlay.test.tsx`
Expected: FAIL — `style` prop unknown, no `data-caption-*` attributes.

- [ ] **Step 3: Rewrite CaptionOverlay**

Replace entire contents of `client/src/components/CaptionOverlay.tsx`:

```tsx
import type { ReactNode } from "react";
import type { Subtitle } from "../llm/types";
import type { CaptionStyle } from "../types/settings";

interface Props {
  subtitle: Subtitle | null;
  style: CaptionStyle;
}

/**
 * Cinema-style bilingual subtitle box rendered over the video. Visual style
 * (colors / font scale / opacity / highlight on-off) is driven by props so
 * the gear-menu can re-style in real-time without reading the store here.
 */
export function CaptionOverlay({ subtitle, style }: Props) {
  if (!subtitle) return null;

  const bgRgba = hexToRgba(style.bgColor, style.bgOpacity);
  const textStyle = { color: style.fontColor, opacity: style.fontOpacity };
  const enStyle = { ...textStyle, fontSize: `${1.25 * style.fontScale}rem` };
  const zhStyle = { ...textStyle, fontSize: `${1 * style.fontScale}rem` };

  return (
    <div className="absolute inset-x-0 bottom-20 px-6 flex justify-center pointer-events-none z-10">
      <div
        data-caption-box
        className="max-w-[90%] rounded-md px-4 py-2 text-center backdrop-blur-sm shadow-lg"
        style={{ backgroundColor: bgRgba }}
      >
        <div
          data-caption-en
          className="leading-snug font-medium"
          style={enStyle}
        >
          {renderEnglish(subtitle, style.highlightsEnabled)}
        </div>
        <div
          data-caption-zh
          className="leading-snug mt-1"
          style={zhStyle}
        >
          {renderTranslation(subtitle, style.highlightsEnabled)}
        </div>
      </div>
    </div>
  );
}

function renderEnglish(s: Subtitle, withHighlights: boolean): ReactNode {
  if (!withHighlights || s.highlightWords.length === 0) return s.text;
  const words = [...s.highlightWords].sort(
    (a, b) => s.text.indexOf(a) - s.text.indexOf(b)
  );
  return renderWithSpans(s.text, words, (w, key) => (
    <span
      key={key}
      className="bg-amber-300 text-black px-0.5 rounded font-semibold"
    >
      {w}
    </span>
  ));
}

function renderTranslation(s: Subtitle, withHighlights: boolean): ReactNode {
  if (!withHighlights) return s.translation;
  const zhPhrases = s.highlightWords
    .map((w) => s.highlightTranslations[w])
    .filter((zh): zh is string => Boolean(zh));
  if (zhPhrases.length === 0) return s.translation;
  const sorted = [...zhPhrases].sort(
    (a, b) => s.translation.indexOf(a) - s.translation.indexOf(b)
  );
  return renderWithSpans(s.translation, sorted, (zh, key) => (
    <span key={key} className="bg-amber-300/30 text-amber-100 px-0.5 rounded">
      {zh}
    </span>
  ));
}

function renderWithSpans(
  text: string,
  phrases: string[],
  wrap: (phrase: string, key: string) => ReactNode
): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const p of phrases) {
    if (!p) continue;
    const idx = text.indexOf(p, cursor);
    if (idx === -1) continue;
    if (idx > cursor) out.push(text.slice(cursor, idx));
    out.push(wrap(p, `${p}-${idx}`));
    cursor = idx + p.length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

/** Convert "#RRGGBB" + 0..1 opacity to a CSS rgba(...) string.
 *  rgba(...) is more compatible with browser color parsing than 8-digit hex,
 *  and Vitest jsdom returns this form when reading style.backgroundColor back. */
function hexToRgba(hex: string, opacity: number): string {
  const clean = hex.replace(/^#/, "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, opacity));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && pnpm test src/components/CaptionOverlay.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck (will fail at call site — that's expected)**

Run: `cd client && pnpm typecheck`
Expected: FAIL — `VideoPlayer.tsx` still passes `subtitle` without `style` prop. That's wired in Task 3.

- [ ] **Step 6: Commit**

```bash
cd client
git add src/components/CaptionOverlay.tsx src/components/CaptionOverlay.test.tsx
git commit -m "refactor(client): CaptionOverlay takes CaptionStyle prop, inline-styled"
```

---

## Task 3: Wire CaptionStyle through Player.tsx → VideoPlayer → CaptionOverlay

**Files:**
- Modify: `client/src/pages/Player.tsx:43, 645-655`
- Modify: `client/src/components/VideoPlayer.tsx:1-44, 321`

- [ ] **Step 1: Update VideoPlayer Props + pass-through**

Edit `client/src/components/VideoPlayer.tsx`. Update import on line 22-23:

```tsx
import { CaptionOverlay } from "./CaptionOverlay";
import type { Subtitle } from "../llm/types";
import type { CaptionStyle, Settings } from "../types/settings";
```

Extend the `Props` interface (replace lines 25-39):

```tsx
interface Props {
  src: string;
  panelOpen?: boolean;
  onTogglePanel?: () => void;
  currentSubtitle?: Subtitle | null;
  showCaptions?: boolean;
  onToggleCaptions?: () => void;
  /** Resolved caption visual style. Drives CaptionOverlay rendering and the
   *  captions submenu's current-selection state. */
  captionStyle: CaptionStyle;
  /** Patch one or more caption-style Settings fields. Caller persists via
   *  useSettings().save(). */
  onChangeCaptionStyle: (patch: Partial<Settings>) => void;
}
```

Update the `forwardRef` destructure (line 43-45) to pull the new props:

```tsx
export const VideoPlayer = forwardRef<HTMLVideoElement, Props>(function VideoPlayer(
  {
    src,
    panelOpen,
    onTogglePanel,
    currentSubtitle,
    showCaptions,
    onToggleCaptions,
    captionStyle,
    onChangeCaptionStyle,
  },
  ref
) {
```

Pass the style down at the `CaptionOverlay` call site (line 321):

```tsx
{showCaptions && (
  <CaptionOverlay
    subtitle={currentSubtitle ?? null}
    style={captionStyle}
  />
)}
```

> Note: `onChangeCaptionStyle` is wired here but not consumed yet — Task 5 hooks it into the captions submenu. The TS compiler will warn about the unused destructured value; suppress with `// eslint-disable-next-line @typescript-eslint/no-unused-vars` immediately above the destructure if the build complains, or simply omit `onChangeCaptionStyle` from destructuring for now (read it in Task 5). To avoid yo-yo edits, keep it destructured and add the directive:

```tsx
export const VideoPlayer = forwardRef<HTMLVideoElement, Props>(function VideoPlayer(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  {
    src,
    panelOpen,
    onTogglePanel,
    currentSubtitle,
    showCaptions,
    onToggleCaptions,
    captionStyle,
    onChangeCaptionStyle,
  },
  ref
) {
```

(The eslint-disable line will be removed in Task 5 once `onChangeCaptionStyle` is used.)

- [ ] **Step 2: Wire Player.tsx**

Edit `client/src/pages/Player.tsx`. Update the settings import on line 43 to pull `save` too:

```tsx
const { settings, save } = useSettings();
```

Add the import near other type imports (after line 26):

```tsx
import { captionStyleFromSettings } from "../types/settings";
import type { Settings } from "../types/settings";
```

Add the derivation + handler near the top of the `Player()` body (after the `videoRef` ref, around line 51):

```tsx
const captionStyle = useMemo(
  () => captionStyleFromSettings(settings),
  [settings]
);
const onChangeCaptionStyle = (patch: Partial<Settings>) => {
  void save({ ...settings, ...patch });
};
```

Update the `<VideoPlayer ... />` JSX (lines 645-655) to pass both new props:

```tsx
<VideoPlayer
  ref={videoRef}
  src={videoSrc}
  panelOpen={panelOpen}
  onTogglePanel={() => setPanelOpen((v) => !v)}
  currentSubtitle={
    currentIdx >= 0 ? analysis.subtitles[currentIdx] ?? null : null
  }
  showCaptions={showCaptions}
  onToggleCaptions={() => setShowCaptions((v) => !v)}
  captionStyle={captionStyle}
  onChangeCaptionStyle={onChangeCaptionStyle}
/>
```

- [ ] **Step 3: Run typecheck**

Run: `cd client && pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Run all tests**

Run: `cd client && pnpm test`
Expected: all existing tests + new Task 1 & 2 tests pass.

- [ ] **Step 5: Manual verification**

Run: `cd client && pnpm tauri dev`

When the app opens:
1. Import or open any existing library video
2. Open the video; toggle captions ON via the bottom-right Captions button
3. Verify the bilingual caption box renders **identical** to before (white text on 70% black bg, with amber highlights)
4. Close the app — confirm `%APPDATA%/whatsub/settings.json` either has the new fields or doesn't; either way the next launch should still render captions correctly.

- [ ] **Step 6: Commit**

```bash
cd client
git add src/pages/Player.tsx src/components/VideoPlayer.tsx
git commit -m "feat(client): wire captionStyle through Player → VideoPlayer → CaptionOverlay"
```

---

## Task 4: VideoPlayer multi-view menu (root + speed submenu + captions stub)

**Files:**
- Modify: `client/src/components/VideoPlayer.tsx:10-20, 59, 446-479`
- Create: `client/src/components/VideoPlayer.menu.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/VideoPlayer.menu.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { VideoPlayer } from "./VideoPlayer";
import { DEFAULT_CAPTION_STYLE } from "../types/settings";

function renderPlayer(onChange = vi.fn()) {
  return render(
    <VideoPlayer
      src=""
      captionStyle={DEFAULT_CAPTION_STYLE}
      onChangeCaptionStyle={onChange}
    />
  );
}

describe("VideoPlayer gear menu", () => {
  it("is closed by default", () => {
    const { queryByTestId } = renderPlayer();
    expect(queryByTestId("gear-menu")).toBeNull();
  });

  it("opens to root view on gear click", () => {
    const { getByTitle, getByTestId } = renderPlayer();
    fireEvent.click(getByTitle("播放速度 / 字幕设置"));
    expect(getByTestId("gear-menu")).toBeTruthy();
    expect(getByTestId("menu-row-speed")).toBeTruthy();
    expect(getByTestId("menu-row-captions")).toBeTruthy();
  });

  it("navigates root → speed submenu and back", () => {
    const { getByTitle, getByTestId, queryByTestId } = renderPlayer();
    fireEvent.click(getByTitle("播放速度 / 字幕设置"));
    fireEvent.click(getByTestId("menu-row-speed"));
    expect(getByTestId("speed-submenu")).toBeTruthy();
    expect(queryByTestId("menu-row-speed")).toBeNull();

    fireEvent.click(getByTestId("menu-back"));
    expect(getByTestId("menu-row-speed")).toBeTruthy();
  });

  it("navigates root → captions submenu and back", () => {
    const { getByTitle, getByTestId } = renderPlayer();
    fireEvent.click(getByTitle("播放速度 / 字幕设置"));
    fireEvent.click(getByTestId("menu-row-captions"));
    expect(getByTestId("captions-submenu")).toBeTruthy();
    fireEvent.click(getByTestId("menu-back"));
    expect(getByTestId("menu-row-captions")).toBeTruthy();
  });

  it("closes when selecting a speed option", () => {
    const { getByTitle, getByTestId, queryByTestId } = renderPlayer();
    fireEvent.click(getByTitle("播放速度 / 字幕设置"));
    fireEvent.click(getByTestId("menu-row-speed"));
    fireEvent.click(getByTestId("speed-1.5"));
    expect(queryByTestId("gear-menu")).toBeNull();
  });

  it("closes on outside-click overlay", () => {
    const { getByTitle, getByTestId, queryByTestId } = renderPlayer();
    fireEvent.click(getByTitle("播放速度 / 字幕设置"));
    expect(getByTestId("gear-menu")).toBeTruthy();
    fireEvent.click(getByTestId("menu-outside-capture"));
    expect(queryByTestId("gear-menu")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && pnpm test src/components/VideoPlayer.menu.test.tsx`
Expected: FAIL — title doesn't match, no `data-testid`s present.

- [ ] **Step 3: Refactor VideoPlayer menu**

Edit `client/src/components/VideoPlayer.tsx`.

Update the lucide-react import (line 9-20) to add chevron icons:

```tsx
import {
  Captions,
  CaptionsOff,
  ChevronLeft,
  ChevronRight,
  PanelRight,
  PanelRightClose,
  Pause,
  Play,
  RotateCcw,
  Settings,
  Volume2,
  VolumeX,
} from "lucide-react";
```

Replace the `showSpeed` state (line 59) with a discriminated menu view:

```tsx
type MenuView = "root" | "speed" | "captions";
const [menuView, setMenuView] = useState<MenuView | null>(null);
```

Replace the gear-button block (lines 445-479) with the new multi-view menu. This is the new block:

```tsx
{/* Combined settings menu — speed + captions */}
<div className="relative">
  <button
    type="button"
    onClick={() => setMenuView((v) => (v ? null : "root"))}
    title="播放速度 / 字幕设置"
    className="flex h-10 w-10 items-center justify-center rounded-full text-white hover:bg-white/20 transition-colors"
  >
    <Settings className="h-6 w-6" />
  </button>
  {speed !== 1 && menuView === null && (
    <span className="absolute top-0 right-0 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-blue-500 px-1 text-[9px] font-bold text-white pointer-events-none">
      {speed}x
    </span>
  )}

  {menuView !== null && (
    <>
      {/* Outside-click capture layer */}
      <div
        data-testid="menu-outside-capture"
        className="fixed inset-0 z-[5]"
        onClick={() => setMenuView(null)}
      />

      <div
        data-testid="gear-menu"
        className="absolute bottom-full right-0 mb-2 w-[280px] max-h-[70vh] overflow-y-auto rounded-xl border border-white/10 bg-black/80 backdrop-blur-md shadow-lg z-10"
        onClick={(e) => e.stopPropagation()}
      >
        {menuView === "root" && (
          <div className="py-1">
            <button
              type="button"
              data-testid="menu-row-speed"
              onClick={() => setMenuView("speed")}
              className="flex w-full items-center justify-between px-4 py-2.5 text-sm text-white hover:bg-white/10 transition-colors"
            >
              <span>播放速度</span>
              <span className="flex items-center gap-1 text-white/70">
                <span>{speed === 1 ? "1x" : `${speed}x`}</span>
                <ChevronRight className="h-4 w-4" />
              </span>
            </button>
            <button
              type="button"
              data-testid="menu-row-captions"
              onClick={() => setMenuView("captions")}
              className="flex w-full items-center justify-between px-4 py-2.5 text-sm text-white hover:bg-white/10 transition-colors"
            >
              <span>字幕设置</span>
              <ChevronRight className="h-4 w-4 text-white/70" />
            </button>
          </div>
        )}

        {menuView === "speed" && (
          <div data-testid="speed-submenu" className="py-1">
            <button
              type="button"
              data-testid="menu-back"
              onClick={() => setMenuView("root")}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition-colors border-b border-white/10"
            >
              <ChevronLeft className="h-4 w-4" />
              <span>播放速度</span>
            </button>
            {SPEED_OPTIONS.map((s) => (
              <button
                key={s}
                type="button"
                data-testid={`speed-${s}`}
                onClick={() => {
                  changeSpeed(s);
                  setMenuView(null);
                }}
                className={
                  "block w-full px-4 py-1.5 text-left text-sm transition-colors " +
                  (s === speed
                    ? "text-blue-400 font-semibold"
                    : "text-white/80 hover:bg-white/10")
                }
              >
                {s === 1 ? "Normal" : `${s}x`}
              </button>
            ))}
          </div>
        )}

        {menuView === "captions" && (
          <div data-testid="captions-submenu" className="py-1">
            <button
              type="button"
              data-testid="menu-back"
              onClick={() => setMenuView("root")}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition-colors border-b border-white/10"
            >
              <ChevronLeft className="h-4 w-4" />
              <span>字幕设置</span>
            </button>
            <div className="px-4 py-3 text-xs text-white/40">
              (字幕样式控件将在 Task 5 实现)
            </div>
          </div>
        )}
      </div>
    </>
  )}
</div>
```

Also update `changeSpeed` (around line 212) to no longer reference the removed `setShowSpeed`:

```tsx
function changeSpeed(s: number) {
  const v = resolveVideo();
  if (v) v.playbackRate = s;
  setSpeed(s);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && pnpm test src/components/VideoPlayer.menu.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run all tests + typecheck**

Run: `cd client && pnpm test && pnpm typecheck`
Expected: all pass.

- [ ] **Step 6: Manual verification**

Run: `cd client && pnpm tauri dev`
- Open a video, click the gear icon — root menu appears with 「播放速度」「字幕设置」
- Click 「播放速度」 → submenu shows speed options + back arrow
- Click back arrow → root
- Click 「字幕设置」 → submenu with placeholder text + back arrow
- Click outside the menu → menu closes
- Pick a speed → menu closes, video speed changes

- [ ] **Step 7: Commit**

```bash
cd client
git add src/components/VideoPlayer.tsx src/components/VideoPlayer.menu.test.tsx
git commit -m "feat(client): gear menu refactor — multi-view root/speed/captions"
```

---

## Task 5: Captions submenu controls

**Files:**
- Modify: `client/src/components/VideoPlayer.tsx` (extend captions submenu block from Task 4 + remove eslint-disable from Task 3)
- Modify: `client/src/components/VideoPlayer.menu.test.tsx` (extend with captions interactions)

- [ ] **Step 1: Write the failing tests**

Append to `client/src/components/VideoPlayer.menu.test.tsx`:

```tsx
describe("VideoPlayer captions submenu", () => {
  function openCaptions(onChange = vi.fn()) {
    const utils = render(
      <VideoPlayer
        src=""
        captionStyle={DEFAULT_CAPTION_STYLE}
        onChangeCaptionStyle={onChange}
      />
    );
    fireEvent.click(utils.getByTitle("播放速度 / 字幕设置"));
    fireEvent.click(utils.getByTestId("menu-row-captions"));
    return { ...utils, onChange };
  }

  it("selecting a font color calls onChangeCaptionStyle with captionFontColor", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("font-color-#FFEB3B"));
    expect(onChange).toHaveBeenCalledWith({ captionFontColor: "#FFEB3B" });
  });

  it("selecting a background color calls onChangeCaptionStyle with captionBackgroundColor", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("bg-color-#2196F3"));
    expect(onChange).toHaveBeenCalledWith({ captionBackgroundColor: "#2196F3" });
  });

  it("selecting a font scale calls onChangeCaptionStyle with captionFontScale", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("font-scale-1.25"));
    expect(onChange).toHaveBeenCalledWith({ captionFontScale: 1.25 });
  });

  it("toggling highlights flips captionHighlightsEnabled", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("toggle-highlights"));
    expect(onChange).toHaveBeenCalledWith({ captionHighlightsEnabled: false });
  });

  it("changing bg opacity slider patches captionBackgroundOpacity", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.change(getByTestId("slider-bg-opacity"), {
      target: { value: "0.5" },
    });
    expect(onChange).toHaveBeenCalledWith({ captionBackgroundOpacity: 0.5 });
  });

  it("changing font opacity slider patches captionFontOpacity", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.change(getByTestId("slider-font-opacity"), {
      target: { value: "0.6" },
    });
    expect(onChange).toHaveBeenCalledWith({ captionFontOpacity: 0.6 });
  });

  it("reset button patches all 6 caption fields to defaults", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("reset-captions"));
    expect(onChange).toHaveBeenCalledWith({
      captionFontColor: "#FFFFFF",
      captionFontScale: 1,
      captionFontOpacity: 1,
      captionBackgroundColor: "#000000",
      captionBackgroundOpacity: 0.7,
      captionHighlightsEnabled: true,
    });
  });

  it("captions submenu does not close after a control interaction", () => {
    const { getByTestId } = openCaptions();
    fireEvent.click(getByTestId("font-color-#FFEB3B"));
    expect(getByTestId("captions-submenu")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && pnpm test src/components/VideoPlayer.menu.test.tsx`
Expected: FAIL — 8 new tests fail because test-ids don't exist yet.

- [ ] **Step 3: Build the captions submenu controls**

In `client/src/components/VideoPlayer.tsx`, also import `DEFAULT_CAPTION_STYLE`:

```tsx
import {
  type CaptionStyle,
  type Settings,
  DEFAULT_CAPTION_STYLE,
} from "../types/settings";
```

Remove the `// eslint-disable-next-line @typescript-eslint/no-unused-vars` line added in Task 3 (now `onChangeCaptionStyle` is consumed).

Just above the VideoPlayer render JSX (anywhere inside the function body before `return`), declare the palette + scale constants:

```tsx
const CAPTION_COLOR_PALETTE = [
  "#FFFFFF",
  "#FFEB3B",
  "#00BCD4",
  "#4CAF50",
  "#2196F3",
  "#E91E63",
  "#F44336",
  "#000000",
];

const FONT_SCALE_OPTIONS: { label: string; value: number }[] = [
  { label: "小", value: 0.75 },
  { label: "中", value: 1 },
  { label: "大", value: 1.25 },
  { label: "特大", value: 1.5 },
];
```

Replace the captions submenu placeholder (the `(字幕样式控件将在 Task 5 实现)` div) with the full controls. The full submenu block now:

```tsx
{menuView === "captions" && (
  <div data-testid="captions-submenu" className="py-1">
    <button
      type="button"
      data-testid="menu-back"
      onClick={() => setMenuView("root")}
      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition-colors border-b border-white/10"
    >
      <ChevronLeft className="h-4 w-4" />
      <span>字幕设置</span>
    </button>

    <div className="px-4 py-3 space-y-4">
      {/* Font color */}
      <div>
        <div className="text-xs text-white/60 mb-2">字体颜色</div>
        <div className="flex flex-wrap gap-1.5">
          {CAPTION_COLOR_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              data-testid={`font-color-${c}`}
              onClick={() => onChangeCaptionStyle({ captionFontColor: c })}
              className={
                "h-6 w-6 rounded-full border border-white/20 transition-all " +
                (captionStyle.fontColor.toUpperCase() === c.toUpperCase()
                  ? "ring-2 ring-white scale-110"
                  : "hover:scale-110")
              }
              style={{ backgroundColor: c }}
              aria-label={c}
            />
          ))}
        </div>
      </div>

      {/* Font scale */}
      <div>
        <div className="text-xs text-white/60 mb-2">字号</div>
        <div className="grid grid-cols-4 gap-1">
          {FONT_SCALE_OPTIONS.map(({ label, value }) => (
            <button
              key={value}
              type="button"
              data-testid={`font-scale-${value}`}
              onClick={() => onChangeCaptionStyle({ captionFontScale: value })}
              className={
                "rounded px-2 py-1 text-xs transition-colors " +
                (captionStyle.fontScale === value
                  ? "bg-white/25 text-white font-semibold"
                  : "bg-white/5 text-white/70 hover:bg-white/15")
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Font opacity */}
      <div>
        <div className="flex items-center justify-between text-xs text-white/60 mb-1">
          <span>字体不透明度</span>
          <span className="tabular-nums">
            {Math.round(captionStyle.fontOpacity * 100)}%
          </span>
        </div>
        <input
          type="range"
          data-testid="slider-font-opacity"
          min={0}
          max={1}
          step={0.05}
          value={captionStyle.fontOpacity}
          onChange={(e) =>
            onChangeCaptionStyle({
              captionFontOpacity: parseFloat(e.target.value),
            })
          }
          className="w-full h-1 cursor-pointer appearance-none rounded-full bg-white/20 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
        />
      </div>

      {/* Highlight toggle */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/60">重点高亮</span>
        <button
          type="button"
          data-testid="toggle-highlights"
          onClick={() =>
            onChangeCaptionStyle({
              captionHighlightsEnabled: !captionStyle.highlightsEnabled,
            })
          }
          aria-pressed={captionStyle.highlightsEnabled}
          className={
            "relative h-5 w-9 rounded-full transition-colors " +
            (captionStyle.highlightsEnabled
              ? "bg-blue-500"
              : "bg-white/20")
          }
        >
          <span
            className={
              "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform " +
              (captionStyle.highlightsEnabled
                ? "translate-x-4"
                : "translate-x-0.5")
            }
          />
        </button>
      </div>

      <div className="h-px bg-white/10" />

      {/* Background color */}
      <div>
        <div className="text-xs text-white/60 mb-2">背景颜色</div>
        <div className="flex flex-wrap gap-1.5">
          {CAPTION_COLOR_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              data-testid={`bg-color-${c}`}
              onClick={() =>
                onChangeCaptionStyle({ captionBackgroundColor: c })
              }
              className={
                "h-6 w-6 rounded-full border border-white/20 transition-all " +
                (captionStyle.bgColor.toUpperCase() === c.toUpperCase()
                  ? "ring-2 ring-white scale-110"
                  : "hover:scale-110")
              }
              style={{ backgroundColor: c }}
              aria-label={c}
            />
          ))}
        </div>
      </div>

      {/* Background opacity */}
      <div>
        <div className="flex items-center justify-between text-xs text-white/60 mb-1">
          <span>背景不透明度</span>
          <span className="tabular-nums">
            {Math.round(captionStyle.bgOpacity * 100)}%
          </span>
        </div>
        <input
          type="range"
          data-testid="slider-bg-opacity"
          min={0}
          max={1}
          step={0.05}
          value={captionStyle.bgOpacity}
          onChange={(e) =>
            onChangeCaptionStyle({
              captionBackgroundOpacity: parseFloat(e.target.value),
            })
          }
          className="w-full h-1 cursor-pointer appearance-none rounded-full bg-white/20 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
        />
      </div>

      {/* Reset */}
      <button
        type="button"
        data-testid="reset-captions"
        onClick={() =>
          onChangeCaptionStyle({
            captionFontColor: DEFAULT_CAPTION_STYLE.fontColor,
            captionFontScale: DEFAULT_CAPTION_STYLE.fontScale,
            captionFontOpacity: DEFAULT_CAPTION_STYLE.fontOpacity,
            captionBackgroundColor: DEFAULT_CAPTION_STYLE.bgColor,
            captionBackgroundOpacity: DEFAULT_CAPTION_STYLE.bgOpacity,
            captionHighlightsEnabled: DEFAULT_CAPTION_STYLE.highlightsEnabled,
          })
        }
        className="w-full rounded-md bg-white/10 hover:bg-white/20 px-3 py-2 text-xs text-white transition-colors"
      >
        重置字幕设置
      </button>
    </div>
  </div>
)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && pnpm test src/components/VideoPlayer.menu.test.tsx`
Expected: PASS, all menu tests (14 total: 6 from Task 4 + 8 new).

- [ ] **Step 5: Run all tests + typecheck**

Run: `cd client && pnpm test && pnpm typecheck`
Expected: everything green.

- [ ] **Step 6: Manual verification (the golden-path UX walkthrough)**

Run: `cd client && pnpm tauri dev`

1. Open a video with captions enabled
2. Click gear → 字幕设置
3. Pick a font color (yellow) → English text turns yellow live; amber highlights remain unchanged
4. Pick a background color (blue) → caption background turns blue at current opacity
5. Drag 背景不透明度 to 0% → background fully transparent; text still readable on most scenes thanks to `backdrop-blur-sm`
6. Drag 字体不透明度 to 50% → text fades
7. Click 字号 → 特大 → both English and Chinese lines grow
8. Toggle 重点高亮 off → amber spans collapse to plain text
9. Click 重置字幕设置 → returns to white/black/70%/100%/100%/on; menu stays open
10. Close menu (click outside) and restart app → settings persist

Quick edge checks:
- Caption text/bg opacity at 0 → caption box visually empty but still rendered (DOM node present)
- Pick black font + black bg → near-invisible; this is user's choice, no UI guard
- Switch caption toggle (`Captions` button) off → CaptionOverlay unmounts entirely (the menu still works independently)

- [ ] **Step 7: Commit**

```bash
cd client
git add src/components/VideoPlayer.tsx src/components/VideoPlayer.menu.test.tsx
git commit -m "feat(client): caption style submenu — colors, scale, opacity, highlight toggle, reset"
```

---

## Self-Review Notes

- All 6 spec data-model fields covered: Task 1.
- All 7 spec submenu controls covered: Task 5 (font color, font scale, font opacity, highlight toggle, bg color, bg opacity, reset).
- Outside-click + back-arrow nav: Task 4 + tests.
- Highlight visual lock + opt-out toggle: Task 2 (render side) + Task 5 (UI toggle).
- Legacy settings.json compatibility: Task 1 test asserts defaults via `captionStyleFromSettings`.
- 8-bit color hex was reconsidered → switched to `rgba()` form for cleaner Vitest jsdom assertions and equivalent browser behavior; spec wording updated implicitly.
- Method/type names consistent across tasks: `CaptionStyle`, `captionStyleFromSettings`, `DEFAULT_CAPTION_STYLE`, `onChangeCaptionStyle`, `menuView`.
- No placeholders — every step has the actual file path, code, command, and expected result.
