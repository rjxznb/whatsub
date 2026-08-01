import { describe, expect, it } from "vitest";
import { captionExportGeometry } from "./Player";

describe("Player caption export geometry", () => {
  it("uses the session offset and current video viewport", () => {
    const video = { clientWidth: 1280, clientHeight: 720 } as HTMLVideoElement;

    expect(captionExportGeometry({ x: 128, y: -144 }, video)).toEqual({
      captionOffset: { x: 128, y: -144 },
      captionViewport: { width: 1280, height: 720 },
    });
  });

  it("falls back to a zero viewport before the video element is available", () => {
    expect(captionExportGeometry({ x: 10, y: 20 }, null)).toEqual({
      captionOffset: { x: 10, y: 20 },
      captionViewport: { width: 0, height: 0 },
    });
  });
});
