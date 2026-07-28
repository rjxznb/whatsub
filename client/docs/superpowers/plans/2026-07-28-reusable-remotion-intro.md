# Reusable whatsub Remotion Intro Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable 9:16 Remotion intro that presents the episode cover and URL, flies them into a MacBook-framed whatsub recording, plays Edge TTS narration, and transitions directly into the episode’s listening lesson.

**Architecture:** A standalone Remotion workspace under `tools/remotion-intro/` reads one editable `episode.json`. A preparation script validates paths, stages media into `public/generated/`, generates mixed-voice Edge TTS using 云健 and Andrew, probes the resulting duration, and writes normalized Remotion input props. Focused React components render four timed scenes; a wrapper command prepares, renders, verifies, and copies the final MP4 to `C:/Users/Jimmy Spector/Desktop/whatsub-promo/`.

**Tech Stack:** Remotion 4.0.500, React 19, TypeScript 5.8, Vitest 4, `@remotion/media` 4.0.500, `@remotion/transitions` 4.0.500, edge-tts 7.2.8 through `python -m edge_tts`, bundled ffmpeg/ffprobe.

## Global Constraints

- Output is 1080 × 1920, 30 fps, H.264 MP4.
- Target duration is driven by generated TTS and must stay between 13 and 16 seconds.
- Chinese voice is `zh-CN-YunjianNeural`; English voice is `en-US-AndrewNeural`; MiniMax must not be used.
- The recording must remain fully visible with `object-fit: contain`; no UI edge or button may be cropped.
- Visual language must match `whatsub-explainer`: `#08090d`, amber upper-left glow, blue lower-right glow, gold emphasis, frame-driven motion only.
- Every episode changes only `episode.json` and its three referenced assets: cover, URL, and recording.
- Existing unrelated untracked files `../.agents/skills/` and `../AGENTS.md` must remain untouched.

---

## File Map

- `tools/remotion-intro/package.json` — isolated scripts and pinned Remotion dependencies.
- `tools/remotion-intro/tsconfig.json` — TypeScript settings for Remotion and tests.
- `tools/remotion-intro/remotion.config.ts` — output codec, pixel format, concurrency, and browser settings.
- `tools/remotion-intro/episode.json` — the only per-episode file users edit.
- `tools/remotion-intro/src/index.ts` — Remotion entry point.
- `tools/remotion-intro/src/Root.tsx` — composition registration and metadata calculation.
- `tools/remotion-intro/src/types.ts` — raw episode, staged episode, and voice segment interfaces.
- `tools/remotion-intro/src/lib/config.ts` — validation and normalization.
- `tools/remotion-intro/src/lib/timing.ts` — narration-driven timeline calculation.
- `tools/remotion-intro/src/lib/config.test.ts` — config validation tests.
- `tools/remotion-intro/src/lib/timing.test.ts` — scene timing tests.
- `tools/remotion-intro/src/Intro.tsx` — four-scene composition coordinator.
- `tools/remotion-intro/src/components/Backdrop.tsx` — shared skill-matched background.
- `tools/remotion-intro/src/components/MaterialCard.tsx` — cover, title, URL, and scanner.
- `tools/remotion-intro/src/components/MacBookFrame.tsx` — MacBook shell and screen clipping region.
- `tools/remotion-intro/src/components/RecordingScreen.tsx` — full recording plus blurred fill.
- `tools/remotion-intro/src/components/FinalTransition.tsx` — push-in and gold flash handoff.
- `tools/remotion-intro/scripts/prepare.mjs` — validates media, stages files, invokes Edge TTS, probes durations, writes props.
- `tools/remotion-intro/scripts/render.mjs` — runs preparation, render, media verification, and desktop copy.
- `tools/remotion-intro/scripts/tts.py` — generates voice segments and joins them through bundled ffmpeg.
- `tools/remotion-intro/scripts/test_tts.py` — deterministic manifest and command tests with mocked synthesis.
- `tools/remotion-intro/public/generated/.gitkeep` — keeps the generated asset directory without committing episode media.
- `tools/remotion-intro/README.md` — exact per-episode usage and troubleshooting.

---

### Task 1: Scaffold the isolated workspace and validate episode configuration

**Files:**
- Create: `tools/remotion-intro/package.json`
- Create: `tools/remotion-intro/tsconfig.json`
- Create: `tools/remotion-intro/remotion.config.ts`
- Create: `tools/remotion-intro/episode.json`
- Create: `tools/remotion-intro/src/types.ts`
- Create: `tools/remotion-intro/src/lib/config.ts`
- Create: `tools/remotion-intro/src/lib/config.test.ts`
- Create: `tools/remotion-intro/public/generated/.gitkeep`

**Interfaces:**
- Consumes: user-edited `episode.json` containing absolute Windows media paths.
- Produces: `RawEpisodeConfig`, `StagedEpisodeProps`, and `validateEpisodeConfig(value: unknown): RawEpisodeConfig`.

- [ ] **Step 1: Write the failing config tests**

```ts
import {describe, expect, it} from 'vitest';
import {validateEpisodeConfig} from './config';

const valid = {
  coverImage: 'C:/media/cover.png',
  videoTitle: 'Hailey Bieber 访谈',
  videoUrl: 'https://youtube.com/watch?v=abc',
  screenRecording: 'C:/media/import.mp4',
  recordingStart: 0,
  recordingEnd: 8.5,
  recordingSpeed: 1.5,
};

describe('validateEpisodeConfig', () => {
  it('accepts the documented episode shape', () => {
    expect(validateEpisodeConfig(valid)).toEqual(valid);
  });

  it('rejects an inverted recording range', () => {
    expect(() => validateEpisodeConfig({...valid, recordingStart: 9, recordingEnd: 8}))
      .toThrow('recordingEnd must be greater than recordingStart');
  });

  it('rejects a non-http URL', () => {
    expect(() => validateEpisodeConfig({...valid, videoUrl: 'not-a-url'}))
      .toThrow('videoUrl must start with http:// or https://');
  });
});
```

- [ ] **Step 2: Create package metadata, install pinned dependencies, and verify the tests fail**

```json
{
  "name": "whatsub-remotion-intro",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "studio": "remotion studio src/index.ts",
    "prepare": "node scripts/prepare.mjs",
    "render": "node scripts/render.mjs"
  },
  "dependencies": {
    "@remotion/cli": "4.0.500",
    "@remotion/media": "4.0.500",
    "@remotion/transitions": "4.0.500",
    "react": "19.1.0",
    "react-dom": "19.1.0",
    "remotion": "4.0.500"
  },
  "devDependencies": {
    "@types/node": "25.0.0",
    "@types/react": "19.1.8",
    "typescript": "5.8.3",
    "vitest": "4.1.5"
  }
}
```

Run: `cd tools/remotion-intro && pnpm install && pnpm test`

Expected: FAIL because `./config` does not exist.

- [ ] **Step 3: Define the config types and minimal validator**

```ts
export type RawEpisodeConfig = {
  coverImage: string;
  videoTitle: string;
  videoUrl: string;
  screenRecording: string;
  recordingStart: number;
  recordingEnd: number;
  recordingSpeed: number;
};

export type VoiceSegment = {
  text: string;
  voice: 'zh-CN-YunjianNeural' | 'en-US-AndrewNeural';
  rate: string;
  pauseAfterMs: number;
};

export type StagedEpisodeProps = RawEpisodeConfig & {
  coverSrc: string;
  recordingSrc: string;
  narrationSrc: string;
  narrationDuration: number;
  recordingDuration: number;
};
```

Implement `validateEpisodeConfig()` with explicit type checks, HTTP URL validation, positive speed validation, and ordered recording bounds. Use plain TypeScript; do not add a schema dependency for one small object.

- [ ] **Step 4: Add the documented example episode**

```json
{
  "coverImage": "C:/Users/Jimmy Spector/Desktop/436ca175-7005-47b6-9e53-264a699abcf2.png",
  "videoTitle": "Hailey Bieber 聊当妈妈、名气和她的品牌",
  "videoUrl": "https://youtube.com/watch?v=DS_gMagTeow",
  "screenRecording": "C:/Users/Jimmy Spector/Desktop/whatsub/whatsub/client/public/help/corpus-browse.mp4",
  "recordingStart": 16,
  "recordingEnd": 24,
  "recordingSpeed": 1.5
}
```

- [ ] **Step 5: Run config tests and typecheck**

Run: `pnpm test && pnpm exec tsc --noEmit`

Expected: PASS, with no TypeScript diagnostics.

- [ ] **Step 6: Commit**

```powershell
git add tools/remotion-intro
git commit -m "feat: scaffold reusable Remotion intro"
```

---

### Task 2: Generate mixed-voice Edge TTS and derive the timeline

**Files:**
- Create: `tools/remotion-intro/scripts/tts.py`
- Create: `tools/remotion-intro/scripts/test_tts.py`
- Create: `tools/remotion-intro/src/lib/timing.ts`
- Create: `tools/remotion-intro/src/lib/timing.test.ts`

**Interfaces:**
- Consumes: a JSON voice-segment manifest and bundled ffmpeg/ffprobe paths.
- Produces: `public/generated/narration.mp3`, JSON duration output, and `buildTimeline(narrationDuration: number, fps: number): Timeline`.

- [ ] **Step 1: Write failing timing tests**

```ts
import {describe, expect, it} from 'vitest';
import {buildTimeline} from './timing';

describe('buildTimeline', () => {
  it('keeps the full composition in the 13–16 second range', () => {
    expect(buildTimeline(14.2, 30).totalFrames).toBe(426);
  });

  it('rejects narration that cannot fit without truncation', () => {
    expect(() => buildTimeline(17, 30)).toThrow('Narration must fit within 16 seconds');
  });

  it('keeps all scene boundaries ordered', () => {
    const t = buildTimeline(14, 30);
    expect(t.materialEnd).toBeLessThan(t.importEnd);
    expect(t.importEnd).toBeLessThan(t.recordingEnd);
    expect(t.recordingEnd).toBeLessThanOrEqual(t.totalFrames);
  });
});
```

- [ ] **Step 2: Run the timing test to verify it fails**

Run: `pnpm test src/lib/timing.test.ts`

Expected: FAIL because `buildTimeline` is not defined.

- [ ] **Step 3: Implement the narration-driven timeline**

```ts
export type Timeline = {
  materialEnd: number;
  importEnd: number;
  recordingEnd: number;
  totalFrames: number;
};

export const buildTimeline = (narrationDuration: number, fps: number): Timeline => {
  if (narrationDuration > 16) throw new Error('Narration must fit within 16 seconds');
  const duration = Math.max(13, narrationDuration);
  const totalFrames = Math.round(duration * fps);
  return {
    materialEnd: Math.round(duration * 0.2 * fps),
    importEnd: Math.round(duration * 0.36 * fps),
    recordingEnd: Math.round(duration * 0.78 * fps),
    totalFrames,
  };
};
```

- [ ] **Step 4: Write Python tests for the fixed voice manifest**

Test that `build_segments()` returns the exact fixed narration split below and only the two approved voices:

```py
EXPECTED = [
    ("在开始精讲之前，我们还是先用", "zh-CN-YunjianNeural"),
    ("whatsub", "en-US-AndrewNeural"),
    ("处理一下今天的视频。把链接粘贴进去，它会完成下载、本地转录和双语解析，也会帮我们找出这段内容里值得学习的地道表达。好了，现在进入今天的精听精讲。", "zh-CN-YunjianNeural"),
]
```

Mock `edge_tts.Communicate.save()` and assert that three segment files are requested, an ffmpeg concat manifest is written in order, and the output path is `public/generated/narration.mp3`.

- [ ] **Step 5: Implement Edge TTS generation**

Use `edge_tts.Communicate(text, voice, rate=rate).save(path)` for each segment. Invoke the bundled ffmpeg executable with a concat file and `-c:a libmp3lame -ar 48000 -ac 2`. Invoke bundled ffprobe to print the final duration as JSON. Fail with a clear command suggesting `python -m pip install edge-tts==7.2.8` when the module import fails.

- [ ] **Step 6: Run the TTS and timing tests**

Run: `python -m unittest scripts/test_tts.py && pnpm test src/lib/timing.test.ts`

Expected: all tests PASS without calling the Edge network service.

- [ ] **Step 7: Generate real narration and verify voices and duration**

Run: `python scripts/tts.py --output public/generated/narration.mp3`

Expected: JSON contains both voice IDs and a duration between 13 and 16 seconds. If it exceeds 16 seconds, increase only the cloud voice rate in small increments up to `+12%`; do not truncate words.

- [ ] **Step 8: Commit**

```powershell
git add tools/remotion-intro/scripts tools/remotion-intro/src/lib
git commit -m "feat: add Edge TTS intro narration"
```

---

### Task 3: Stage and validate episode media

**Files:**
- Create: `tools/remotion-intro/scripts/prepare.mjs`
- Test: `tools/remotion-intro/src/lib/config.test.ts`

**Interfaces:**
- Consumes: `episode.json`, narration generator, and bundled ffmpeg/ffprobe.
- Produces: `public/generated/cover.png`, `public/generated/recording.mp4`, `public/generated/narration.mp3`, and `public/generated/props.json` matching `StagedEpisodeProps`.

- [ ] **Step 1: Add failing tests for prepared-media constraints**

Add tests for `assertRecordingRange(config, duration)`:

```ts
it('rejects an end time beyond the recording duration', () => {
  expect(() => assertRecordingRange({...valid, recordingEnd: 40}, 31.8))
    .toThrow('recordingEnd 40 exceeds recording duration 31.8');
});
```

- [ ] **Step 2: Run tests to verify the new helper is missing**

Run: `pnpm test src/lib/config.test.ts`

Expected: FAIL because `assertRecordingRange` is not exported.

- [ ] **Step 3: Implement media staging**

`prepare.mjs` must:

1. Read and validate `episode.json`.
2. Assert cover and recording paths exist.
3. Probe recording duration with `src-tauri/binaries/ffprobe-x86_64-pc-windows-msvc.exe`.
4. Reject an out-of-range recording segment.
5. Copy the cover without cropping.
6. Transcode only the requested recording segment to H.264, 30 fps, yuv420p, preserving its full frame.
7. Run `scripts/tts.py`.
8. Write browser-safe relative paths and measured durations to `props.json`.

Use `spawnSync(command, args, {stdio: 'inherit'})`; never build an interpolated shell command from episode paths.

- [ ] **Step 4: Run preparation against the example config**

Run: `pnpm prepare`

Expected: four generated files exist and `props.json` contains `recordingDuration`, `narrationDuration`, and relative `/generated/...` sources.

- [ ] **Step 5: Verify staged recording dimensions and duration**

Run:

```powershell
& ..\..\src-tauri\binaries\ffprobe-x86_64-pc-windows-msvc.exe -v error -show_entries stream=width,height,r_frame_rate -show_entries format=duration -of json public\generated\recording.mp4
```

Expected: 30 fps, nonzero dimensions, and the configured selection divided by `recordingSpeed`.

- [ ] **Step 6: Commit**

```powershell
git add tools/remotion-intro/scripts/prepare.mjs tools/remotion-intro/src/lib tools/remotion-intro/public/generated/.gitkeep
git commit -m "feat: stage and validate intro media"
```

---

### Task 4: Build the Apple-style Remotion composition

**Files:**
- Create: `tools/remotion-intro/src/index.ts`
- Create: `tools/remotion-intro/src/Root.tsx`
- Create: `tools/remotion-intro/src/Intro.tsx`
- Create: `tools/remotion-intro/src/components/Backdrop.tsx`
- Create: `tools/remotion-intro/src/components/MaterialCard.tsx`
- Create: `tools/remotion-intro/src/components/MacBookFrame.tsx`
- Create: `tools/remotion-intro/src/components/RecordingScreen.tsx`
- Create: `tools/remotion-intro/src/components/FinalTransition.tsx`

**Interfaces:**
- Consumes: `StagedEpisodeProps` and `Timeline`.
- Produces: composition ID `ReusableIntro` with calculated duration and an embedded narration track.

- [ ] **Step 1: Register the composition with calculated metadata**

`Root.tsx` reads `public/generated/props.json` as default props. `calculateMetadata` calls `buildTimeline(props.narrationDuration, 30)` and returns 1080 × 1920, 30 fps, and the measured total frame count.

- [ ] **Step 2: Implement the shared skill-matched backdrop**

Use three absolutely positioned layers: solid `#08090d`, amber radial glow at 26%/18%, and blue radial glow at 80%/82%. Drive the glow scale with `interpolate(frame, [0, duration], [1, 1.05])`.

- [ ] **Step 3: Implement `MaterialCard` without cropping**

Render the cover inside a rounded glass card with `objectFit: 'contain'`. Animate card entrance with `spring({frame, fps, config: {damping: 18, stiffness: 110}})`. Animate the URL scanner using frame-based `interpolate`; no CSS transitions or keyframes.

- [ ] **Step 4: Implement the MacBook shell and fly-in**

Build the shell from CSS geometry: dark aluminum lid, 16:10 screen, 14 px bezel, camera notch, lower base, hinge, and a soft reflected floor shadow. Expose a `screenContent` prop so the import animation and recording share the exact same clipping mask.

The cover’s flight path uses a quadratic Bézier helper:

```ts
const bezier = (p: number, a: number, b: number, c: number) =>
  (1 - p) ** 2 * a + 2 * (1 - p) * p * b + p ** 2 * c;
```

Scale the cover from 1 to 0.18 and move it into the MacBook input region while the URL retypes inside the whatsub field.

- [ ] **Step 5: Implement `RecordingScreen` with full-frame containment**

Render two synchronized `<Video>` layers:

- background: absolute fill, `objectFit: 'cover'`, scale 1.08, blur 28 px, opacity 0.45;
- foreground: absolute fill, `objectFit: 'contain'`.

Both layers use the prepared clip, `startFrom={0}`, and the configured playback rate is already baked during preparation. Mask both layers inside the MacBook screen only.

- [ ] **Step 6: Implement the final push-in transition**

Animate the MacBook screen rectangle to fill 1080 × 1920 between the last 75 frames. Add “现在，进入今天的精听精讲” using the skill’s gold gradient and add a 6-frame amber-white flash at the final handoff. Avoid a pure white final frame; end on `#08090d` so it matches the listening-card background.

- [ ] **Step 7: Add the narration audio and organize scenes**

`Intro.tsx` renders `<Audio src={staticFile('generated/narration.mp3')} />` once and uses `Sequence` boundaries from `Timeline`. Overlap visual scenes by 8–12 frames so motion remains continuous while narration stays uninterrupted.

- [ ] **Step 8: Run typecheck and unit tests**

Run: `pnpm exec tsc --noEmit && pnpm test`

Expected: PASS with no diagnostics.

- [ ] **Step 9: Render four visual test stills**

Run:

```powershell
pnpm exec remotion still src/index.ts ReusableIntro out/material.png --frame=45
pnpm exec remotion still src/index.ts ReusableIntro out/import.png --frame=110
pnpm exec remotion still src/index.ts ReusableIntro out/recording.png --frame=240
pnpm exec remotion still src/index.ts ReusableIntro out/handoff.png --frame=390
```

Expected: cover is complete, URL is legible, recording UI is fully visible, and final frame matches the dark explainer template.

- [ ] **Step 10: Commit**

```powershell
git add tools/remotion-intro/src tools/remotion-intro/remotion.config.ts
git commit -m "feat: animate reusable whatsub intro"
```

---

### Task 5: Render, verify, and document the reusable workflow

**Files:**
- Create: `tools/remotion-intro/scripts/render.mjs`
- Create: `tools/remotion-intro/README.md`
- Modify: `tools/remotion-intro/package.json`
- Create: `tools/remotion-intro/.gitignore`

**Interfaces:**
- Consumes: prepared props and composition `ReusableIntro`.
- Produces: `out/whatsub-intro.mp4` and `C:/Users/Jimmy Spector/Desktop/whatsub-promo/H_Remotion固定片头.mp4`.

- [ ] **Step 1: Implement a fail-fast render wrapper**

`render.mjs` must call preparation, execute:

```text
pnpm exec remotion render src/index.ts ReusableIntro out/whatsub-intro.mp4 --codec=h264 --pixel-format=yuv420p --crf=18
```

Then probe the result and reject it unless width is 1080, height is 1920, frame rate is 30, duration is 13–16 seconds, and both video and audio streams exist. Copy only a verified result to the desktop destination.

- [ ] **Step 2: Add generated artifacts to `.gitignore`**

```gitignore
node_modules/
out/
public/generated/*
!public/generated/.gitkeep
```

- [ ] **Step 3: Document the three-edit per-episode workflow**

README must say:

1. Replace `coverImage`, `videoUrl`, and `screenRecording` in `episode.json`.
2. Adjust only `recordingStart`, `recordingEnd`, and `recordingSpeed` when needed.
3. Run `pnpm render`.
4. Find the verified result at `C:/Users/Jimmy Spector/Desktop/whatsub-promo/H_Remotion固定片头.mp4`.

Include commands for `pnpm studio`, Edge TTS installation, missing-file errors, recording-range errors, and regenerating narration.

- [ ] **Step 4: Run the complete test suite and full render**

Run: `pnpm test && python -m unittest scripts/test_tts.py && pnpm render`

Expected: all tests PASS and render wrapper prints verified stream metadata.

- [ ] **Step 5: Visually inspect the four stills and full MP4**

Check:

- no cover or UI cropping;
- no black frame during scene changes;
- MacBook bezel does not cover interactive UI;
- URL remains readable for at least 30 frames;
- recording remains full-frame with blurred side fill;
- handoff ends on the skill-matched dark background;
- 云健 and Andrew are both audible and neither line is truncated.

- [ ] **Step 6: Confirm unrelated worktree state was preserved**

Run: `git status --short`

Expected: only intended Remotion files are staged or modified; `../.agents/skills/` and `../AGENTS.md` remain untracked and untouched.

- [ ] **Step 7: Commit**

```powershell
git add tools/remotion-intro
git commit -m "docs: add reusable intro render workflow"
```

---

## Self-Review

- Spec coverage: all four scenes, MacBook shell, full-frame recording, skill-matched background, parameterized episode media, Edge TTS voices, duration derivation, output verification, and desktop delivery have explicit tasks.
- Placeholder scan: no TBD/TODO steps or unspecified error handling remain.
- Type consistency: `RawEpisodeConfig`, `StagedEpisodeProps`, `VoiceSegment`, `Timeline`, `validateEpisodeConfig()`, and `buildTimeline()` use the same names across all tasks.
- Scope: this is one independently testable template; integration into the existing GUI generator is intentionally excluded.
