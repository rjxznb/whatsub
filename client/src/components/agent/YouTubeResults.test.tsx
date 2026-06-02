import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../store/appDialog", () => ({ notify: vi.fn() }));

import { YouTubeResults } from "./YouTubeResults";
import type { YouTubeSearchHit } from "../../agent/tools/youtube_search";

const hit = (over: Partial<YouTubeSearchHit> = {}): YouTubeSearchHit => ({
  id: "abc123",
  title: "NHS GP appointment basics",
  channel: "WhatsubDemo",
  durationSec: 543,
  viewCount: 12000,
  url: "https://www.youtube.com/watch?v=abc123",
  ...over,
});

describe("YouTubeResults", () => {
  it("renders a thumbnail from the video id + meta", () => {
    render(<YouTubeResults hits={[hit()]} />);
    const img = screen.getByAltText("NHS GP appointment basics") as HTMLImageElement;
    expect(img.src).toContain("i.ytimg.com/vi/abc123/mqdefault.jpg");
    expect(screen.getByText("9:03")).toBeTruthy(); // 543s
    expect(screen.getByText(/WhatsubDemo/)).toBeTruthy();
    expect(screen.getByText(/1\.2万次播放/)).toBeTruthy();
  });

  it("clicking the thumbnail swaps in the inline player", () => {
    const { container } = render(<YouTubeResults hits={[hit()]} />);
    expect(container.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByTitle("点击预览播放"));
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.src).toContain("youtube-nocookie.com/embed/abc123");
  });

  it("empty hits shows a friendly note", () => {
    render(<YouTubeResults hits={[]} />);
    expect(screen.getByText("没有搜到匹配的视频。")).toBeTruthy();
  });
});
