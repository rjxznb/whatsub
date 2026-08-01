# Burned Subtitle Position Parity

## Goal

When a user drags the bilingual subtitle overlay in the video player and then exports a video with burned subtitles during the same Player session, the exported subtitles must use the same relative displacement from the existing default subtitle position.

The position remains session-only. Reopening the Player resets it to the existing default, exactly as it does today.

## Current Problem

`Player` stores the drag result as temporary CSS pixel offsets. `ExportVideoModal` does not receive those offsets, and `subtitlesToAss` always emits fixed bottom-center ASS styles. Therefore export ignores the user's drag.

## Design

`Player` remains the owner of the temporary `{ x, y }` pixel offset. When it renders `ExportVideoModal`, it also supplies the current player viewport width and height. The modal converts the pixel offsets into normalized displacement ratios:

- `offsetRatioX = offsetX / viewportWidth`
- `offsetRatioY = offsetY / viewportHeight`

Invalid or zero viewport dimensions fall back to zero displacement.

`subtitlesToAss` accepts the normalized displacement. It converts the ratios into ASS PlayRes units and applies the same displacement to the existing English and Chinese anchor positions. This preserves the existing vertical spacing between the two languages while making both move as one subtitle block.

The default export path is unchanged: when both ratios are zero, no explicit ASS position override is emitted and the existing style margins remain authoritative.

## Coordinate Semantics

The feature reproduces the subtitle's relative displacement within the current player viewport, not raw desktop pixels. This makes the result stable across 720p, 1080p, and 4K output.

The implementation does not persist coordinates, change drag behavior, or alter subtitle typography, colors, highlighting, or ffmpeg arguments.

## Error Handling

- A missing player element, zero-sized viewport, non-finite offset, or non-finite ratio falls back to the current default export position.
- Export without burned subtitles remains a stream copy and does not use position data.
- Position conversion stays in the frontend; the Rust export command continues receiving complete ASS content.

## Tests

- ASS output with zero displacement remains unchanged and contains no explicit position override.
- Horizontal and vertical normalized displacement scale into the selected PlayRes.
- English and Chinese receive the same displacement while preserving their original vertical separation.
- Invalid viewport dimensions fall back to zero displacement.
- The Player-to-export handoff supplies the current session offset and viewport dimensions.

## Out of Scope

- Persisting subtitle position between Player sessions or per video.
- Constraining drag movement to the visible video frame.
- Making the DOM overlay and ASS typography pixel-identical.
- Synchronizing the position into Picture-in-Picture captions.
