import { describe, it, expect } from "vitest";
import { extractYouTubeId } from "./syncSourceUrl";

describe("extractYouTubeId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=10", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/abc123XYZ_-", "abc123XYZ_-"],
  ])("extracts %s -> %s", (url, expected) => {
    expect(extractYouTubeId(url)).toBe(expected);
  });

  it.each([
    "https://www.bilibili.com/video/BV1xx411c7mu",
    "https://example.com/some-video",
    "https://www.youtube.com/playlist?list=PL123",
    "not a url",
    "",
  ])("returns null for non-YouTube URL: %s", (url) => {
    expect(extractYouTubeId(url)).toBeNull();
  });
});
